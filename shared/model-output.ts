/**
 * 模型返回的 JSON 经常有无伤大雅的出入：多一个字段、数字没加引号、把请求参数回显进结果。
 * 校验本身保持严格（防越权字段），在校验之前先清理这些出入，不能因为一个无关字段丢掉整份识别结果。
 * 这里只丢弃和整理形状，不生成业务内容。
 */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 部分模型会把请求里的 response_format 回显到结果顶层，比如 type: "json_object"。 */
export function dropFormatEcho<T>(raw: T): T {
  if (!isPlainObject(raw)) return raw;
  const type = raw.type;
  if (type !== 'json_object' && type !== 'json_schema' && type !== 'object') return raw;
  const { type: _ignored, ...rest } = raw;
  return rest as T;
}

export function pickKeys(raw: Record<string, unknown>, keys: readonly string[]) {
  const picked: Record<string, unknown> = {};
  for (const key of keys) if (key in raw) picked[key] = raw[key];
  return picked;
}

/** 数字和布尔转成文字，其他类型原样交给校验去判断。 */
export const scalarText = (v: unknown) =>
  typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;

export function textList(raw: unknown, maxItems: number, maxChars: number) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v : isPlainObject(v) || Array.isArray(v) ? JSON.stringify(v) : String(v ?? '')))
    .filter((v) => v.trim())
    .slice(0, maxItems)
    .map((v) => v.slice(0, maxChars));
}
