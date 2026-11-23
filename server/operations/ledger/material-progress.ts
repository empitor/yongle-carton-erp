import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { purchaseBusinessStatuses } from '../../../shared/business/index.js';
import type { TrackedOrder } from '../../../shared/core/index.js';
import { many, orderIdScope } from '../../core/index.js';

type MaterialProgress = Exclude<TrackedOrder['materialProgress'], 'none'>;
const CANCELLED: (typeof purchaseBusinessStatuses)[number] = '已取消';

/** 每张订单的采购明细里还没到齐的、到过货的行数 */
const materialRow = z.object({ id: z.number(), open: z.number(), touched: z.number() });

/** 每张订单的订料进度：按有效采购明细的到货算 */
export function materialByOrder(db: DatabaseSync, orderIds: readonly number[] | undefined) {
  const { predicate, params } = orderIdScope(orderIds);
  const material = new Map<number, MaterialProgress>();
  for (const row of many(
    db,
    materialRow,
    // 张、公斤不能相加，一行超收也不能盖住另一行没到，所以按明细行数。
    // 每行算在它自己关联的订单上，没有就跟采购单头走（一张采购单可以给几张订单订料）。
    // 只看一部分订单时，先按两个外键列（都有索引）圈出相关的采购单，不扫全部明细；范围条件因此出现三次
    "SELECT * FROM (SELECT COALESCE(l.customer_order_id,p.customer_order_id) AS id,SUM(l.received_units<l.quantity_units) AS open,SUM(l.received_units>0) AS touched FROM purchases p JOIN purchase_lines l ON l.purchase_id=p.id WHERE p.status!='" + CANCELLED + "'" +
      (predicate
        ? ' AND p.id IN (SELECT id FROM purchases WHERE customer_order_id ' +
          predicate +
          ' UNION SELECT purchase_id FROM purchase_lines WHERE customer_order_id ' +
          predicate +
          ')'
        : '') +
      ' GROUP BY 1) WHERE id IS NOT NULL' +
      (predicate ? ' AND id ' + predicate : ''),
    ...params,
    ...params,
    ...params,
  ))
    material.set(row.id, !row.open ? 'done' : row.touched ? 'partial' : 'pending');
  return material;
}
