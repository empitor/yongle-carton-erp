// 一个工具结果进对话前截到上限（SESSION.toolResultTokens），免得一次查询吃掉整个上下文。
// 先截最长的列表，截断处留一条说明：给了几条、共几条、怎么翻页再看；没有列表或截了还超，就截文字并说明。
// 截过的样子既发给模型也存进会话历史，前后一致，前缀缓存不受影响。
import { CJK_TOKENS_PER_CHAR, SESSION, estimateTokens } from './session-limits.js';
import { isRecord } from '../../../shared/core/index.js';
import { field, isList } from './result-fields.js';

/** 截文字时每次缩到上一次的几成，直到放得下 */
const TEXT_SHRINK = 0.9;

/** 结果里的一个列表：replace 把它在原处换成截过的那份 */
type Slot = { replace: (list: unknown[]) => void; list: unknown[]; size: number };

function lists(value: unknown, out: Slot[] = []) {
  if (isList(value)) value.forEach((v, i) => visit((list) => { value[i] = list; }, v, out));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) visit((list) => { value[k] = list; }, v, out);
  return out;
}
function visit(replace: Slot['replace'], v: unknown, out: Slot[]) {
  if (isList(v) && v.length > 1) out.push({ replace, list: v, size: JSON.stringify(v).length });
  lists(v, out);
}

/** 翻页说明：工具有 offset 或 page 参数的点名，没有的让模型缩小条件。 */
export function pageHint(parameters: unknown) {
  const props = field(parameters, 'properties');
  const param = isRecord(props) ? ['offset', 'page', 'cursor'].find((p) => p in props) : undefined;
  return param ? `要看后面的，用这个工具的 ${param} 参数翻页再查，或者缩小条件。` : '要看别的部分，缩小条件或分开查。';
}

export function capToolResult(value: unknown, hint: string, limit = SESSION.toolResultTokens): unknown {
  const fits = (v: unknown) => estimateTokens(JSON.stringify(v) ?? '') <= limit;
  if (fits(value)) return value;
  const copy = structuredClone(value);
  for (const slot of lists(copy).sort((a, b) => b.size - a.size)) {
    const full = slot.list;
    const cut = (n: number) =>
      slot.replace([
        ...full.slice(0, n),
        `（列表太长，只给出前 ${n} 条，共 ${full.length} 条，还有 ${full.length - n} 条没给出。${hint}）`,
      ]);
    let lo = 0,
      hi = full.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      cut(mid);
      if (fits(copy)) lo = mid;
      else hi = mid - 1;
    }
    cut(lo);
    if (fits(copy)) return copy;
  }
  // 没有列表可截或截了还超：留前面一段文字
  const text = JSON.stringify(copy) ?? '';
  const note = `结果太长，只给出前面一部分（共 ${text.length} 字）。${hint}`;
  let n = Math.floor(limit / CJK_TOKENS_PER_CHAR);
  while (n > 0 && !fits({ 截断的结果: text.slice(0, n), 说明: note })) n = Math.floor(n * TEXT_SHRINK);
  return { 截断的结果: text.slice(0, n), 说明: note };
}
