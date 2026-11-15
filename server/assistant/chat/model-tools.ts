// 把注册表里这个账号能用的工具，转成 DeepSeek 工具调用要的 tools 参数（按目录自动生成，不手写清单）：
// - 名字：接口只认字母、数字、下划线、连字符，我们的名字带点号，点号换成两个下划线，反查唯一；
// - 参数结构：zod 生成的 JSON Schema 去掉只给程序看的噪音（$schema、额外属性、超长正则、安全整数上下限），
//   必填、枚举、类型都留着；数量、日期的正则在几十个工具里重复出现，数量换成一句短说明、日期换成 format: date；
//   真正的校验照旧由注册表按 zod 结构做。
import { z } from 'zod';
import { dateSchema, quantityText } from '../../../shared/core/index.js';
import { isRecord } from './result-fields.js';

export type ModelTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const MODEL_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
/** 注册表名字 → 发给模型的名字：records.search → records__search */
export const modelToolName = (name: string) => name.split('.').join('__');

const patternOf = (schema: z.ZodType) => (z.toJSONSchema(schema) as { pattern?: string }).pattern;
/** 数量、日期字段的正则（shared/core 里定义的那两个），给模型看时换成更短的写法 */
const QUANTITY_PATTERN = patternOf(quantityText);
const DATE_PATTERN = patternOf(dateSchema);
const QUANTITY_HINT = '数量，十进制数字写成字符串';

const SAFE = Number.MAX_SAFE_INTEGER;
/** 没有 format 的正则超过这么多字就不给模型看 */
const LONG_PATTERN_CHARS = 60;
const LENGTH_LIMITS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems']);
/** 值是“名字 → 子结构”表的关键字（里面的键是字段名，不是关键字，不能按关键字过滤） */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties']);
/** 值是一个子结构的关键字 */
const SCHEMA_ONE = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames']);
/** 值是一组子结构的关键字 */
const SCHEMA_LIST = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

/** 不给模型看的键：只给程序的噪音、和 format 重复或太长的正则、安全整数上下限、防呆的长度条数上限 */
function dropped(s: Record<string, unknown>, key: string, value: unknown) {
  if (key === '$schema' || key === 'propertyNames') return true;
  // 额外属性：false 只是给程序的严格校验，{} 等于不限，都不用告诉模型
  if (key === 'additionalProperties' && (value === false || (isRecord(value) && !Object.keys(value).length))) return true;
  // 有 format（比如 uuid）时正则重复；没有 format 的超长正则对模型没用
  if (key === 'pattern' && (s.format || String(value).length > LONG_PATTERN_CHARS || value === QUANTITY_PATTERN || value === DATE_PATTERN))
    return true;
  if ((key === 'maximum' && value === SAFE) || (key === 'minimum' && value === -SAFE)) return true;
  // 长度、条数上限和“大于 0”只是防呆，超了服务器会报出原因，模型照原因改就行
  return LENGTH_LIMITS.has(key) || (key === 'exclusiveMinimum' && value === 0);
}
/** 一个键的值：子结构接着修剪，别的原样 */
function trimmedValue(key: string, value: unknown) {
  if (SCHEMA_MAPS.has(key) && isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, trimNode(child)]));
  if (SCHEMA_ONE.has(key)) return trimNode(value);
  if (SCHEMA_LIST.has(key) && Array.isArray(value)) return value.map(trimNode);
  return value;
}
function trimNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) if (!dropped(node, key, value)) out[key] = trimmedValue(key, value);
  if (node.pattern === QUANTITY_PATTERN && !out.description) out.description = QUANTITY_HINT;
  if (node.pattern === DATE_PATTERN) out.format = 'date';
  return out;
}

/** 给模型看的参数结构。最外层必须是 object：只有 anyOf/oneOf 的（几种写法任选一种）补上 type: object。 */
export function trimSchema(schema: unknown): Record<string, unknown> {
  const out = trimNode(schema);
  if (!isRecord(out)) return { type: 'object', properties: {} };
  return out.type ? out : { type: 'object', ...out };
}

/**
 * 这一轮发给模型的 tools：账号能用的注册表工具（顺序和注册表一致，一次聊天内不变，方便命中前缀缓存）。
 * 返回反查表：发给模型的名字 → 注册表名字。
 */
export function buildModelTools(
  exposed: readonly { name: string; description: string; parameters: unknown }[],
) {
  const registryName = new Map<string, string>();
  const tools: ModelTool[] = [];
  for (const t of exposed) {
    const name = modelToolName(t.name);
    if (!MODEL_TOOL_NAME.test(name)) throw new Error('工具名不合 DeepSeek 的命名规则：' + t.name);
    if (registryName.has(name)) throw new Error('工具名换成发给模型的名字后重名：' + t.name);
    registryName.set(name, t.name);
    tools.push({ type: 'function', function: { name, description: t.description, parameters: trimSchema(t.parameters) } });
  }
  // 说明里互相提到的工具名也换成发给模型的名字，模型照着写不会写错
  for (const t of tools) t.function.description = modelToolText(t.function.description, registryName);
  return { tools, registryName };
}

/** 文字里出现的注册表工具名（records.get）换成发给模型的名字（records__get）；长的先换，免得短名字截断长名字。 */
export function modelToolText(text: string, registryName: ReadonlyMap<string, string>) {
  const pairs = [...registryName].sort((a, b) => b[1].length - a[1].length);
  return pairs.reduce((out, [sent, name]) => out.split(name).join(sent), text);
}
