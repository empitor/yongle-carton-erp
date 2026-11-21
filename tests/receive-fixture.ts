// 测试里按采购明细登记一张到货：换成订货单的行键，走唯一的登记入口 registerArrival（当场入库）。
import { randomUUID } from 'node:crypto';
import type { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/auth.js';
import { OrderBatchService } from '../server/operations/index.js';
import { registerArrival } from '../server/flow/register-arrival.js';
import { archiveFlowDocuments } from '../server/flow/archive.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { receiptEvents } from '../server/flow/receipt-events.js';
import { FlowService } from '../server/flow/service.js';
import type { FlowKind } from '../shared/business/physical-flow.js';
import { arrivalCorrectionPreviewSchema, type FlowDocView, type StockItemBaseView } from '../shared/business/index.js';
import type { OperationsService } from '../server/operations/index.js';
import { z } from 'zod';
import { batchRowKey } from '../shared/business/order-batch.js';
import { quantityString, quantityUnits } from '../shared/core/quantity.js';

type Item = { lineId: number; quantity: string; acceptedQuantity?: string; rejectedQuantity?: string; stockedQuantity?: string };

/** 更正的预览、结果按单据种类收窄（planCorrection、correctDocument 按种类返回）：测试里知道更正的是哪种，对不上让测试失败 */
export function ofKind<T extends { kind: string }, K extends T['kind']>(value: T, kind: K): Extract<T, { kind: K }> {
  if (!isKind(value, kind)) throw new Error('测试数据：更正的不是' + kind);
  return value;
}
function isKind<T extends { kind: string }, K extends string>(value: T, kind: K): value is Extract<T, { kind: K }> {
  return value.kind === kind;
}

/**
 * items 按采购明细写（和以前按采购单登记一样）：不合格不写就按 实到 - 合格 算，都不写就是 0。
 * 这张采购单还没有订货单时由 registerArrival 补建。返回登记结果，另带 receiptId（采购单上的到货记录键）。
 */
export function receiveLines(
  store: Store,
  purchaseId: number,
  input: { date: string; reference?: string; actualTime?: string | null; notes?: string; requestId?: string; items: Item[] },
  who: Actor,
) {
  const batches = new OrderBatchService(store),
    batchId = batches.batchIdOf(purchaseId),
    source = batches.sourceLines(new FlowService(store).views.purchases(false, purchaseId));
  const rows = new Map<string, { quantity: number; rejected: number; stocked: number | null }>();
  for (const item of input.items) {
    const line = source.find((l) => l.id === item.lineId);
    if (!line) throw new Error('测试数据：采购明细 ' + item.lineId + ' 不在采购单 ' + purchaseId + ' 里');
    const key = batchRowKey(line),
      quantity = quantityUnits(item.quantity),
      rejected =
        item.rejectedQuantity != null
          ? quantityUnits(item.rejectedQuantity)
          : item.acceptedQuantity != null
            ? quantity - quantityUnits(item.acceptedQuantity)
            : 0,
      row = rows.get(key) ?? { quantity: 0, rejected: 0, stocked: null };
    row.quantity += quantity;
    row.rejected += rejected;
    if (item.stockedQuantity != null) row.stocked = (row.stocked ?? 0) + quantityUnits(item.stockedQuantity);
    rows.set(key, row);
  }
  const result = registerArrival(
    store,
    { purchaseId },
    {
      ...(batchId !== null ? { expectedVersion: batches.view(batchId).version } : {}),
      requestId: input.requestId ?? randomUUID(),
      date: input.date,
      ...(input.actualTime !== undefined ? { actualTime: input.actualTime } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      rows: [...rows].map(([key, r]) => ({
        key,
        quantity: quantityString(r.quantity),
        rejectedQuantity: quantityString(r.rejected),
        ...(r.stocked !== null ? { stockedQuantity: quantityString(r.stocked) } : {}),
      })),
    },
    who,
  );
  return { ...result, receiptId: 'flow-' + result.arrival.id + '-' + purchaseId };
}

/**
 * 测试里要精确控制每条明细（单价、面积、验收数、跨采购单）时直接写一张挂采购明细的到货单（待核对），
 * 存成和登记到货一样的样子：带上明细的采购单所在的订货单（orderBatchId），按登记到货的身份保存。
 * 明细跨了两份订货单时把这几张采购单并进第一份（造合并订货单的测试数据）；没有订货单的补建。
 * 不是到货单、不挂采购明细、采购单还没订货的，原样交给 FlowService.save。
 */
export function saveDoc<K extends FlowKind>(flow: FlowService, kind: K, raw: unknown, who: Actor | null | undefined, id?: number): FlowDocView<K> {
  const linked = kind === 'arrival' ? linkedArrival.safeParse(raw) : null;
  const lineIds = linked?.success ? linked.data.lines.flatMap((l) => (l.purchaseLineId ? [l.purchaseLineId] : [])) : [];
  if (!linked?.success || !lineIds.length) return flow.save(kind, raw, who, id);
  const db = flow.store.db,
    purchaseIds = db
      .prepare('SELECT DISTINCT purchase_id FROM purchase_lines WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(lineIds))
      .map((r) => Number(r.purchase_id));
  const batches = new OrderBatchService(flow.store),
    owners: number[] = [];
  for (const p of purchaseIds) {
    const owner = batchOwner(batches, p, who);
    // 采购单还没订货、不存在：照原样保存，由单据校验说明为什么不行
    if (owner === null) return flow.save(kind, raw, who, id);
    owners.push(owner);
  }
  const batchId = owners[0];
  for (const p of purchaseIds)
    if (batches.batchIdOf(p) !== batchId) {
      db.prepare('DELETE FROM order_batch_purchases WHERE purchase_id=?').run(p);
      db.prepare('INSERT INTO order_batch_purchases(batch_id,purchase_id) VALUES(?,?)').run(batchId, p);
    }
  return flow.save(kind, { ...linked.data, orderBatchId: linked.data.orderBatchId ?? batchId }, who, id, { registered: true });
}
/** 到货单内容里 saveDoc 要看的两项（别的键原样留着交给 FlowService.save 校验） */
const linkedArrival = z.looseObject({
  orderBatchId: z.unknown().optional(),
  lines: z.array(z.looseObject({ purchaseLineId: z.number().nullish() })),
});
/** 这张采购单所在的订货单，没有就补建；采购单不存在或还没订货（补建不了）是 null */
function batchOwner(batches: OrderBatchService, purchaseId: number, who: Actor | null | undefined) {
  try {
    return batches.batchIdOf(purchaseId) ?? batches.ensureFor(purchaseId, who).id;
  } catch {
    return null; // 补建不了的原因交给后面的 FlowService.save 按单据校验说
  }
}

type Rows = string | { quantity: string; rejectedQuantity?: string; stockedQuantity?: string }[];
/** orderedPurchase、correctionFixture 要的那几样（flowFixture 的返回都有） */
type PurchaseBase = { store: Store; ops: OperationsService; flow: FlowService; supplier: { id: number }; raw: StockItemBaseView };
/** 到货更正的一行（arrivalCorrectionPreviewSchema 收的样子） */
type CorrectionLine = z.input<typeof arrivalCorrectionPreviewSchema>['lines'][number];
/**
 * 一张已订货的采购单（f 是 flowFixture：它的供应商；每行 2 元/张，默认一行 1000 张 f.raw）和自动建好的订货单。
 * lines 每项是数量（买 f.raw），或 [库存品, 数量]（几行要不同的纸板，订货单才分成几行）。
 * receive(数量或每行的数, 送货单号, 别的字段) 按订货单登记到货（日期默认 2026-10-10，当场入库；pending 存待入库）。
 */
export function orderedPurchase(f: PurchaseBase, who: Actor, lines: (string | [StockItemBaseView, string])[] = ['1000']) {
  const purchase = f.ops.savePurchase(
    {
      supplierId: f.supplier.id,
      status: '已订货',
      orderDate: '2026-10-01',
      lines: lines.map((l) => {
        const [stock, quantity] = typeof l === 'string' ? [f.raw, l] : l;
        return { ...stock, stockItemId: stock.id, quantity, unitPrice: '2', priceBasis: 'quantity' };
      }),
    },
    who,
  );
  const current = () => f.flow.views.purchases(true, purchase.id)[0];
  const batch = () => {
    const batches = new OrderBatchService(f.store),
      id = batches.batchIdOf(purchase.id);
    if (id === null) throw new Error('测试数据：采购单 ' + purchase.id + ' 还没有订货单');
    return batches.view(id);
  };
  const input = (rows: Rows, reference: string, extra: Record<string, unknown> = {}) => {
    const b = batch();
    const list = typeof rows === 'string' ? [{ quantity: rows }] : rows;
    return {
      expectedVersion: b.version,
      requestId: randomUUID(),
      reference,
      date: '2026-10-10',
      rows: list.map((r, i) => ({ key: b.rows[i].key, ...r })),
      ...extra,
    };
  };
  const register = (body: unknown) => registerArrival(f.store, { batchId: batch().id }, body, who);
  const receive = (rows: Rows, reference: string, extra: Record<string, unknown> = {}) => register(input(rows, reference, extra));
  return { purchase, current, batch, input, register, receive };
}

/**
 * 更正到货的底子：f 是 flowFixture，按 orderedPurchase（1000 张、2 元/张）登记一张到货（默认到 1000 张，2026-10-05）。
 * correct(到货单, 更正后的行, 谁, 单头) 先出方案再按摘要更正；use(数量) 领用纸板，模拟后面的业务用掉了库存。
 */
export function correctionFixture(f: PurchaseBase, who: Actor, received = '1000') {
  const p = orderedPurchase(f, who);
  const first = p.receive(received, '虚构送货单-01', { date: '2026-10-05' });
  const balance = () => f.ops.balance(f.raw.id);
  const moves = () =>
    f.store.db
      .prepare('SELECT id,source_kind,source_id,delta_units,date,purchase_line_id FROM stock_movements ORDER BY rowid')
      .all()
      .map((m) => ({ ...m }));
  /** 当前有效的那张到货单 */
  const effective = () => {
    const receipt = p.current().receipts.find((r) => r.effective);
    if (!receipt) throw new Error('测试数据：采购单 ' + p.purchase.id + ' 没有有效的到货');
    return f.flow.get(receipt.flowId, 'arrival');
  };
  const input = (id: number, lines: CorrectionLine[], extra: Record<string, unknown> = {}) => ({
    expectedVersion: f.flow.get(id).version,
    reason: '虚构更正原因',
    lines,
    ...extra,
  });
  const correct = (id: number, lines: CorrectionLine[], by: Actor = who, extra: Record<string, unknown> = {}) => {
    const v = input(id, lines, extra),
      plan = planCorrection(f.store, id, v, by);
    return ofKind(correctDocument(f.store, id, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, by), 'arrival');
  };
  const use = (quantity: string) => {
    const it = f.ops.items(true, f.raw.id)[0];
    f.flow.stock.move(
      f.raw.id,
      { expectedVersion: it.version, requestId: randomUUID(), action: 'out', quantity, date: '2026-10-06', notes: '虚构领料', acknowledged: true },
      who,
    );
  };
  return { ...p, arrivalId: first.arrival.id, balance, moves, effective, input, correct, use };
}

/** 测试里归档、恢复一张单据：走批量地址同一份做法（archiveFlowDocuments），办不成就让测试失败，返回单据 */
export function archiveDoc(flow: FlowService, id: number, restore: boolean, who: Actor | null | undefined, version: number) {
  const [result] = archiveFlowDocuments(flow, { action: restore ? 'restore' : 'archive', items: [{ id, version }] }, who).results;
  if (!result.success) throw new Error(result.message);
  return flow.get(id);
}

/**
 * 测试里按“要改的几行”更正一张已入库的到货单：没列的行照原数量带上，直接调 server/flow/arrival-correction.ts。
 * receipt 是到货单编号，或采购单上的到货记录键（flow-到货单编号）；items 每行 index 加要改的数量和验收数。
 */
type CorrectionItems = {
  /** 要改的行：index 认行，lineId 只是写测试时看得清是哪条采购明细（不交给更正） */
  items: (Partial<CorrectionLine> & { index: number; lineId?: number | null })[];
  /** 单头（expectedVersion、reason、日期等）和提交时的 requestId、previewDigest，原样交给更正 */
  [head: string]: unknown;
};
function correctionInput(store: Store, receipt: number | string, input: CorrectionItems) {
  const arrivalId = typeof receipt === 'number' ? receipt : receiptArrivalId(receipt);
  const { items, ...rest } = input;
  const original = receiptEvents(store, undefined, { arrivalIds: [arrivalId] })[0];
  if (!original) throw new Error('测试数据：没有到货单 ' + arrivalId);
  const lines = original.lines.map((l, index) => {
    const change = items.find((i) => i.index === index);
    if (!change) return { index, quantity: l.quantity };
    const { lineId: _lineId, ...rest } = change;
    return rest;
  });
  return { arrivalId, input: { ...rest, lines } };
}
/** 采购单上的到货记录键 flow-到货单编号-采购单编号 → 到货单编号 */
function receiptArrivalId(key: string) {
  const match = /^flow-(\d+)/.exec(key);
  if (!match) throw new Error('测试数据：到货记录键不是 flow-编号：' + key);
  return Number(match[1]);
}
export function previewCorrection(store: Store, receipt: number | string, input: CorrectionItems, who: Actor | null | undefined) {
  const v = correctionInput(store, receipt, input);
  return ofKind(planCorrection(store, v.arrivalId, v.input, who), 'arrival');
}
export function applyCorrection(store: Store, receipt: number | string, input: CorrectionItems, who: Actor | null | undefined) {
  const v = correctionInput(store, receipt, input);
  return ofKind(correctDocument(store, v.arrivalId, v.input, who), 'arrival');
}
