import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import { AppError, isLocalAdministrator, one, rows } from '../core/index.js';
import {
  arrivalCorrectionPreviewSchema,
  sumMoney,
  type arrivalCorrectionViewSchema,
  type CorrectionDetail,
  type FlowDocument,
  type FlowDocView,
  type PurchaseView,
  type ReceiptEvent,
} from '../../shared/business/index.js';
import { arrivalLineStatus, fulfillmentSummary, quantityString, quantityUnits } from '../../shared/core/index.js';
import { fail, type ArrivalLine, type FlowCheck, type FlowCommands } from './base.js';
import { receiptEvents } from './receipt-events.js';
import { receiptKey } from './refs.js';
import { assertNoActiveReturns } from './undo.js';
import { documentInput, validateFlow } from './validate.js';
import { inBatch, linkedPurchaseIds } from './validate-arrival.js';

/*
 * 更正已入库到货单的方案（只读，不写库）：按原到货单和更正后的内容，算出替代单、每张采购单的已到货；
 * 超收、退货挂着、送货单号撞了都拦在这里。状态、版本、流水对账、库存净变化由更正的核心（correction.ts）查。
 */
export type CorrectionInput = z.infer<typeof arrivalCorrectionPreviewSchema>;
type Arrival = FlowDocument<'arrival'>;
type Checked = FlowCheck<Arrival>;
/** 采购单（采购库存读出来的样子）的一条明细 */
type PurchaseLine = PurchaseView['lines'][number];
/** 预览里到货自己的内容（结构在 shared/business/flow-correction-views.ts） */
type View = CorrectionDetail<z.output<typeof arrivalCorrectionViewSchema>>;
/** 采购单更正前后（预览和结果里的样子） */
type PurchaseImpact = View['purchaseImpact'][number];

const inspectionKeys = ['acceptedQuantity', 'rejectedQuantity', 'stockedQuantity'] as const;
const units = (v: unknown) => (v == null ? null : quantityUnits(String(v)));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 更正后的每一行：带 index 的沿用原单那一行，只换掉写了的内容。
 * 改了数量、没另填验收数：原来全部合格入库的行，合格数和入库数跟着改；原来有不合格或没全入库的，要人把三个数写清楚。
 * 这条规则只在这里，界面和助手不再各算一遍。
 * 返回 structural（动了数量和验收数以外的内容，或增删了行）和 changed（有一行的数量或验收数变了）。
 */
function replacementLines(stored: Arrival, input: CorrectionInput) {
  const used = new Set<number>();
  let structural = false,
    changed = false;
  const lines = input.lines.map(({ index, ...raw }) => {
    const given: Record<string, unknown> = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    if (index === undefined) {
      if (!given.item) fail('新加的行要写清是哪种纸板（品名、规格、尺寸）。');
      structural = true;
      return { ...given, quantity: raw.quantity, differenceReason: input.reason };
    }
    const base = stored.lines[index];
    if (!base) fail('更正明细和原到货单对不上，请刷新后重填。', 409);
    if (used.has(index)) fail('更正明细重复。');
    used.add(index);
    for (const key of ['stockId', 'purchaseLineId', 'item', 'unitPrice', 'priceBasis'] as const)
      if (key in given && !same(given[key], base[key])) structural = true;
    const quantityChanged = units(raw.quantity) !== units(base.quantity),
      explicit = inspectionKeys.some((k) => k in given),
      mixed =
        (units(base.rejectedQuantity) || 0) > 0 ||
        (base.stockedQuantity != null && units(base.stockedQuantity) !== units(base.quantity));
    if (quantityChanged && !explicit && mixed)
      fail('原批次含不合格或未入库数量，请同时明确正确的验收合格、不合格和实际入库数量。');
    const line = {
      ...base,
      ...given,
      ...(quantityChanged && !explicit
        ? { acceptedQuantity: raw.quantity, rejectedQuantity: '0', stockedQuantity: raw.quantity }
        : {}),
      ...(quantityChanged ? { differenceReason: input.reason } : {}),
      quantity: raw.quantity,
    };
    if (quantityChanged || inspectionKeys.some((k) => units(line[k]) !== units(base[k]))) changed = true;
    return line;
  });
  if (used.size !== stored.lines.length) structural = true;
  return { lines, structural, changed };
}

/** 原到货单按内容应入的库存：每行实际入库数（没写就是到货数），按库存品合计 */
export function arrivalStocked(stored: Arrival) {
  const stocked = new Map<number, number>();
  for (const l of stored.lines)
    if (l.stockId) stocked.set(l.stockId, (stocked.get(l.stockId) || 0) + quantityUnits(l.stockedQuantity ?? l.quantity));
  return stocked;
}

/**
 * 替代单的单头（日期、送货单号、供应商）：每一行都是 0 等于这次到货没发生（那是撤销：撤销会放出这张送货单号，之后还能按实际重新登记），
 * 什么都没改不用提交；改单头、单价、库存品、采购明细或增删行要本机管理员
 */
function headerOf(original: ReceiptEvent, stored: Arrival, input: CorrectionInput, next: ReturnType<typeof replacementLines>, actor: Actor) {
  // 某一行改成 0（这一行其实没到货）可以，替代单里留着这一行，以后还能再更正回来
  if (next.lines.every((l) => !quantityUnits(l.quantity)))
    fail('更正后每一行都是 0，等于这次到货没有发生。请关掉这个窗口，改用“撤销这次到货”。', 409);
  const header = {
    date: input.date ?? original.date,
    reference: input.reference ?? stored.reference,
    supplierId: input.supplierId ?? stored.supplierId,
  };
  const headerChanged =
    header.date !== original.date || header.reference !== stored.reference || header.supplierId !== stored.supplierId;
  if (!headerChanged && !next.structural && !next.changed) fail('更正数量与原登记相同，无需提交。');
  if ((headerChanged || next.structural) && !isLocalAdministrator(actor))
    throw new AppError(
      '业务账号只能更正每一行的数量和验收数；改日期、送货单号、供应商、单价、库存品、采购明细或增删行，要本机管理员来做。',
      403,
      'permission',
    );
  return header;
}

/**
 * 沿用原单的采购明细、库存品不再查（原单当时查过，后来没挂订货单、采购单移出订货单或档案归档了也照样能改数量）。
 * 新挂上、换了的守登记到货的规矩：采购明细要在这张到货单的订货单里（要挂到别的订货单不是更正，是撤销后重新登记），
 * 采购单是正常已订货的，库存品没有归档；改了送货单号、供应商的，不能撞上别的到货单
 */
function checkNewLinks(flow: FlowCommands, stored: Arrival, document: Arrival, arrivalId: number) {
  const store = flow.store,
    keptLines = new Set(stored.lines.flatMap((l) => (l.purchaseLineId ? [l.purchaseLineId] : []))),
    keptStock = new Set(stored.lines.flatMap((l) => (l.stockId ? [l.stockId] : []))),
    relinked = document.lines.filter((l) => l.purchaseLineId && !keptLines.has(l.purchaseLineId)),
    movedPurchases = linkedPurchaseIds(store, relinked);
  if (!inBatch(store, stored.orderBatchId, movedPurchases))
    fail('更正只能挂这张到货单的订货单里的采购明细；要挂到别的订货单，请撤销这次到货，再在“待到货”里按订货单重新登记。');
  const live = flow.ops.repo.purchases(false, movedPurchases);
  if (movedPurchases.some((id) => live.find((p) => p.id === id)?.baseStatus !== '已订货'))
    fail('新挂上的采购明细要属于正常已订货的采购单（不能是已取消、待订货或已归档的）。');
  const newStock = [...new Set(document.lines.flatMap((l) => (l.stockId && !keptStock.has(l.stockId) ? [l.stockId] : [])))];
  if (flow.ops.repo.items(false, newStock).length !== newStock.length) fail('换上的库存品已归档或不存在，请选正常的原材料库存品。');
  const key = one(
    store.db,
    rows.flow_receipt_keys.pick({ document_id: true }),
    'SELECT document_id FROM flow_receipt_keys WHERE supplier_id=? AND reference=?',
    document.supplierId,
    receiptKey(document.reference),
  );
  if (key && key.document_id !== arrivalId) fail('这家供应商的这个送货单号已经登记在另一张到货单上，请核对后再更正。', 409);
}

/** 按采购明细合计的到货数量（千分整数） */
function receivedByLine(lines: readonly { lineId: number | null | undefined; quantity: string }[]) {
  const received = new Map<number, number>();
  for (const l of lines) if (l.lineId) received.set(l.lineId, (received.get(l.lineId) || 0) + quantityUnits(l.quantity));
  return received;
}

/** 采购单的一条明细更正后：已到货按“更正后 − 原来”的净变化算；允许减少历史超收量，但不借更正新增超收 */
function purchaseLineImpact(pl: PurchaseLine, delta: number): PurchaseImpact['lines'][number] {
  const after = pl.receivedUnits + delta;
  if (delta > 0 && after > pl.quantityUnits) fail('更正后累计到货超过采购订购数量。', 409);
  return {
    lineId: pl.id,
    name: pl.name,
    unit: pl.unit,
    ordered: pl.quantity,
    before: pl.receivedQuantity,
    after: quantityString(after),
    remaining: quantityString(Math.max(0, pl.quantityUnits - after)),
    arrivalStatus: arrivalLineStatus(pl.quantityUnits, after),
  };
}

/** 采购单：每条明细的已到货前后、到货进度（原到货和替代单挂的采购单都算） */
function purchaseImpactOf(flow: FlowCommands, original: ReceiptEvent, checked: Checked): PurchaseImpact[] {
  const oldReceived = receivedByLine(original.lines),
    newReceived = receivedByLine(checked.lines.map((l) => ({ lineId: l.purchaseLineId, quantity: l.quantity })));
  const purchaseIds = [
    ...new Set([...original.lines.map((l) => l.purchaseId), ...checked.lines.map((l) => l.purchaseId)].filter((id): id is number => !!id)),
  ];
  const purchases = flow.ops.repo.purchases(true, purchaseIds);
  return purchaseIds.flatMap((id) => {
    const p = purchases.find((x) => x.id === id);
    if (!p) return [];
    const lines = p.lines.map((pl) => purchaseLineImpact(pl, (newReceived.get(pl.id) || 0) - (oldReceived.get(pl.id) || 0)));
    const progress = fulfillmentSummary(lines.map((l) => l.arrivalStatus), '已到齐', '部分到货', '未到货').progress;
    return [
      {
        id,
        number: p.number,
        version: p.version,
        businessStatus: p.businessStatus,
        lines,
        arrivalProgress: progress === '已到齐' ? '全部到货' : progress,
      },
    ];
  });
}

/** 改了数量或验收数的行：结果和修改历史里逐行说原来多少、更正成多少 */
function correctionsOf(stored: Arrival, input: CorrectionInput, document: Arrival) {
  return input.lines.flatMap((l, i) => {
    const before = l.index === undefined ? undefined : stored.lines[l.index],
      after = document.lines[i];
    return !before || quantityUnits(before.quantity) === quantityUnits(after.quantity)
      ? []
      : [
          {
            name: after.item.name,
            unit: after.item.unit,
            originalQuantity: before.quantity,
            correctedQuantity: after.quantity,
            purchaseId: after.purchaseId ?? null,
            lineId: after.purchaseLineId ?? null,
          },
        ];
  });
}

/** 预览里替代单的每一行（和采购单到货记录的行同一个样子） */
const viewLine = (l: ArrivalLine, index: number): View['lines'][number] => ({
  index,
  lineId: l.purchaseLineId ?? null,
  purchaseId: l.purchaseId ?? null,
  stockId: l.stockId ?? null,
  quantity: quantityString(quantityUnits(l.quantity)),
  acceptedQuantity: l.acceptedQuantity,
  rejectedQuantity: l.rejectedQuantity,
  stockedQuantity: l.stockedQuantity,
  item: l.item,
  unitPrice: l.unitPrice ?? null,
  priceBasis: l.priceBasis ?? null,
  amount: l.amount,
});

export function arrivalCorrectionPlan(flow: FlowCommands, doc: FlowDocView<'arrival'>, stored: Arrival, input: CorrectionInput, actor: Actor) {
  const arrivalId = doc.id;
  const [original] = receiptEvents(flow.store, undefined, { arrivalIds: [arrivalId] });
  // 更正会撤销原到货、另出替代单；退货挂在原到货上，先撤销退货，退货记录才不会悬空或重复可退
  assertNoActiveReturns(flow, arrivalId);
  const next = replacementLines(stored, input),
    header = headerOf(original, stored, input, next, actor);
  // 替代单的内容按到货单的格式归一，再按核对入库时的规则校验（供应商、原件、采购明细、规格、验收数、日期）。
  // 采购剩余数量这里不让它查（原单的数量还算在已到货里），下面按净变化查；沿用的档案后来归档了也照样能更正
  const checked = validateFlow(flow, documentInput('arrival', { ...stored, ...header, lines: next.lines }, true), actor, true, { skipRemaining: true, maintenance: true }),
    document = checked.document;
  checkNewLinks(flow, stored, document, arrivalId);
  const purchaseImpact = purchaseImpactOf(flow, original, checked),
    corrections = correctionsOf(stored, input, document);
  const view: View = {
    arrivalId,
    receiptId: original.id,
    original,
    lines: checked.lines.map(viewLine),
    purchaseImpact,
    beforeAmount: sumMoney(original.lines.map((l) => l.amount)),
    // 核对补全的明细都带金额（validate-arrival.ts），没有金额的按“待定”算
    afterAmount: sumMoney(checked.lines.map((l) => l.amount ?? null)),
  };
  return {
    document,
    date: document.date,
    changes: checked.changes,
    warnings: checked.warnings,
    view,
    digest: { original, purchaseVersions: purchaseImpact.map((p) => [p.id, p.version]) },
    data: { receipt: original, purchaseImpact, corrections },
  };
}
/** 到货更正的方案（view、data 是到货自己的） */
export type ArrivalPlan = ReturnType<typeof arrivalCorrectionPlan>;
