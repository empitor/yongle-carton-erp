import { randomUUID } from 'node:crypto';
import { exists, requireLocalAdministrator, type Actor, type Store } from '../core/index.js';
import { detachTasks, FlowService, moveDeliveries, referencingDocuments, retainDeliveryLines } from '../flow/index.js';
import { DatabaseMaintenanceService, deleteAfterSnapshot, type TakenSnapshot } from '../lifecycle/index.js';
import type { Order } from '../../shared/core/index.js';
import type { FlowDocView } from '../../shared/business/index.js';

type Delivery = FlowDocView<'delivery'>;

/**
 * 改订单之前：送货单里被删掉的订单明细先拿走。整张都是被删的行的送货单交给删除引擎删掉（库存数量不动），
 * 只删部分行的交给单据流转。只读挂着这张订单的送货单（按单据关联圈出来），下面逐条核对。
 * snapshot：改订单之前拍的破坏前快照（service.ts），整张删送货单时删除引擎凭它不再另拍。
 */
export function prepareOrderEdit(
  store: Store,
  before: Order,
  lines: readonly { id?: number }[],
  actor: Actor,
  snapshot: TakenSnapshot,
) {
  requireLocalAdministrator(actor);
  const keep = new Set(lines.flatMap((l) => (l.id ? [l.id] : []))),
    flow = new FlowService(store),
    engine = new DatabaseMaintenanceService(store);
  for (const d of flow.list('delivery', true, undefined, referencingDocuments(store, 'delivery', 'order_id', [before.id]))) {
    const next = d.lines.filter((l) => l.orderId !== before.id || keep.has(l.orderLineId));
    if (next.length === d.lines.length) continue;
    if (next.length) retainDeliveryLines(store, d, next, actor);
    else deleteWholeDelivery(engine, d, actor, snapshot);
  }
}

/**
 * 整张送货单都是被删的行：单据删掉，库存数量不动（它的出入库流水留着，改成独立的“系统维护”流水）。
 * 和只删部分行是同一个结果：改订单不等于这车货没发过。
 */
function deleteWholeDelivery(engine: DatabaseMaintenanceService, d: Delivery, actor: Actor, snapshot: TakenSnapshot) {
  const selection = { module: 'delivery', items: [{ id: d.id, version: d.version }], inventoryPolicy: 'preserve' },
    p = engine.preview(selection, actor);
  deleteAfterSnapshot(engine, { ...selection, requestId: randomUUID(), deletionDigest: p.digest }, actor, 'order-edit', snapshot);
}

/** 订单改好之后：生产任务、送货单跟着订单的新明细和新客户改，最后重算这张订单的生产、发货进度。 */
export function alignOrder(store: Store, before: Order, after: Order, actor: Actor) {
  const flow = new FlowService(store);
  const detachedTask = detachTasks(store, flow, after);
  if (before.customerId !== after.customerId) moveDeliveries(store, { flow, after, actor });
  if (
    detachedTask ||
    exists(store.db, 'SELECT 1 FROM flow_refs WHERE order_id=?', after.id) ||
    before.lines.some((l) => l.shippedQuantity !== undefined && l.shippedQuantity > 0)
  )
    flow.refreshOrderProgress([after.id]);
}
