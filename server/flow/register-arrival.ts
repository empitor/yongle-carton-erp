import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { audit, one, onceByRequest, operationRequest, requirePermission, rows } from '../core/index.js';
import { errorMessage, quantityString, quantityUnits } from '../../shared/core/index.js';
import { allocateReceipt, batchReceiveSchema, batchRows, flowViewSchema, orderBatchViewSchema, type PurchaseView } from '../../shared/business/index.js';
import { OrderBatchService, readBatchSchedule } from '../operations/index.js';
import { FlowService } from './service.js';
import { fail } from './base.js';
import { viewOfKind } from './read.js';

/*
 * 登记到货只有这一个入口：按订货单（或一张采购单）登记一张供应商送货单。页面“待到货 → 登记到货”、
 * 助手 order_batch.receive 当场入库；AI 识别的送货单传 pending，存成待入库，人核对后入库（同一张单据、同一个确认）。
 * 到货是单据流转的事，采购库存只提供订货单和采购单，不反过来调单据流转。
 */
export type ArrivalTarget = { batchId: number } | { purchaseId: number };
type ReceiveInput = z.output<typeof batchReceiveSchema>;
type BatchRow = ReturnType<typeof batchRows>[number];
type Allocation = ReturnType<typeof allocateReceipt>[number];

/** 没填送货单号时，内部批次号里取请求号的前几位 */
const REFERENCE_REQUEST_CHARS = 6;
/** 登记到货的结果（同一请求号再交时按它核对上次存下的结果） */
const registeredResult = z.object({
  arrival: flowViewSchema('arrival'),
  batch: orderBatchViewSchema,
  verified: z.literal(true),
  summary: z.string(),
});
type RegisteredArrival = z.output<typeof registeredResult>;

/** 按编号读订货单那一行（刚补建的一定读得到，读不到是程序出错） */
function batchRow(store: Store, id: number) {
  const row = one(store.db, rows.order_batches, 'SELECT * FROM order_batches WHERE id=?', id);
  if (!row) throw new Error('订货单 ' + id + ' 刚建好却读不出来');
  return row;
}

/** 已有的订货单：核对它还在、版本和打开时一样 */
function checkedBatch(store: Store, id: number, expectedVersion: number | undefined) {
  const row = one(store.db, rows.order_batches, 'SELECT * FROM order_batches WHERE id=?', id);
  if (!row) return fail('订货单不存在。', 404);
  if (expectedVersion === undefined) return fail('请带上订货单的版本：先刷新订货单再登记到货。');
  if (row.version !== expectedVersion) return fail('订货单已更新，请刷新后重填。', 409);
  return row;
}

/** 订货单：给了采购单、它还没有订货单（功能上线前订的）就在同一个事务里补建，登记失败一起撤回 */
function targetBatch(store: Store, batches: OrderBatchService, target: ArrivalTarget, expectedVersion: number | undefined, actor: Actor) {
  if ('batchId' in target) return checkedBatch(store, target.batchId, expectedVersion);
  const existing = batches.batchIdOf(target.purchaseId);
  return existing === null ? batchRow(store, batches.ensureFor(target.purchaseId, actor).id) : checkedBatch(store, existing, expectedVersion);
}

/** 本次到货按行填的数分到各条采购明细（按采购单先后）；分不下的说清楚 */
function allocation(rowsOfBatch: BatchRow[], v: ReceiveInput) {
  let allocated: Allocation[];
  try {
    allocated = allocateReceipt(
      rowsOfBatch,
      v.rows.map((r) => ({
        key: r.key,
        quantityUnits: quantityUnits(r.quantity),
        rejectedUnits: quantityUnits(r.rejectedQuantity),
        stockedUnits: r.stockedQuantity === undefined ? undefined : quantityUnits(r.stockedQuantity),
      })),
    );
  } catch (e) {
    return fail(errorMessage(e));
  }
  if (!allocated.length) return fail('请填这次到了多少。');
  return allocated;
}

/**
 * 到货单的明细：每条分到的采购明细一行。送货单原文的数量、面积、差异原因记在这一行分到的第一条明细上
 * （到货单的核对照常查“数量对不上要写原因”）。一行分到几条采购明细时，第一条的原文数量记成“原文数量 − 其余几条的实到”，
 * 逐条核对和整行核对结果一样。
 */
function arrivalLines(rowsOfBatch: BatchRow[], allocated: Allocation[], v: ReceiveInput, purchases: PurchaseView[]) {
  const keyOf = new Map(rowsOfBatch.flatMap((r) => r.lines.map((l) => [l.id, r.key] as const))),
    input = new Map(v.rows.map((r) => [r.key, r])),
    purchaseLines = new Map(purchases.flatMap((p) => p.lines).map((l) => [l.id, l])),
    seen = new Set<string>();
  const stated = (a: Allocation) => {
    const key = keyOf.get(a.lineId),
      r = key === undefined ? undefined : input.get(key);
    if (key === undefined || !r) throw new Error('分到的采购明细 ' + a.lineId + ' 不在这次填的订货单行里');
    if (seen.has(key)) return {};
    seen.add(key);
    const rest = allocated.filter((b) => b !== a && keyOf.get(b.lineId) === key).reduce((n, b) => n + b.quantityUnits, 0);
    return {
      statedQuantity: r.statedQuantity == null ? null : quantityString(Math.max(0, quantityUnits(r.statedQuantity) - rest)),
      statedArea: r.statedArea ?? null,
      differenceReason: r.differenceReason ?? '',
    };
  };
  return allocated.map((a) => {
    const l = purchaseLines.get(a.lineId);
    if (!l) throw new Error('分到的采购明细 ' + a.lineId + ' 不在订货单的采购单里');
    return {
      ...stated(a),
      stockId: l.stockItemId,
      purchaseLineId: l.id,
      // 到货明细的物料就是这条采购明细（名称、单位、规格尺寸），单据保存按到货明细的结构取用；
      // 单价、计价方式不写，由保存时的核对（validate-arrival.ts 的 checkPurchaseLine）跟采购明细走
      item: l,
      quantity: quantityString(a.quantityUnits),
      acceptedQuantity: quantityString(a.quantityUnits - a.rejectedUnits),
      rejectedQuantity: quantityString(a.rejectedUnits),
      stockedQuantity: quantityString(a.stockedUnits),
    };
  });
}

/** 当场入库：核对并确认这张到货单，记订货单的到货审计 */
function receiveNow(flow: FlowService, ids: { draftId: number; batchId: number }, allocated: Allocation[], v: ReceiveInput, actor: Actor) {
  const check = flow.preview(ids.draftId, actor);
  const arrival = viewOfKind(flow.confirm(ids.draftId, { previewDigest: check.previewDigest, requestId: v.requestId, acknowledged: true }, actor), 'arrival');
  // 订货单的版本号由确认入库换（confirm.ts，核对 AI 识别的待入库单也一样）
  audit(flow.store, actor, {
    action: 'receive',
    entity: 'order_batches',
    id: ids.batchId,
    document: { arrivalId: arrival.id, arrivalNumber: arrival.number, lines: allocated },
  });
  return arrival;
}

/**
 * 按一张供应商送货单登记订货单的到货：每行填本次实到、不合格，可选实际入库（不给就等于合格数），
 * 系统按采购单先后分到各条采购明细，生成一张到货单（带订货单）。不是 pending 就在同一事务里核对入库。
 * 相同 requestId 不重复登记。
 */
export function registerArrival(store: Store, target: ArrivalTarget, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit'),
    v = batchReceiveSchema.parse(raw);
  if (v.arrival && !v.pending) fail('只有待入库的到货单能改存，当场入库的请重新登记。');
  const batches = new OrderBatchService(store),
    flow = new FlowService(store);
  return onceByRequest(store, operationRequest('batch-receive', v.requestId, actor, { target, v }), (): RegisteredArrival => {
    const batch = targetBatch(store, batches, target, v.expectedVersion, actor),
      purchases = flow.views.purchases(false, batches.memberIds(batch.id)),
      rowsOfBatch = batchRows(batches.sourceLines(purchases), readBatchSchedule(batch.schedule, batch.id)),
      allocated = allocation(rowsOfBatch, v);
    const draft = flow.save(
      'arrival',
      {
        date: v.date,
        actualTime: v.actualTime ?? null,
        supplierId: batch.supplier_id,
        reference: v.reference || '订货单' + batch.number + '-' + v.date.replaceAll('-', '') + '-' + v.requestId.slice(0, REFERENCE_REQUEST_CHARS),
        notes: v.notes,
        lines: arrivalLines(rowsOfBatch, allocated, v, purchases),
        orderBatchId: batch.id,
        sourceId: v.sourceId,
        requestId: v.requestId,
        ...(v.arrival ? { version: v.arrival.version } : {}),
      },
      actor,
      v.arrival?.id,
      { registered: true },
    );
    if (v.pending)
      return { arrival: draft, batch: flow.views.batch(batch.id), verified: true, summary: '已存成待入库的到货单 ' + draft.number + '，核对后入库。' };
    const arrival = receiveNow(flow, { draftId: draft.id, batchId: batch.id }, allocated, v, actor);
    const view = flow.views.batch(batch.id);
    return {
      arrival,
      batch: view,
      verified: true,
      summary:
        '已登记到货单 ' + arrival.number + '，库存已增加。' +
        (view.progress.state === '已到齐' ? '这份订货单已全部到齐。' : '订货单 ' + view.number + ' 还有没到的，留在待到货里。'),
    };
  }, registeredResult);
}
