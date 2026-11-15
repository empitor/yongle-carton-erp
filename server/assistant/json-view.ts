// 交给页面的不定形部分（命令的执行结果、卡片上改之前改之后、工具参数的写法和结构）：
// 按接口回答时同样的规则转成 JSON（undefined 的字段去掉、日期写成文字），再校验确实是 JSON，类型就是 JsonView。
import { jsonValue, planCardSchema } from '../../shared/assistant/index.js';

/** 和 res.json 序列化同一个结果；本来是 undefined 的当 null */
export function asJson(value: unknown) {
  const text = JSON.stringify(value ?? null);
  return jsonValue.parse(JSON.parse(text));
}

/** 确认卡片（previews.ts 的 planView）给页面、存进消息的样子 */
export const planCard = (view: unknown) => planCardSchema.parse(asJson(view));
