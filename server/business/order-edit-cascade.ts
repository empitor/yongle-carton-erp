import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Store } from '../core/index.js';
import { AppError, audit, exists, many, requireLocalAdministrator, rows } from '../core/index.js';
import { quantityUnits, type Order } from '../../shared/core/index.js';
import type { FlowDocView } from '../../shared/business/index.js';
import { FlowService, carryOverFlowDocument, replaceFlowDocument } from '../flow/index.js';
import { recordMovementRevision, relinkMovement } from '../operations/index.js';
import { DatabaseMaintenanceService, deleteAfterSnapshot, type TakenSnapshot } from './database-maintenance.js';
import { referencingDocuments } from './related-business.js';

/*
 * 本机管理员改订单时连带改单据：送货单、生产任务和它们的库存流水跟着订单的新明细、新客户走。
 * 调用方是 service.ts 的订单保存（同一个事务里先 prepareOrderEdit、保存订单、再 alignOrder）。
 * 整张送货单都被删时交给删除引擎（database-maintenance.ts），别的只改单据内容、改挂流水，不另记新流水。
 */

type Delivery = FlowDocView<'delivery'>;
type DeliveryLine = Delivery['lines'][number];
type Movement = z.output<typeof rows.stock_movements>;
/** 拿走的行的出库改挂到哪张新送货单；null 是改成独立的“系统维护”流水 */
type MoveTo = { id: number; number: string } | null;

/**
 * 改订单之前：送货单里被删掉的订单明细先拿走。整张都是被删的行的送货单交给删除引擎删掉（库存数量不动），
 * 只删部分行的照 retainDeliveryLines 处理。只读挂着这张订单的送货单（按单据关联圈出来），下面照原规则逐条核对。
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

/** 这张送货单名下的出库流水（按顺序号） */
const ownMovements = (store: Store, d: Delivery) =>
  many(
    store.db,
    rows.stock_movements,
    "SELECT * FROM stock_movements WHERE source_kind='flow_delivery' AND source_id=? ORDER BY seq",
    String(d.id),
  );

/**
 * 送货单只留下 lines 这几行（改订单时删了明细，或者订单换客户、把它的行拆到另一张送货单 moveTo）。
 * 只有已出库的送货单（confirmed）要动库存流水，按（库存品，订单）一组一组核对；不同订单的出库不合并，成本才归得到各自的订单：
 * - 这一组的行一行没少：流水原样留着，不改写；
 * - 拿走的行：它那笔出库整笔改挂，流水号、顺序号、数量、关联订单都不变（顺序号变了，成本计算会把它当成
 *   算完成本以后才补登的）。有 moveTo 就改挂到新送货单上，备注里的单号跟着换成新单的；没有（改订单删了明细）
 *   就改成独立的“系统维护”流水，货已经出去了，库存数量不动，备注还留着原来的送货单号；
 * - 流水和明细对不上（合计不等，或者有行要拿走的那一组不是一行一笔）：不猜、不另记新流水，整个改订单失败。
 *   现在的写法（出库、更正、改挂）写出来的送货单都是一行一笔，对不上只可能是有人直接改了库，所以提示先撤销这张送货单，
 *   改完订单按实际重新安排送货，不留“保存一次就重写流水”的入口。全部核对完才动手。
 * 每一笔改挂都留修订记录；末尾记一条单据级的审计。返回拿走的流水号。
 * 别的状态只改单据内容，不动流水：待送货、已取消的送货单没有流水；已撤销的送货单名下是出库和冲销两组流水，
 * 合计为 0，两组原样留在这张单上。只拆出库、不拆冲销的话，原单和拆出的新单各自的合计就不是 0 了，
 * 以后删其中一张并选“库存一起改回”，库存会凭空多出来或少掉。
 */
function retainDeliveryLines(store: Store, d: Delivery, lines: DeliveryLine[], actor: Actor, moveTo: MoveTo = null) {
  const detached = d.status === 'confirmed' ? detachMovements(store, { d, lines, actor, moveTo }) : [];
  replaceFlowDocument(store, d.id, {
    ...d,
    lines,
    // 已出库的：单据里记的流水号跟着换成现在还在这张单名下的那几笔
    ...(d.status === 'confirmed' ? { movements: ownMovements(store, d).map((m) => m.id) } : {}),
  });
  const flow = new FlowService(store);
  flow.maintenanceReferences(d.id);
  // 单据少了行、换了流水号：记一条单据级的审计，带改之前和改之后
  audit(store, actor, {
    action: 'remove-delivery-lines',
    entity: 'flow_delivery',
    id: d.id,
    document: {
      before: d,
      after: flow.get(d.id),
      movedMovements: detached,
      movedTo: moveTo ? { id: moveTo.id, number: moveTo.number } : null,
    },
  });
  return detached;
}

/** 拿走的行的出库整笔改挂（规则见 retainDeliveryLines），每一笔留修订记录；返回改挂的流水号 */
function detachMovements(store: Store, job: { d: Delivery; lines: DeliveryLine[]; actor: Actor; moveTo: MoveTo }) {
  const { d, moveTo } = job;
  const leaving = leavingMovements(d, job.lines, ownMovements(store, d));
  const reason = (moveTo ? '拆分送货单 ' : '调整送货单 ') + d.number,
    sourceKind = moveTo ? 'flow_delivery' : 'database-maintenance',
    sourceId = moveTo ? String(moveTo.id) : null;
  // 出库流水的备注是“单号 · 说明”（出库确认、更正都这么写）
  const prefix = d.number + ' · ';
  return leaving.map((m) => {
    // 改挂到新送货单：备注里的单号跟着换成新单的，和来源对得上；不是这个写法的备注原样留着
    const notes = moveTo && m.notes.startsWith(prefix) ? moveTo.number + ' · ' + m.notes.slice(prefix.length) : undefined;
    recordMovementRevision(store, job.actor, reason, m, {
      source_kind: sourceKind,
      source_id: sourceId,
      ...(notes === undefined ? {} : { notes }),
    });
    relinkMovement(store, m.id, { sourceKind, sourceId, orderId: m.customer_order_id, notes });
    return m.id;
  });
}

/** 流水和明细按（库存品，订单）分组的键 */
const groupKey = (stockId: number, orderId: number | null) => `${stockId}/${orderId ?? '-'}`;
const lineKey = (l: DeliveryLine) => groupKey(l.stockId, l.orderId);
const lineUnits = (l: DeliveryLine) => quantityUnits(l.quantity);
const sum = (list: number[]) => list.reduce((n, q) => n + q, 0);
function grouped<R, T>(list: readonly R[], keyOf: (row: R) => string, valueOf: (row: R) => T) {
  const map = new Map<string, T[]>();
  for (const row of list) map.set(keyOf(row), [...(map.get(keyOf(row)) || []), valueOf(row)]);
  return map;
}
// 对不上就不动手：流水和单据早就不一致了，不在这里猜哪笔该留、哪笔该走，也不另记新流水
// （新流水没有对应的修订记录，顺序号排在最后，日期落在算过成本的月份时会被当成跨期补登，销货成本算两遍）
function mismatch(d: Delivery): never {
  throw new AppError(
    '送货单 ' +
      d.number +
      ' 名下的出库流水和它的明细对不上（流水被改动过），这次没有改订单。请先撤销这张送货单再改订单，改完按实际重新安排送货。',
    409,
  );
}
/** 这一组要拿走的行：原来的行里去掉留下的（按数量一笔一笔对） */
function removedUnits(original: number[], kept: number[]) {
  const gone = [...original];
  for (const units of kept) {
    const at = gone.indexOf(units);
    if (at >= 0) gone.splice(at, 1);
  }
  return gone;
}
/** 留下的每一行、拿走的每一行，各找一笔数量相同的流水；返回拿走的那几笔 */
function matchMovements(own: Movement[], kept: number[], gone: number[], fail: () => never) {
  const rest = [...own];
  const take = (units: number) => {
    const at = rest.findIndex((m) => m.delta_units === -units);
    return at < 0 ? fail() : rest.splice(at, 1)[0];
  };
  for (const units of kept) take(units);
  return gone.map(take);
}
/**
 * 先全部核对完，再动手：每一组流水的合计应当等于这张单原来这一组明细的数量；有行要拿走的那一组还必须一行一笔。
 * 返回要拿走的流水。
 */
function leavingMovements(d: Delivery, lines: DeliveryLine[], movements: Movement[]) {
  const had = grouped(d.lines, lineKey, lineUnits),
    keep = grouped(lines, lineKey, lineUnits),
    moves = grouped(movements, (m) => groupKey(m.item_id, m.customer_order_id), (m) => m);
  const leaving: Movement[] = [];
  for (const k of new Set([...moves.keys(), ...had.keys()])) {
    const own = moves.get(k) || [],
      kept = keep.get(k) || [],
      original = had.get(k) || [];
    if (sum(own.map((m) => m.delta_units)) !== -sum(original)) mismatch(d);
    const gone = removedUnits(original, kept);
    if (gone.length) leaving.push(...matchMovements(own, kept, gone, () => mismatch(d)));
  }
  return leaving;
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

/** 订单里没有这种产品了：生产任务不再关联这张订单（只读挂着它的任务）。返回有没有改过 */
function detachTasks(store: Store, flow: FlowService, after: Order) {
  let detached = false;
  for (const task of flow
    .list('task', true, undefined, referencingDocuments(store, 'task', 'order_id', [after.id]))
    .filter((t) => t.orderIds.includes(after.id)))
    if (!after.lines.some((l) => l.productId === task.productId)) {
      detached = true;
      replaceFlowDocument(store, task.id, { ...task, orderIds: task.orderIds.filter((id) => id !== after.id) });
      flow.maintenanceReferences(task.id);
    }
  return detached;
}

type CustomerChange = { flow: FlowService; after: Order; actor: Actor };
/** 订单换了客户：只有这张订单的行的送货单整张改客户；和别的订单合送的，把这张订单的行拆到新送货单上 */
function moveDeliveries(store: Store, job: CustomerChange) {
  const { flow, after } = job;
  for (const d of flow
    .list('delivery', true, undefined, referencingDocuments(store, 'delivery', 'order_id', [after.id]))
    .filter((d) => d.lines.some((l) => l.orderId === after.id))) {
    const other = d.lines.filter((l) => l.orderId !== after.id);
    if (other.length) splitDelivery(store, { ...job, d, other });
    else changeCustomer(store, { ...job, d });
  }
}

function changeCustomer(store: Store, { flow, after, actor, d }: CustomerChange & { d: Delivery }) {
  replaceFlowDocument(store, d.id, { ...d, customerId: after.customerId, customerName: after.customerName });
  flow.maintenanceReferences(d.id);
  audit(store, actor, {
    action: 'change-delivery-customer',
    entity: 'flow_delivery',
    id: d.id,
    document: { before: d, after: flow.get(d.id) },
  });
}

/**
 * 拆出来的仍是同一次确认、同一车货：保存时校验会丢掉的系统字段（确认人和时间、出库和送达记录、
 * 原来安排的日期等）都照原单带过来
 */
const CARRIED_FIELDS = [
  'plannedDate',
  'plannedTime',
  'actualTime',
  'confirmedBy',
  'confirmedAt',
  'shippedAt',
  'shippedBy',
  'deliveredAt',
  'deliveredBy',
  'reversal',
  'cancellation',
] as const;
/** 原单上有的字段才带（原单上没有的不盖掉新单上的） */
function present<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const k of keys) if (source[k] !== undefined) picked[k] = source[k];
  return picked;
}

/**
 * 先建新单，再把原单上这张订单的行拿走：已出库的，这几行各自的出库流水整笔改挂到新单上，不重复扣库存。
 * 新单的行是从原单原样搬过来的，不是新增的发货：不按订单剩余可发数量核对（订单可能早由别的送货单发完了）
 */
function splitDelivery(store: Store, job: CustomerChange & { d: Delivery; other: DeliveryLine[] }) {
  const { flow, after, actor, d } = job,
    affected = d.lines.filter((l) => l.orderId === after.id);
  const created = flow.save(
    'delivery',
    { ...d, customerId: after.customerId, lines: affected, requestId: randomUUID() },
    actor,
    undefined,
    { moved: true },
  );
  const detached = retainDeliveryLines(store, d, job.other, actor, created);
  carryOverFlowDocument(store, created.id, d.status, {
    ...created,
    customerName: after.customerName,
    // 新单据经过待核对单据的校验会丢字段，已确认单据的明细快照要原样留着。
    lines: created.lines.map((l, i) => ({ ...l, ...affected[i] })),
    ...present(d, CARRIED_FIELDS),
    // 已出库的：拆出去的那几笔出库已经改挂到新单名下。已撤销的：出库和冲销两组流水都留在原单上，
    // 新单名下没有流水，撤销记录里也就不带流水号
    ...(d.status === 'confirmed' ? { movements: detached } : {}),
    ...(d.reversal ? { reversal: { ...d.reversal, movements: [] } } : {}),
  });
  flow.maintenanceReferences(created.id);
  // 新单最后是什么状态、带着哪几笔流水，在这里记准：保存时那条“新建待核对单据”的审计不记（save 的 moved）
  audit(store, actor, {
    action: 'split-delivery',
    entity: 'flow_delivery',
    id: created.id,
    document: { from: { id: d.id, number: d.number }, after: flow.get(created.id), movements: detached },
  });
}
