import { createHash } from 'node:crypto';
import { RAW_UNIT, UNITS_PER_QUANTITY, errorMessage, priceBases, today, quantityUnits } from '../../shared/core/index.js';
import { arrivalQuantities, purchaseLineAmount, sameRawSpec, sheetArea, stockItemSchema, type FlowDocument, type PurchaseView } from '../../shared/business/index.js';
import { lineOrderId } from '../operations/index.js';
import { exists, many, one, rows, type Store } from '../core/index.js';
import { fail, type ArrivalLine, type LineCheck } from './base.js';
import { StockViews } from './stock-views.js';
/*
 * 到货单的校验（validate.ts 的 validateFlow 按种类分派过来）：供应商、订货单、AI 识别原件、采购明细、规格、验收数量。
 */

/** 采购单（采购库存读出来的样子）的一条明细 */
type PurchaseLine = PurchaseView['lines'][number];
/** 到货行、采购明细、原材料库存品比规格时看的几项，加上单位 */
type Board = Parameters<typeof sameRawSpec>[0] & { unit?: string | null };
type ArrivalCheck = LineCheck<ArrivalLine>;
type Arrival = FlowDocument<'arrival'>;

/**
 * 到货行、采购明细、原材料库存品是不是同一种纸板：单位一样（原材料只有“张”），规格按全项目同一套规则比
 * （shared/business/stock-identity.ts 的 sameRawSpec：不分大小写和全半角、尺寸换成毫米）。
 * 到货没选库存品时自动对应已有的（rawStockFor）也是这套规则，所以自动并进去的，之后明确选它照样通过。
 */
const sameBoard = (a: Board, b: Board) => a.unit === b.unit && sameRawSpec(a, b);

/** 到货明细挂的采购单（去重） */
export function linkedPurchaseIds(store: Store, lines: readonly { purchaseLineId?: number | null }[]) {
  const lineIds = lines.flatMap((l) => (l.purchaseLineId ? [l.purchaseLineId] : []));
  return lineIds.length
    ? many(
        store.db,
        rows.purchase_lines.pick({ purchase_id: true }),
        'SELECT DISTINCT purchase_id FROM purchase_lines WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(lineIds),
      ).map((row) => row.purchase_id)
    : [];
}
/** 这几张采购单是不是都在这份订货单里。登记、核对到货和到货更正的替代单守同一条：挂的采购明细必须属于到货单的订货单 */
export function inBatch(store: Store, batchId: number | null | undefined, purchaseIds: number[]) {
  if (!purchaseIds.length) return true;
  if (batchId == null) return false;
  const members = many(
    store.db,
    rows.order_batch_purchases.pick({ purchase_id: true }),
    'SELECT purchase_id FROM order_batch_purchases WHERE batch_id=?',
    batchId,
  );
  const ids = new Set(members.map((r) => r.purchase_id));
  return purchaseIds.every((id) => ids.has(id));
}

/** 只认到货原件（唛头原件不能当送货单原件引用），内容和登记时的哈希要对得上 */
function checkSource(store: Store, sourceId: string) {
  const source = one(
    store.db,
    rows.flow_sources.pick({ hash: true, bytes: true }),
    "SELECT hash,bytes FROM flow_sources WHERE id=? AND kind='arrival'",
    sourceId,
  );
  if (!source) return fail('AI识别原件不存在。');
  if (createHash('sha256').update(source.bytes).digest('hex') !== source.hash) fail('来源文件完整性校验失败。');
}

/** 单头：日期、供应商、订货单、原件 */
function checkHead(ctx: ArrivalCheck, v: Arrival) {
  const { flow, maintenance, confirm } = ctx;
  // 实收、完工、出库这些实际发生的日期不能填未来；计划日期不受限
  if (confirm && v.date > today()) fail('到货日期不能晚于今天。');
  if (flow.ops.supplierName(v.supplierId, maintenance) === undefined) fail('供应商不存在或已归档。');
  // 订货单（order_batches）是外键：订货单不在了先说清楚，不等数据库报外键错误
  if (v.orderBatchId != null && !exists(flow.store.db, 'SELECT 1 FROM order_batches WHERE id=?', v.orderBatchId))
    fail('订货单不存在或已删除，请刷新后重新登记到货。', 409);
  if (v.sourceId) checkSource(flow.store, v.sourceId);
}

/**
 * 挂的采购明细：同一条不能出现两次；挂采购单的到货只由登记到货（register-arrival.ts）按订货单分配后产生，
 * 通用保存只收不挂采购单的货（供应商多送、样品）。改还没核对的这种单子要留在原来的订货单上；核对、确认时也核对明细的采购单都在这份订货单里。
 * 本机管理员维护不在这里卡；到货更正的替代单在 arrival-correction-plan.ts 按同一条核对。返回挂的采购单
 */
function checkPurchaseLinks(ctx: ArrivalCheck, v: Arrival) {
  const { flow, maintenance, confirm, registered, excludingId } = ctx;
  const linked = v.lines.flatMap((l) => (l.purchaseLineId ? [l.purchaseLineId] : []));
  if (new Set(linked).size !== linked.length) fail('同一采购明细不能重复出现，请合并本次到货数量。');
  const purchaseIds = linkedPurchaseIds(flow.store, v.lines);
  if (!purchaseIds.length || maintenance) return purchaseIds;
  const stored =
    excludingId === undefined
      ? null
      : (one(flow.store.db, rows.flow_documents.pick({ order_batch_id: true }), 'SELECT order_batch_id FROM flow_documents WHERE id=?', excludingId)
          ?.order_batch_id ?? null);
  if (v.orderBatchId == null || (!registered && !confirm && stored !== v.orderBatchId))
    fail('挂采购单的到货请在到货页“待到货”里按订货单登记到货；这里只登记不挂采购单的货（供应商多送、样品）。');
  if (!inBatch(flow.store, v.orderBatchId, purchaseIds)) fail('到货明细的采购单不在这份订货单里，请按订货单重新登记到货。');
  return purchaseIds;
}

/** 验收三个数（合格、不合格、入库）：不合规则按那句话报 */
function inspected(l: ArrivalLine) {
  try {
    return arrivalQuantities(l);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/** 这一行挂的采购明细和它所在的采购单（没挂、没找到是 null） */
function purchaseLineOf(purchases: PurchaseView[], lineId: number | null | undefined): { purchase: PurchaseView; line: PurchaseLine } | null {
  if (!lineId) return null;
  for (const purchase of purchases) {
    const line = purchase.lines.find((x) => x.id === lineId);
    if (line) return { purchase, line };
  }
  return null;
}

/**
 * 挂了采购明细的一行：采购单是当前供应商正常已订货的，不早于采购日期，规格一样，不超采购剩余（更正不查），
 * 采购明细已经关联了库存品的，没选的就入那一个（和明确选它一样），选了别的拒收；没写计价方式的按采购明细的
 */
function checkPurchaseLine(ctx: ArrivalCheck, v: Arrival, l: ArrivalLine, found: ReturnType<typeof purchaseLineOf>) {
  const { maintenance, skipRemaining } = ctx;
  if (
    !found ||
    (!maintenance && found.purchase.archived) ||
    (!maintenance && found.purchase.baseStatus !== '已订货') ||
    found.purchase.supplierId !== v.supplierId
  )
    return fail('采购明细须属于当前供应商的正常已订货采购单。');
  const { purchase, line: pl } = found;
  if (v.date < purchase.orderDate) fail('到货日期不能早于采购日期。');
  if (!sameBoard(pl, l.item)) fail('实收规格、材质、楞型或单位与采购明细不符，请重新匹配或作为无采购单收货。');
  if (!skipRemaining && pl.receivedUnits + quantityUnits(l.quantity) > pl.quantityUnits)
    fail('实收超过采购剩余数量；请核对采购，超出部分作为独立无采购单明细并填写差异原因。', 409);
  if (pl.stockItemId && l.stockId == null) l.stockId = pl.stockItemId;
  if (pl.stockItemId && l.stockId !== pl.stockItemId) fail('请使用采购明细已关联的原材料库存品。');
  // 没写计价方式的按采购明细上写的（这是已知的，不是猜）；写了的照写的
  if (l.priceBasis == null) l.priceBasis = priceBases.find((b) => b === pl.priceBasis) ?? null;
}

/** 一行的数量：纸板按整张，验收三个数合规，实收和送货单数量不一样要写差异原因；返回验收后的三个数 */
function checkQuantities(l: ArrivalLine) {
  stockItemSchema.parse({ ...l.item, kind: 'raw', productId: null });
  const qty = quantityUnits(l.quantity);
  if (l.item.unit === RAW_UNIT && qty % UNITS_PER_QUANTITY) fail('纸板库存按整张登记，不能填写小数张。');
  const inspection = inspected(l);
  if (l.statedQuantity !== null && quantityUnits(l.statedQuantity) !== qty && !l.differenceReason)
    fail('实收数量与送货单数量不一致，请记录差异原因。');
  return inspection;
}

/** 一行到货：核对后记入库变化（按验收后实际入库数），补全明细（面积、金额、采购单、供应商名） */
function checkLine(ctx: ArrivalCheck, v: Arrival, l: ArrivalLine, purchases: PurchaseView[]) {
  const { flow, item, changes, warnings, lines } = ctx;
  const inspection = checkQuantities(l);
  const found = purchaseLineOf(purchases, l.purchaseLineId);
  if (l.purchaseLineId) checkPurchaseLine(ctx, v, l, found);
  else if (!l.differenceReason) warnings.push('无采购单收货：' + l.item.name + '，请确认供应商与实际规格。');
  const it = l.stockId ? item(l.stockId, 'raw') : null;
  if (it && !sameBoard(it, l.item)) fail('所选库存品的尺寸、材质、楞型、规格或单位不一致，不允许合并。');
  const area = sheetArea(l.item, l.quantity),
    amount = purchaseLineAmount({ ...l.item, quantity: l.quantity, unitPrice: l.unitPrice, priceBasis: l.priceBasis });
  if (area === null) warnings.push(l.item.name + '缺少可换算面积的尺寸/单位，面积和面积计价金额待补充。');
  if (l.statedArea !== null && area !== null && Number(l.statedArea) !== Number(area))
    warnings.push(l.item.name + '标注面积与计算面积不同，请核对。');
  const purchase = found?.purchase ?? null;
  changes.push({
    stockId: it?.id || null,
    name: l.item.name,
    unit: l.item.unit,
    deltaUnits: quantityUnits(inspection.stockedQuantity),
    reason: '采购到货',
    purchaseLineId: l.purchaseLineId,
    orderId: lineOrderId(purchase, l.purchaseLineId),
    newItem: it ? null : { ...l.item, kind: 'raw', productId: null },
  });
  lines.push({
    ...l,
    ...inspection,
    area,
    amount,
    purchaseId: purchase?.id || null,
    purchaseNumber: purchase?.number || '',
    supplierName: flow.ops.supplierName(v.supplierId, false),
  });
}

/** 到货单：供应商、订货单、原件、采购明细（剩余数量、规格）、验收数量，入库变化按验收后实际入库数 */
export function checkArrival(ctx: ArrivalCheck, v: Arrival) {
  checkHead(ctx, v);
  const purchases = new StockViews(ctx.flow.store).purchases(true, checkPurchaseLinks(ctx, v));
  for (const l of v.lines) checkLine(ctx, v, l, purchases);
}
