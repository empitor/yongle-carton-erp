// 卡片出了以后相关数据变了（previews.ts 确认时数据核对对不上）：说清是哪几条记录变了，告诉人和助手这张卡片已过期、要办就按最新数据重新出一张。
import { isRecord } from './chat/result-fields.js';
// 数据核对本身不放宽：真变了就拦。

/** 卡片作废时写进卡片、交给助手的那句话的结尾 */
export const STALE_TAIL = '这张卡片已过期，没有执行；要办的话按最新数据重新出一张。';
/** 最多列出几条变了的记录 */
const MAX_LISTED = 5;

type Row = Record<string, unknown>;
/** 一列都带编号的记录（按编号比） */
const isIdList = (v: unknown): v is Row[] => Array.isArray(v) && v.every((x: unknown) => isRecord(x) && x.id != null);
/** 记录的叫法：单号、名称、编号；不是记录的（数组、文字）没有这些，叫“一条记录” */
const nameOf = (r: unknown) => {
  const row: Row = isRecord(r) ? r : {};
  return String(row.number || row.name || (row.id != null ? '编号 ' + String(row.id) : '一条记录'));
};

/** 出卡片时记下的数据（stamp）和现在的比：按编号找出新加、删掉、改了的记录，最多列 5 条 */
export function staleRecords(before: unknown, after: unknown): string[] {
  const names = new Set<string>();
  const walk = (b: unknown, a: unknown) => {
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    if (isIdList(b) && isIdList(a)) {
      const old = new Map<string, Row>(b.map((x) => [String(x.id), x])),
        now = new Map<string, Row>(a.map((x) => [String(x.id), x]));
      // 两边按编号合在一起：先旧的编号、再新加的编号；同一编号取现在的样子，删掉的取原来的
      for (const [id, row] of new Map([...old, ...now]))
        if (JSON.stringify(old.get(id)) !== JSON.stringify(now.get(id))) names.add(nameOf(row));
      return;
    }
    if (isRecord(b) && isRecord(a) && b.id == null && a.id == null) {
      for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) walk(b[key], a[key]);
      return;
    }
    if (isRecord(a) || isRecord(b)) names.add(nameOf(a ?? b));
  };
  walk(before, after);
  return [...names].slice(0, MAX_LISTED);
}

export function staleMessage(before: unknown, after: unknown) {
  const names = staleRecords(before, after);
  return '出卡片之后' + (names.length ? names.join('、') + ' 变了' : '相关记录变了') + '，' + STALE_TAIL;
}
