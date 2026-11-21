import { z } from 'zod';
import type { Store } from '../../core/index.js';
import { many, one, rows } from '../../core/index.js';
import type { stockKinds } from '../../../shared/business/index.js';

/*
 * 采购库存的轻量只读：按编号或条件只取几列（版本号、余额、编号、名称），不组装视图。
 * 给上层核对“数据变没变”（助手确认卡片的数据版本）、挑出要读的记录、体检用；要完整的样子读服务和单据流转的 views。
 */

type StockKind = (typeof stockKinds)[number];
const version = { id: z.number(), version: z.number(), archived: z.number() };
const namedVersion = z.object({ ...version, name: z.string() });
const numberedVersion = z.object({ ...version, number: z.string() });
const stockVersion = namedVersion.extend({ balance: z.number() });
/** 归档了没有（record_lifecycle 里记着）：1 是归档了；entity 是 SQL 里的记录种类 */
const archivedColumn = (entity: string) =>
  `EXISTS(SELECT 1 FROM record_lifecycle a WHERE a.entity=${entity} AND a.record_id=t.id) AS archived`;

/** 客户、供应商、产品的版本号（含归档的，带归档标记和名称），按编号排 */
export const namedVersions = (store: Store, table: 'customers' | 'suppliers' | 'products') =>
  many(store.db, namedVersion, `SELECT t.id,t.version,t.name,${archivedColumn('?')} FROM ${table} t ORDER BY t.id`, table);
/** 订单、采购单的版本号（含归档的，带归档标记和单号），按编号排 */
export const numberedVersions = (store: Store, table: 'orders' | 'purchases') =>
  many(store.db, numberedVersion, `SELECT t.id,t.version,t.number,${archivedColumn('?')} FROM ${table} t ORDER BY t.id`, table);
/** 库存品的版本号和库存余额（流水的合计，千分之一的单位）；不给种类就是全部 */
export const stockVersions = (store: Store, kind?: StockKind) =>
  many(
    store.db,
    stockVersion,
    `SELECT t.id,t.version,t.name,${archivedColumn("'stock_items'")},COALESCE((SELECT SUM(m.delta_units) FROM stock_movements m WHERE m.item_id=t.id),0) AS balance FROM stock_items t` +
      (kind ? ' WHERE t.kind=?' : '') +
      ' ORDER BY t.id',
    ...(kind ? [kind] : []),
  );

/** 按编号批量取（json_each 收一串编号） */
const IN_IDS = ' IN (SELECT value FROM json_each(?))';
/** 订了这几种产品的订单编号 */
export function orderIdsOfProducts(store: Store, productIds: readonly number[]) {
  if (!productIds.length) return [];
  const sql = 'SELECT DISTINCT order_id FROM order_lines WHERE product_id' + IN_IDS;
  return many(store.db, rows.order_lines.pick({ order_id: true }), sql, JSON.stringify(productIds)).map((r) => r.order_id);
}
/** 这几种产品的成品库存品编号 */
export function finishedIdsOfProducts(store: Store, productIds: readonly number[]) {
  if (!productIds.length) return [];
  const sql = "SELECT id FROM stock_items WHERE kind='finished' AND product_id" + IN_IDS;
  return many(store.db, rows.stock_items.pick({ id: true }), sql, JSON.stringify(productIds)).map((r) => r.id);
}
/** 采购明细所在采购单的供应商：明细编号 → 供应商编号 */
export function suppliersOfPurchaseLines(store: Store, lineIds: readonly number[]) {
  if (!lineIds.length) return new Map<number, number>();
  const found = many(
    store.db,
    z.object({ id: z.number(), supplierId: z.number() }),
    'SELECT l.id,p.supplier_id AS supplierId FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE l.id' + IN_IDS,
    JSON.stringify(lineIds),
  );
  return new Map(found.map((r) => [r.id, r.supplierId]));
}
/** 订货单的单号：订货单编号 → 单号 */
export function batchNumbers(store: Store, ids: readonly number[]) {
  if (!ids.length) return new Map<number, string>();
  const sql = 'SELECT id,number FROM order_batches WHERE id' + IN_IDS;
  return new Map(many(store.db, rows.order_batches.pick({ id: true, number: true }), sql, JSON.stringify(ids)).map((b) => [b.id, b.number]));
}
/**
 * 一笔流水落在哪个库存品、哪一天：按它筛流水列表（同一库存品同一天的几笔）就能找到这一笔，
 * 不用读全部流水。没有这笔流水是 undefined。
 */
export function movementScope(store: Store, id: string) {
  const row = one(store.db, rows.stock_movements.pick({ item_id: true, date: true }), 'SELECT item_id,date FROM stock_movements WHERE id=?', id);
  return row && { itemId: row.item_id, start: row.date, end: row.date };
}
/** 库存为负的库存品（体检用）：名称、单位、余额（千分之一的单位），最多 limit 个 */
export function negativeStock(store: Store, limit: number) {
  return many(
    store.db,
    rows.stock_items.pick({ name: true, unit: true }).extend({ units: z.number() }),
    'SELECT i.name,i.unit,SUM(m.delta_units) AS units FROM stock_movements m JOIN stock_items i ON i.id=m.item_id GROUP BY m.item_id HAVING SUM(m.delta_units)<0 LIMIT ?',
    limit,
  );
}
