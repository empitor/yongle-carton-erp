import type { DatabaseSync } from 'node:sqlite';
import { count } from './sqlite/sql.js';

/** 用 AUTOINCREMENT、单号要从真正分到的编号生成的表 */
export type AutoIdTable = 'orders' | 'purchases' | 'flow_documents' | 'purchase_returns';

/**
 * 这张表下一条记录会分到的编号：和 SQLite 自己分配的一样，是用过的最大编号加一，删掉的也算。
 * 只能在写事务里用，并且紧接着用这个编号显式插入（同一连接、同步执行，中间不会被别的写入插队）。
 * 同时看 sqlite_sequence 和表里的最大编号：表还没插过行时 sqlite_sequence 没有这一行。
 */
export function nextAutoId(db: DatabaseSync, table: AutoIdTable): number {
  // 用过的最大编号（没用过是 0）：和数行数一样是一个非负整数，用 count 读
  const used = count(
    db,
    `SELECT MAX(n) AS n FROM (SELECT COALESCE(MAX(seq),0) AS n FROM sqlite_sequence WHERE name=? UNION ALL SELECT COALESCE(MAX(rowid),0) FROM "${table}")`,
    table,
  );
  return used + 1;
}
