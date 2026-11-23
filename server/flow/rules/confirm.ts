import { sales } from '../../sales/index.js';
import type { Actor } from '../../core/index.js';
import { assertPreviewCurrent, audit, exists, onceByRequest, one, operationRequest, requirePermission, rows } from '../../core/index.js';
import { MAX_STOCK_UNITS, today, type FlowKind } from '../../../shared/core/index.js';
import { flowConfirmSchema, flowViewSchema, type FlowDocument, type FlowDocView } from '../../../shared/business/index.js';
import { stockLedger } from '../../operations/index.js';
import { fail, newItemOf, taskOf, type FlowCommands } from '../documents/base.js';
import { touchFlowDocument, writeFlowDocument } from '../documents/document-store.js';
import { storedDocument } from '../documents/read.js';
import { arrivalPurchaseIds, syncReceivedUnits } from './receipt-events.js';
import { receiptKey, rewriteRefs, saveReceiptKey } from '../documents/refs.js';
import { updateOrders } from './order-progress.js';
import { examine, requireDraft } from './preview.js';
import { validateFlow } from './validate.js';

const { insertMovement, setPurchaseLineStock, touchOrderBatch, touchPurchases, touchStockItems } = stockLedger;

/*
 * 确认单据（核对入库、出库、下达）：按当前数据重算核对内容、和预览摘要比对，按单据写库存流水、改状态、记审计，
 * 到货单同时重算采购单的已到货，送货单、完工单重算订单进度。
 */

/** 流水记在哪张单据上：种类、编号、单号、流水日期 */
type MovementSource = { kind: FlowKind; id: number; number: string; date: string };
/**
 * 一笔流水：哪个库存品、变多少（千分整数）、记在哪张单据上、谁、为什么（写进备注“单号 · 为什么”）；
 * 挂的采购明细和订单（没有不写），来源种类（不写就是 flow_<单据种类>）
 */
type MovementInput = {
  stockId: number;
  delta: number;
  doc: MovementSource;
  actor: Actor;
  reason: string;
  lineId?: number | null;
  orderId?: number | null;
  sourceKind?: string;
};

export function movement(flow: FlowCommands, m: MovementInput) {
  const { stockId, delta, doc } = m,
    before = flow.ops.balance(stockId),
    after = before + delta;
  if (after < 0 || !Number.isSafeInteger(after) || after > MAX_STOCK_UNITS)
    fail('库存不足或数量超限，整张单据未提交。', 409);
  const id = insertMovement(flow.store, {
    stockId,
    action: delta < 0 ? 'out' : doc.kind === 'arrival' ? 'purchase' : 'in',
    delta,
    before,
    after,
    sourceKind: m.sourceKind || 'flow_' + doc.kind,
    sourceId: String(doc.id),
    purchaseLineId: m.lineId ?? null,
    orderId: m.orderId ?? null,
    date: doc.date,
    notes: doc.number + ' · ' + m.reason,
    actor: m.actor,
  });
  touchStockItems(flow.store, [stockId]);
  return id;
}
/** 出库日不是今天（补录、更正改了出库日期）时的出库时间：那天北京时间中午，送达日期才能不早于它 */
export const shippedAtOf = (date: string) => new Date(date + 'T12:00:00+08:00').toISOString();

/** 到货：同一供应商的送货单号、同一份原件只能入库一次，记下它们已经入过库 */
function claimReceipt(flow: FlowCommands, doc: FlowDocView<'arrival'>) {
  const db = flow.store.db,
    key = receiptKey(doc.reference);
  if (exists(db, 'SELECT 1 FROM flow_receipt_keys WHERE supplier_id=? AND reference=?', doc.supplierId, key))
    fail('同一供应商送货单号已收货，不能重复入库。', 409);
  const source = doc.sourceId ? one(db, rows.flow_sources.pick({ hash: true }), 'SELECT hash FROM flow_sources WHERE id=?', doc.sourceId) : null;
  if (source && exists(db, 'SELECT 1 FROM flow_file_uses WHERE hash=?', source.hash))
    fail('该原始送货文件已经确认入库。', 409);
  saveReceiptKey(flow.store, doc.supplierId, doc.reference, doc.id);
  if (source)
    flow.store.db
      .prepare(
        'INSERT INTO flow_file_uses(hash,document_id) VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET document_id=excluded.document_id',
      )
      .run(source.hash, doc.id);
}

/**
 * 送货单出库就是装车：单据日期、出库流水和财务归属月份都按实际出库那天；原来安排的日期留作计划送货日。
 * 已出库的送货单改数量走更正（correction.ts），替代单直接沿用原单的出库日和送达记录，不经过这里
 */
function shipment(flow: FlowCommands, doc: FlowDocView<'delivery'>, given: string | undefined) {
  const shipDate = given || today();
  if (shipDate > today()) fail('出库日期不能晚于今天。');
  if (given) {
    const orderIds = [...new Set(doc.lines.map((l) => Number(l.orderId)).filter(Boolean))];
    const late = sales(flow.store).ordersByIds(orderIds, true).find((o) => o.orderDate > shipDate);
    if (late) fail('出库日期不能早于订单 ' + late.number + ' 的下单日期 ' + late.orderDate + '。');
  }
  // 补录了出库日的，出库时间按那天（北京时间中午）记，送达日期才能不早于它
  return { date: shipDate, shippedAt: shipDate !== today() ? shippedAtOf(shipDate) : new Date().toISOString() };
}

/** 确认后存的单据：核对补全的明细、名称快照、流水号、确认人和时间；送货单另记出库日期、出库人和出库时间 */
function confirmedDocument(
  flow: FlowCommands,
  doc: FlowDocument,
  done: { movements: string[]; by: string; at: string; shipped: { date: string; shippedAt: string } | null },
): FlowDocument {
  const confirmed = { movements: done.movements, confirmedBy: done.by, confirmedAt: done.at };
  switch (doc.kind) {
    case 'arrival':
      return { ...doc, supplierName: flow.ops.supplierName(doc.supplierId, true), ...confirmed };
    case 'delivery':
      return {
        ...doc,
        date: done.shipped?.date ?? doc.date,
        customerName: sales(flow.store).customer(doc.customerId, true)?.name,
        ...confirmed,
        // 送货单出库就是装车：变“送货中”，客户收到后再“确认送达”
        ...(done.shipped ? { shippedAt: done.shipped.shippedAt, shippedBy: done.by } : {}),
      };
    case 'task':
    case 'production':
      return { ...doc, productName: sales(flow.store).product(doc.productId, true)?.name, ...confirmed };
  }
}

/** 确认之后：关联、采购单的已到货、订单进度跟着变 */
function afterConfirm(flow: FlowCommands, doc: FlowDocView, after: FlowDocument, touchedPurchases: number[]) {
  const id = doc.id;
  rewriteRefs(flow.store, id, after);
  if (doc.kind === 'arrival')
    syncReceivedUnits(flow.store, false, [...new Set([...touchedPurchases, ...arrivalPurchaseIds(flow.store, [id])])]);
  if (doc.kind === 'delivery') updateOrders(flow, doc.lines.map((l) => l.orderId));
  if (doc.kind === 'production' && doc.taskId) updateOrders(flow, taskOf(flow, doc.taskId).orderIds);
}

export function confirm(flow: FlowCommands, id: number, raw: unknown, who: Actor | null | undefined): FlowDocView {
  const actor = requirePermission(who, 'business:edit'),
    // 送货单的实际出库日 shipDate 默认今天；只给补录用，不能晚于今天（shipment 里查）
    v = flowConfirmSchema.parse(raw);
  return onceByRequest(flow.store, operationRequest('flow-confirm', v.requestId, actor, { id, ...v }), () => {
    const doc = flow.get(id);
    requireDraft(doc);
    const { snap, previewDigest } = examine(flow, doc);
    // 类别 preview-changed：核对窗按它自动换成最新的核对内容（src/flow/flow-api.ts 的 confirmPreview）
    assertPreviewCurrent(v.previewDigest, previewDigest);
    if (v.shipDate && doc.kind !== 'delivery') fail('只有送货单出库时能填出库日期。');
    const plan = validateFlow(flow, storedDocument(flow.store, id), actor, true, { excludingId: id });
    // 确认前后这张到货关联的采购单，末尾只重算它们的已到货。
    const touchedPurchases = doc.kind === 'arrival' ? arrivalPurchaseIds(flow.store, [id]) : [];
    if (doc.kind === 'arrival') claimReceipt(flow, doc);
    const shipped = doc.kind === 'delivery' ? shipment(flow, doc, v.shipDate) : null,
      source = { kind: doc.kind, id, number: doc.number, date: shipped?.date ?? doc.date };
    const movements: string[] = [];
    const createdItems = new Map<string, number>();
    for (const [index, c] of plan.changes.entries()) {
      if (!c.stockId) {
        c.stockId = flow.createdItem(createdItems, newItemOf(c), actor, '到货单 ' + doc.number);
        // 到货行没选库存品的，入到哪个库存品记进这一行（核对的明细和库存变化一一对应）
        if (plan.document.kind === 'arrival') plan.document.lines[index].stockId = c.stockId;
      }
      if (c.deltaUnits)
        movements.push(
          movement(flow, { stockId: c.stockId, delta: c.deltaUnits, doc: source, actor, reason: c.reason, lineId: c.purchaseLineId, orderId: c.orderId }),
        );
      if (doc.kind === 'arrival' && c.purchaseLineId) {
        setPurchaseLineStock(flow.store, c.purchaseLineId, c.stockId);
      }
    }
    // 到货挂的采购单、订货单换一个版本号（订货单还差多少变了），别处打开的采购单、登记窗口提示刷新
    if (doc.kind === 'arrival' && plan.document.kind === 'arrival') {
      touchPurchases(
        flow.store,
        new Set(plan.document.lines.map((l) => l.purchaseId).filter(Boolean).map(Number)),
        new Date().toISOString(),
      );
      if (doc.orderBatchId != null) touchOrderBatch(flow.store, doc.orderBatchId, new Date().toISOString());
    }
    if (doc.kind === 'production' && doc.taskId) touchFlowDocument(flow.store, doc.taskId, new Date().toISOString());
    const after = confirmedDocument(flow, plan.document, { movements, by: actor.name, at: new Date().toISOString(), shipped });
    writeFlowDocument(flow.store, id, after, { date: after.date, status: 'confirmed', at: new Date().toISOString() });
    afterConfirm(flow, doc, after, touchedPurchases);
    const result = flow.get(id);
    audit(flow.store, actor, {
      action: 'confirm',
      entity: 'flow_' + doc.kind,
      id,
      document: {
        // 出库的送货单：确认前的样子也按出库日期记（原来安排的日期在计划日里），修改历史的确认这一条不另列日期变化
        before: shipped ? { ...doc, date: shipped.date } : doc,
        after: result,
        plan: { changes: plan.changes, warnings: plan.warnings, lines: plan.lines },
        previewDigest: v.previewDigest,
        sourceHash: snap.sourceHash,
      },
    });
    return result;
  }, flowViewSchema());
}
