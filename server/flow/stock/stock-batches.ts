import type { Store } from '../../core/index.js';
import { AppError, many, one, parseStoredJson, rows } from '../../core/index.js';
import { quantityString, quantityUnits } from '../../../shared/core/index.js';
import { stockBatches, type FlowDocument, type StockBatchesResponse, type StockBatchView } from '../../../shared/business/index.js';
import { readStockDocument } from '../../operations/index.js';
import { storedContent } from '../documents/read.js';

/**
 * 成品库存按“每次完工”分批（只读）。批次和剩余的推算在 shared/business/stock-batches.ts，这里只按编号集合批量取数：
 * 库存品 1 次、流水 1 次、完工单 1 次、生产任务 1 次、订单和客户 1 次、原材料 1 次（有来源被改成系统维护的流水时
 * 再加修订记录 1 次），和批次多少无关，不逐批查。
 * 放在单据流转：要读完工单、生产任务（单据流转的表），也读库存流水和库存品（采购库存，在下层），订单客户（基础）。
 */

/** 默认只给最近这么多个已发完的批次 */
const RECENT_DEPLETED = 20;

type Production = { id: number; number: string; status: string; version: number; document: FlowDocument<'production'> };
type Task = { number: string; orderIds: number[] };
type Entry = ReturnType<typeof stockBatches>['entries'][number];
/** 推算批次用的一笔流水（shared/business 的 BatchMovement），加上其他入库显示的备注和登记人 */
type Movement = {
  id: string;
  seq: number;
  createdAt: string;
  date: string;
  delta: number;
  action: string;
  sourceKind: string;
  sourceId: string | null;
  orderId: number | null;
  restored: { sourceKind: string; sourceId: string } | null;
  notes: string;
  actorName: string;
};

const ids = (list: Iterable<unknown>) =>
  JSON.stringify([...new Set([...list].map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))]);
const movementRow = rows.stock_movements.pick({
  seq: true,
  id: true,
  created_at: true,
  date: true,
  delta_units: true,
  action: true,
  source_kind: true,
  source_id: true,
  customer_order_id: true,
  notes: true,
  actor_name: true,
});
/** 修订记录里改写前那一行流水（整行，见 server/operations 的 recordMovementRevision）：只看来源 */
const revisedSource = rows.stock_movements.pick({ source_kind: true, source_id: true });

/** 这个库存品的全部流水（推算批次用）；其他入库显示“原因”“操作人”用它的备注和登记人 */
function movementsOf(store: Store, stockId: number) {
  return many(
    store.db,
    movementRow,
    'SELECT seq,id,created_at,date,delta_units,action,source_kind,source_id,customer_order_id,notes,actor_name FROM stock_movements WHERE item_id=? ORDER BY created_at,seq',
    stockId,
  ).map((r): Movement => ({
    id: r.id,
    seq: r.seq,
    createdAt: r.created_at,
    date: r.date,
    delta: r.delta_units,
    action: r.action,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    orderId: r.customer_order_id,
    restored: null,
    notes: r.notes,
    actorName: r.actor_name,
  }));
}

/**
 * 删单据选“库存不动”时流水来源被改成系统维护（server/flow/deletion.ts），改写前的来源在修订记录的 before_document 里。
 * 只在有这种流水时查一次，按编号集合取，每条取最后一次“改写前还挂着单据”的那条修订。只用来配对冲销，见 shared/business/stock-batches.ts
 */
function restoreSources(store: Store, movements: Movement[]) {
  const maintained = movements.filter((m) => m.sourceKind === 'database-maintenance');
  if (!maintained.length) return;
  const last = new Map<string, { sourceKind: string; sourceId: string }>();
  for (const r of many(
    store.db,
    rows.stock_movement_revisions.pick({ movement_id: true, before_document: true }),
    'SELECT movement_id,before_document FROM stock_movement_revisions WHERE movement_id IN (SELECT value FROM json_each(?)) ORDER BY id',
    JSON.stringify(maintained.map((m) => m.id)),
  )) {
    const before = parseStoredJson(revisedSource, r.before_document, 'stock_movement_revisions.before_document（流水 ' + r.movement_id + '）');
    if (before.source_kind.startsWith('flow_') && before.source_id != null)
      last.set(r.movement_id, { sourceKind: before.source_kind, sourceId: before.source_id });
  }
  for (const m of maintained) m.restored = last.get(m.id) ?? null;
}

/** 完工单（只取这个库存品流水里出现过的入库）和它们挂的生产任务，各一次查出 */
function productionsOf(store: Store, movements: Movement[]) {
  const docs = new Map<string, Production>();
  for (const r of many(
    store.db,
    rows.flow_documents.pick({ id: true, number: true, status: true, version: true, document: true }),
    "SELECT id,number,status,version,document FROM flow_documents WHERE kind='production' AND id IN (SELECT value FROM json_each(?))",
    ids(movements.filter((m) => m.sourceKind === 'flow_production' && m.delta > 0).map((m) => m.sourceId)),
  ))
    docs.set(String(r.id), { id: r.id, number: r.number, status: r.status, version: r.version, document: storedContent('production', r) });
  const tasks = new Map<number, Task>();
  for (const r of many(
    store.db,
    rows.flow_documents.pick({ id: true, number: true, document: true }),
    "SELECT id,number,document FROM flow_documents WHERE kind='task' AND id IN (SELECT value FROM json_each(?))",
    ids([...docs.values()].map((d) => d.document.taskId)),
  ))
    tasks.set(r.id, { number: r.number, orderIds: storedContent('task', r).orderIds });
  return { docs, tasks };
}

/** 要显示的批次用到的订单（带客户名）和原材料（名称、材质、楞型），各一次 */
function shownRefs(store: Store, shownDocs: Production[], taskOf: (d: Production) => Task | undefined) {
  const orders = new Map<number, { id: number; number: string; customerName: string }>();
  for (const r of many(
    store.db,
    rows.orders.pick({ id: true, number: true }).extend({ customer_name: rows.orders.shape.customer_name }),
    'SELECT o.id,o.number,COALESCE(c.name,o.customer_name) AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id IN (SELECT value FROM json_each(?))',
    ids(shownDocs.flatMap((d) => taskOf(d)?.orderIds ?? [])),
  ))
    orders.set(r.id, { id: r.id, number: r.number, customerName: r.customer_name });
  const raws = new Map<number, { name: string; material: string; flute: string }>();
  for (const r of many(
    store.db,
    rows.stock_items.pick({ id: true, name: true, document: true }),
    'SELECT id,name,document FROM stock_items WHERE id IN (SELECT value FROM json_each(?))',
    ids(shownDocs.flatMap((d) => d.document.materials.map((m) => m.stockId))),
  )) {
    const doc = readStockDocument(r.document, r.id);
    raws.set(r.id, { name: r.name, material: doc.material.trim(), flute: doc.flute.trim() });
  }
  return { orders, raws };
}

/** 一批用了哪些原材料、各多少（领用减退回，用量是 0 的不列）；尺寸已经在名称里，不再重复，材质、楞型单独给，有才写 */
function materialsOf(d: Production, raws: ReturnType<typeof shownRefs>['raws']) {
  return d.document.materials.flatMap((m) => {
    const raw = raws.get(m.stockId),
      used = quantityUnits(m.issued) - quantityUnits(m.returned);
    if (!raw || used <= 0) return [];
    return [{ stockId: m.stockId, name: raw.name, material: raw.material, flute: raw.flute, quantity: quantityString(used) }];
  });
}

export function stockItemBatches(store: Store, stockId: number, options: { allDepleted?: boolean } = {}): StockBatchesResponse {
  const item = one(store.db, rows.stock_items.pick({ id: true, kind: true, unit: true }), 'SELECT id,kind,unit FROM stock_items WHERE id=?', stockId);
  if (!item) throw new AppError('库存品不存在。', 404);
  if (item.kind !== 'finished') throw new AppError('只有成品库存按完工分批显示。', 400);
  const movements = movementsOf(store, stockId);
  const movementById = new Map(movements.map((m) => [m.id, m]));
  restoreSources(store, movements);
  const { docs, tasks } = productionsOf(store, movements);
  const taskOf = (d: Production) => (d.document.taskId === null ? undefined : tasks.get(d.document.taskId));
  // 只有有效（已确认）的完工单算批次；推算送货先扣哪批要用到全部批次的订单。
  // 已撤销的完工单和有效完工单的生产任务、更正关系用来判断“撤销后重新登记”的顶替（规则在 shared/business/stock-batches.ts）
  const production = new Map<string, { orderIds: number[]; taskId: number | null; correctionOf: string | null }>(),
    reversed = new Map<string, { taskId: number | null }>();
  for (const [key, d] of docs)
    if (d.status === 'confirmed')
      production.set(key, {
        orderIds: taskOf(d)?.orderIds ?? [],
        taskId: d.document.taskId,
        correctionOf: d.document.correctionOf == null ? null : String(d.document.correctionOf),
      });
    else if (d.status === 'reversed') reversed.set(key, { taskId: d.document.taskId });
  const result = stockBatches(movements, production, reversed);
  // 界面排列：完工批次在前、其他入库在后（不穿插），各自按完工日期（其他入库按流水日期）新的在前，同一天后登记的在前
  const newestFirst = [...result.entries].sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === 'batch' ? -1 : 1) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || b.position - a.position,
  );
  const open = newestFirst.filter((e) => e.remainingUnits > 0),
    depletedAll = newestFirst.filter((e) => e.remainingUnits <= 0),
    depleted = options.allDepleted ? depletedAll : depletedAll.slice(0, RECENT_DEPLETED);
  const docOf = (e: Entry) => (e.sourceId ? docs.get(e.sourceId) : undefined);
  const { orders, raws } = shownRefs(store, [...open, ...depleted].flatMap((e) => docOf(e) ?? []), taskOf);
  /** 一批的单据部分：完工单、生产任务、订单、用料、操作人和批次备注；其他入库没有完工单，操作人是登记那笔流水的人 */
  const documentPart = (e: Entry, movement: Movement | undefined) => {
    const d = docOf(e);
    if (!d)
      return { documentId: null, number: null, documentVersion: null, taskId: null, taskNumber: null, orders: [], materials: [],
        operator: e.kind === 'other' ? (movement?.actorName ?? '') : '', notes: '' };
    const task = taskOf(d);
    return {
      documentId: d.id,
      number: d.number,
      documentVersion: d.version,
      taskId: task ? d.document.taskId : null,
      taskNumber: task?.number ?? null,
      orders: (task?.orderIds ?? []).flatMap((id) => orders.get(id) ?? []),
      materials: materialsOf(d, raws),
      operator: d.document.operator,
      notes: d.document.notes,
    };
  };
  const view = (e: Entry): StockBatchView => {
    const movement = movementById.get(e.movementId);
    return {
      key: e.movementId,
      kind: e.kind,
      date: e.date,
      label: e.label,
      inQuantity: quantityString(e.inUnits),
      remaining: quantityString(e.remainingUnits),
      remainingUnits: e.remainingUnits,
      ...documentPart(e, movement),
      reason: e.kind === 'other' ? (movement?.notes ?? '').trim() : '',
    };
  };
  return {
    stockItemId: item.id,
    unit: item.unit,
    balance: quantityString(result.balanceUnits),
    open: open.map(view),
    depleted: depleted.map(view),
    depletedTotal: depletedAll.length,
    unmatchedUnits: result.unmatchedUnits,
    unmatched: quantityString(Math.abs(result.unmatchedUnits)),
  };
}

/**
 * 助手按产品查批次：找这个产品的成品库存品（一个产品只有一个成品库存品，库上有唯一索引）。
 * 找不到时如实报，不替它挑。
 */
export function finishedStockOfProduct(store: Store, productId: number): number {
  const row = one(store.db, rows.stock_items.pick({ id: true }), 'SELECT id FROM stock_items WHERE product_id=?', productId);
  if (!row) throw new AppError('这个产品还没有成品库存，没有批次。', 404);
  return row.id;
}
