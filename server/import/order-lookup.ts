import { sales } from '../sales/index.js';
import { z } from 'zod';
import { many, rows, type Store } from '../core/index.js';
import type { Order } from '../../shared/core/index.js';
import type { CustomerProductSpecs } from '../../shared/import/index.js';
import { looseKey, nameKey } from '../../shared/core/index.js';

/**
 * 导入查重和对应要从业务库里找的几样东西：按条件查出编号，再按编号批量读，不把全部订单、客户读出来再找。
 * 比较用的键在库里也算一遍（注册成 SQL 函数，和这里的 JS 写法是同一个函数），所以查出来的范围和原来逐条比的一样。
 */

/** 订单指纹、采购单号查重的比较键（shared/core/name-keys.ts 的 looseKey，口径不变） */
export const compareKey = looseKey;

const registered = new WeakSet<object>();
function withKeys(store: Store) {
  if (!registered.has(store.db)) {
    const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
    store.db.function('import_compare_key', { deterministic: true }, (v) => {
      const s = text(v);
      return s === null ? null : compareKey(s);
    });
    store.db.function('import_name_key', { deterministic: true }, (v) => {
      const s = text(v);
      return s === null ? null : nameKey(s);
    });
    registered.add(store.db);
  }
  return store.db;
}
const idRow = z.object({ id: z.number() });
/** 按条件查出订单编号（SQL 只选 id 这一列） */
const orderIds = (store: Store, sql: string, ...params: (string | number | null)[]) =>
  many(withKeys(store), idRow, sql, ...params).map((r) => r.id);

/** 订单查重比的是哪位客户：已有档案按编号，新建的按名字的比较键 */
export type CustomerRef = { mode: 'existing'; id: number } | { mode: 'new'; name: string };
const customerClause = (c: CustomerRef) =>
  c.mode === 'existing'
    ? { sql: 'customer_id=?', param: c.id as number | string }
    : { sql: 'import_compare_key(customer_name)=?', param: compareKey(c.name) };

/**
 * 可能和这张新订单重复的已有订单（含归档）：同一客户、同一采购单号（比较键相同），
 * 或同一客户、订单日期和交货日期都相同（内容指纹的前提）。结果按订单列表的顺序排，调用方再按原来的规则逐条比。
 */
export function duplicateOrderCandidates(
  store: Store,
  customer: CustomerRef,
  order: { externalPurchaseOrder?: string | null; orderDate?: string | null; deliveryDate?: string | null },
): Order[] {
  const c = customerClause(customer),
    found = new Set<number>();
  if (order.externalPurchaseOrder)
    for (const id of orderIds(
      store,
      `SELECT id FROM orders WHERE ${c.sql} AND import_compare_key(COALESCE(external_purchase_order,''))=?`,
      c.param,
      compareKey(order.externalPurchaseOrder),
    ))
      found.add(id);
  for (const id of orderIds(
    store,
    `SELECT id FROM orders WHERE ${c.sql} AND order_date IS ? AND delivery_date IS ?`,
    c.param,
    order.orderDate ?? null,
    order.deliveryDate ?? null,
  ))
    found.add(id);
  return sales(store).ordersByIds([...found], true);
}

/** 采购单号完全相同的订单（不含归档），给识别结果页提示“可能重复” */
export function ordersWithPurchaseOrder(store: Store, purchaseOrder: string): Order[] {
  return sales(store).ordersByIds(orderIds(store, 'SELECT id FROM orders WHERE external_purchase_order=?', purchaseOrder));
}

/** 这位客户以前的订单（含归档）里订过的产品，和明细上写的规格 */
export function customerProductSpecs(store: Store, customerId: number): CustomerProductSpecs {
  const out: Record<number, string[]> = {};
  const found = many(
    store.db,
    z.object({ id: rows.order_lines.shape.product_id, spec: rows.order_lines.shape.specification }),
    'SELECT DISTINCT l.product_id AS id, l.specification AS spec FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.customer_id=?',
    customerId,
  );
  for (const r of found) (out[r.id] ||= []).push(r.spec);
  return out;
}

/** 以前的订单里用过这个客户名（名字键相同）的客户编号：这些就是同一位客户的历史身份 */
export function historyCustomerIds(store: Store, name: string): number[] {
  return many(
    withKeys(store),
    z.object({ id: rows.orders.shape.customer_id }),
    'SELECT DISTINCT customer_id AS id FROM orders WHERE import_name_key(customer_name)=?',
    nameKey(name),
  ).map((r) => r.id);
}

