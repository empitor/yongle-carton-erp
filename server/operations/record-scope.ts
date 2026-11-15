/*
 * 采购库存按编号圈记录的写法：不给编号是全部，给一个编号是这一条，给一组编号按 JSON 数组绑定。
 * 读供应商、采购单、库存品、在途数量都用这一份（repository.ts、purchase-rows.ts）。
 */

/** 要读哪些记录：不给是全部，一个编号或一组编号 */
export type RecordIds = number | readonly number[] | undefined;

/** 给的是空的一组编号：什么都不用读 */
export const noRecords = (ids: RecordIds) => Array.isArray(ids) && !ids.length;

/** 按编号圈记录的 SQL 条件（接在列名后面）和参数；不给编号时条件是空的 */
export function recordScope(ids: RecordIds): { predicate: string; params: (number | string)[] } {
  if (ids === undefined) return { predicate: '', params: [] };
  return typeof ids === 'number'
    ? { predicate: '= ?', params: [ids] }
    : { predicate: 'IN (SELECT value FROM json_each(?))', params: [JSON.stringify(ids)] };
}
