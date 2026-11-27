import { z } from 'zod';
import { many, type Store } from '../core/index.js';
import { historyRefIds, type HistoryRefs } from '../../shared/business/index.js';

/** 每张表取名称（单据取单号）；库存品另带单位，出入库那几条写“300 张 → 310 张”要用 */
const sources: readonly (readonly [keyof HistoryRefs, string])[] = [
  ['customers', 'SELECT id,name AS label,NULL AS unit FROM customers'],
  ['customer_sites', 'SELECT id,name AS label,NULL AS unit FROM customer_sites'],
  ['suppliers', 'SELECT id,name AS label,NULL AS unit FROM suppliers'],
  ['products', 'SELECT id,name AS label,NULL AS unit FROM products'],
  ['stock_items', 'SELECT id,name AS label,unit FROM stock_items'],
  ['orders', 'SELECT id,number AS label,NULL AS unit FROM orders'],
  ['flow', 'SELECT id,number AS label,NULL AS unit FROM flow_documents'],
];
const refRow = z.object({ id: z.number(), label: z.string(), unit: z.string().nullable() });

/**
 * 修改历史里引用到的客户、产品、订单、单据……换成名称或单号：按表一次查齐（不逐条查），归档的也算。
 * 查不到的（永久删除了）不给，界面写“已删除的记录”，不露编号。
 * self：这条记录自己（库存品的出入库要用它的单位）。
 */
export function historyRefs(store: Store, details: unknown[], self?: { module: string; id: number }): HistoryRefs {
  const ids = historyRefIds(details);
  if (self?.module === 'stock_items' && !ids.stock_items.includes(self.id)) ids.stock_items.push(self.id);
  const refs: HistoryRefs = {};
  for (const [table, sql] of sources) {
    if (!ids[table].length) continue;
    refs[table] = Object.fromEntries(
      many(store.db, refRow, sql + ' WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids[table])).map((r) => [
        String(r.id),
        r.unit === null ? { name: r.label } : { name: r.label, unit: r.unit },
      ]),
    );
  }
  return refs;
}
