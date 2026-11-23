import { fulfillmentSummary, lineShippingProgress, type Order, type TrackedOrder } from '../../shared/core/index.js';
import type { Store } from '../core/index.js';
import { shippedByLine } from '../flow/index.js';
import { materialByOrder } from '../operations/index.js';

/** 为已经读出的订单补进度：送货和订料分别按订单编号一次读齐。 */
export function trackOrders(store: Store, orders: readonly Order[]): TrackedOrder[] {
  if (!orders.length) return [];
  const ids = orders.map((order) => order.id);
  const shipped = shippedByLine(store.db, ids);
  const material = materialByOrder(store.db, ids);
  return orders.map(({ costCents, lines, ...head }) => {
    const trackedLines = lines.map((line) => ({
      ...line,
      ...lineShippingProgress(line.quantity, shipped.get(line.id) ?? 0),
    }));
    const shippingSummary = fulfillmentSummary(
      trackedLines.map((line) => line.shippingStatus),
      '已发完',
      '部分发货',
      '未发货',
    );
    return {
      ...head,
      shippingProgress: shippingSummary.progress,
      shippingSummary,
      materialProgress: material.get(head.id) ?? 'none',
      costCents,
      lines: trackedLines,
    };
  });
}

export function trackedOrder(store: Store, id: number, includeArchived = false): TrackedOrder | undefined {
  const order = store.order(id, includeArchived);
  return order && trackOrders(store, [order])[0];
}
