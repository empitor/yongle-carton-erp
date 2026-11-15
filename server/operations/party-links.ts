import { z } from 'zod';
import type { Store } from '../core/index.js';
import { many } from '../core/index.js';

/**
 * 档案和往来单位的关联，产品、库存列表按客户、供应商筛选用（页面和助手同一套）。
 * 产品本身不挂客户：客户下过单的产品就算这个客户的。
 * 原材料看从这个供应商采购过的；成品看这个客户订过的产品对应的成品库存品。
 */
const idRow = z.object({ id: z.number() });
const idsOf = (store: Store, sql: string, partyId: number) => new Set(many(store.db, idRow, sql, partyId).map((r) => r.id));

export function productIdsOfCustomer(store: Store, customerId: number): Set<number> {
  return idsOf(store, 'SELECT DISTINCT l.product_id AS id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.customer_id=?', customerId);
}

/** 库存品按往来单位筛时和这个供应商或客户有关的库存品 id；没有筛选条件时返回 null。 */
export function stockIdsOfParty(
  store: Store,
  party: { supplierId?: number | null; customerId?: number | null },
): Set<number> | null {
  if (party.supplierId)
    return idsOf(
      store,
      'SELECT DISTINCT l.stock_item_id AS id FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE p.supplier_id=? AND l.stock_item_id IS NOT NULL',
      party.supplierId,
    );
  if (party.customerId)
    return idsOf(
      store,
      'SELECT id FROM stock_items WHERE product_id IN (SELECT DISTINCT l.product_id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.customer_id=?)',
      party.customerId,
    );
  return null;
}
