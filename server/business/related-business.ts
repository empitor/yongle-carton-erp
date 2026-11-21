import { z } from 'zod';
import { many, type Store } from '../core/index.js';
import { FlowService, WarehouseDaily } from '../flow/index.js';
import { purchaseOrderLinks } from '../operations/index.js';
import { MarkService } from './product-marks.js';

const idRow = z.object({ id: z.number() });

/**
 * 某类单据里关联这条记录的单据编号，按 flow_refs 索引取（单据每次保存、确认、管理员修改都会重写它的关联）。
 * 调用方仍按原规则逐条核对。详情的关联业务、管理员改订单连带改单据（order-edit-cascade.ts）都用它。
 */
export function referencingDocuments(
  store: Store,
  kind: 'arrival' | 'task' | 'production' | 'delivery',
  column: 'order_id' | 'task_id' | 'purchase_line_id',
  ids: readonly number[],
) {
  if (!ids.length) return [];
  return many(
    store.db,
    idRow,
    `SELECT id FROM flow_documents WHERE kind=? AND id IN (SELECT document_id FROM flow_refs WHERE ${column} IN (SELECT value FROM json_each(?)))`,
    kind,
    JSON.stringify(ids),
  ).map((r) => r.id);
}

/** 采购单详情里的关联业务：到货记录、订的库存品、给哪几张订单订的料 */
function purchaseRelated(store: Store, id: number) {
  const views = new FlowService(store).views;
  const purchase = views.purchases(true, id).at(0);
  if (!purchase) return null;
  const lineIds = purchase.lines.map((l) => l.id);
  /** 到货记录的一行是不是这张采购单的：记着这张采购单，或挂在它的某条明细上（到货记录的行用 lineId 指采购明细） */
  const ofPurchase = (l: { purchaseId: number | null; lineId: number | null }) =>
    l.purchaseId === id || lineIds.some((lineId) => lineId === l.lineId);
  const daily = new WarehouseDaily(store),
    heads = daily.heads('arrival');
  // 只组装明细里出现这张采购单明细的到货单（关联表 flow_refs 的 purchase_line_id，单据每次保存都重写）
  const flowIds = new Set(referencingDocuments(store, 'arrival', 'purchase_line_id', lineIds));
  const arrivals = daily
    .recordsFor(
      'arrival',
      heads.filter((h) => typeof h.flowId === 'number' && flowIds.has(h.flowId)),
    )
    .filter((r) => r.lines.some(ofPurchase));
  return {
    arrivals,
    stocks: views.items(true, purchase.lines.flatMap((l) => (l.stockItemId ? [l.stockItemId] : []))),
    orders: store.ordersByIds(purchase.orderIds, true),
  };
}

/** 订单详情里的关联业务：生产任务、完工、送货、采购、成品库存、唛头、生产进度 */
function orderRelated(store: Store, id: number) {
  const order = store.order(id, true);
  if (!order) return null;
  const flow = new FlowService(store);
  const tasks = flow.list('task', true, undefined, referencingDocuments(store, 'task', 'order_id', [id])).filter((t) => t.orderIds.includes(id));
  const productions = flow
    .list('production', true, undefined, referencingDocuments(store, 'production', 'task_id', tasks.map((t) => t.id)))
    .filter((p) => tasks.some((t) => t.id === p.taskId));
  const purchaseIds = many(store.db, idRow, 'SELECT DISTINCT purchase_id AS id FROM (' + purchaseOrderLinks + ') WHERE order_id=?', id).map(
    (row) => row.id,
  );
  const productIds = [...new Set(order.lines.map((l) => l.productId))];
  // 只读这几个产品的成品库存品，再按原规则核对。
  const stockIds = many(
    store.db,
    idRow,
    "SELECT id FROM stock_items WHERE kind='finished' AND product_id IN (SELECT value FROM json_each(?))",
    JSON.stringify(productIds),
  ).map((r) => r.id);
  return {
    marks: new MarkService(store).listForProducts(order.lines.map((l) => l.productId)),
    tasks,
    productions,
    deliveries: flow
      .list('delivery', true, undefined, referencingDocuments(store, 'delivery', 'order_id', [id]))
      .filter((d) => d.lines.some((l) => l.orderId === id)),
    purchases: flow.views.purchases(true, purchaseIds),
    stocks: flow.views.items(false, stockIds).filter((s) => s.kind === 'finished' && order.lines.some((l) => l.productId === s.productId)),
    production: tasks
      .filter((t) => !t.archived && ['draft', 'confirmed'].includes(t.status))
      .map((t) => ({
        id: t.id,
        productId: t.productId,
        unit: t.unit,
        planned: t.quantity,
        completed: t.completed,
        progress: t.progress,
        number: t.number,
      })),
  };
}

/** 订单、采购单各自回的关联业务；按 entity 取，返回值跟着 entity 走 */
type RelatedOf = { orders: ReturnType<typeof orderRelated>; purchases: ReturnType<typeof purchaseRelated> };
type RelatedEntity = keyof RelatedOf;
const relatedReaders: { [E in RelatedEntity]: (store: Store, id: number) => RelatedOf[E] } = {
  orders: orderRelated,
  purchases: purchaseRelated,
};

/**
 * 订单、采购单详情里的关联业务（生产任务、完工、送货、采购、到货、库存、唛头），只读。
 * 只按关联圈出来的编号读，不全量加载再筛。
 */
export function relatedBusiness<E extends RelatedEntity>(store: Store, entity: E, id: number): RelatedOf[E] {
  return relatedReaders[entity](store, id);
}
