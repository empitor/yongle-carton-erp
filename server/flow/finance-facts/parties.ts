/**
 * 窗口的往来单位一组：客户、供应商的名称和选单位的名单。财务写往来、发票、票据、保证金、收付款、对账单时取单位名，
 * 选客户、供应商的下拉也读这里（GET /api/finance/parties）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { archivedIdsIn, many } from '../../core/index.js';

/** 往来单位的种类：客户、供应商 */
type PartyKind = 'customer' | 'supplier';

/** i 是编号在传入数组里的位置：按位置对回调用方给的编号，编号是文字还是数字都照原样 */
const found = z.object({ i: z.number(), name: z.string() });
/** 客户表、供应商表的 id 是整数列，和 json_each 取出的值比较时按数字比（和 id=? 同一个口径） */
const namesSql: Record<PartyKind, string> = {
  customer: 'SELECT j.key AS i,p.name FROM json_each(?) j JOIN customers p ON p.id=j.value',
  supplier: 'SELECT j.key AS i,p.name FROM json_each(?) j JOIN suppliers p ON p.id=j.value',
};

/** 一批往来单位的名称，一次查完：编号 → 名称，找不到的不在结果里（归档的照样有名称） */
function names<K extends number | string>(db: DatabaseSync, kind: PartyKind, ids: readonly K[]): Map<K, string> {
  const out = new Map<K, string>();
  for (const row of many(db, found, namesSql[kind], JSON.stringify(ids))) {
    const id = ids[row.i];
    if (id !== undefined) out.set(id, row.name);
  }
  return out;
}

const option = z.object({ id: z.number(), name: z.string() });
/** 没归档的（参数是归档编号的 JSON 数组） */
const unarchived = 'p.id NOT IN (SELECT value FROM json_each(?))';
/** 归档编号（归档标记的种类就是表名），给 unarchived 用 */
const archivedJson = (db: DatabaseSync, entity: 'customers' | 'suppliers') => JSON.stringify([...archivedIdsIn(db, entity)]);
/** 选单位用的名单：没归档的客户或供应商（编号、名称），和业务列表一样新建的在前 */
function options(db: DatabaseSync, kind: PartyKind) {
  return kind === 'customer'
    ? many(db, option, `SELECT p.id,p.name FROM customers p WHERE ${unarchived} ORDER BY p.id DESC`, archivedJson(db, 'customers'))
    : many(db, option, `SELECT p.id,p.name FROM suppliers p WHERE ${unarchived} ORDER BY p.id DESC`, archivedJson(db, 'suppliers'));
}

export const parties = { names, options };
