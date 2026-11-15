import type { z } from 'zod';
import type { arrivalCorrectionPreviewSchema, FlowDocView } from '../../shared/business/index';

/**
 * 更正到货单的输入：按到货单取数（不依赖采购单上的到货记录），整理成服务端
 * POST /api/flow/:id/correction-preview、/correct 要的格式。只算数据，不发请求、不依赖 React。
 *
 * - lines 是更正后整张单：带 index 的沿用原单那一行，只写改了的内容；不带的是新加的行（带 item）；
 *   原单里没出现的行就是删掉（增删行、改单价、库存品、采购明细、日期、送货单号、供应商只有本机管理员能做）。
 * - 验收数（合格、不合格、入库）只有人动过才传；只改数量时由服务端按原批次算，前端不自己算。
 */

/** 交给服务端的输入（核验、提交同一份；提交时另加请求号和预览摘要） */
type ArrivalCorrectionBody = z.input<typeof arrivalCorrectionPreviewSchema>;
type BodyLine = ArrivalCorrectionBody['lines'][number];
/** 一行的纸板：原单那一行的，或新加的行选库存品、采购明细带出来的。新加的行原样交给服务端；窗口里显示名称和规格说明 */
type CorrectionItem = NonNullable<BodyLine['item']> & { specification?: string | null };
/** 计价方式：按平方米、按张 */
export type PriceBasis = NonNullable<BodyLine['priceBasis']>;
type DocLine = FlowDocView<'arrival'>['lines'][number];
/** 到货单里用到的：版本、日期、送货单号、供应商，每行的纸板、数量、验收数、库存品、采购明细、单价、计价方式 */
type ArrivalSource = Pick<FlowDocView<'arrival'>, 'version' | 'date' | 'reference' | 'supplierId'> & {
  lines: (Pick<
    DocLine,
    'quantity' | 'acceptedQuantity' | 'rejectedQuantity' | 'stockedQuantity' | 'stockId' | 'purchaseLineId' | 'unitPrice' | 'priceBasis'
  > & { item: CorrectionItem })[];
};
type SourceLine = ArrivalSource['lines'][number];

export type CorrectionRow = {
  /** 原单第几行；新加的行没有 */
  index?: number;
  /** 新加的行还没选库存品或采购明细时是 null */
  item: CorrectionItem | null;
  quantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  stockedQuantity: string;
  /** 合格、不合格、入库有没有人动过 */
  touched: boolean;
  stockId: number | null;
  purchaseLineId: number | null;
  unitPrice: string | null;
  priceBasis: PriceBasis | null;
};
export type CorrectionHead = { date: string; reference: string; supplierId: number | null };

const text = (v: unknown) => (v == null ? '' : String(v));
const inspection = ['acceptedQuantity', 'rejectedQuantity', 'stockedQuantity'] as const;

/** 打开窗口时的样子：原单每一行 */
export function correctionRows(arrival: ArrivalSource): CorrectionRow[] {
  return arrival.lines.map((l, index) => ({
    index,
    item: l.item,
    quantity: text(l.quantity),
    acceptedQuantity: text(l.acceptedQuantity),
    rejectedQuantity: text(l.rejectedQuantity),
    stockedQuantity: text(l.stockedQuantity),
    touched: false,
    stockId: l.stockId ?? null,
    purchaseLineId: l.purchaseLineId ?? null,
    unitPrice: l.unitPrice ?? null,
    priceBasis: l.priceBasis ?? null,
  }));
}
export const correctionHead = (arrival: ArrivalSource): CorrectionHead => ({
  date: text(arrival.date),
  reference: text(arrival.reference),
  supplierId: arrival.supplierId,
});

/** 新加的一行：选了库存品或采购明细后带出纸板 */
export const newCorrectionRow = (): CorrectionRow => ({
  item: null,
  quantity: '',
  acceptedQuantity: '',
  rejectedQuantity: '',
  stockedQuantity: '',
  touched: false,
  stockId: null,
  purchaseLineId: null,
  unitPrice: null,
  priceBasis: null,
});

/** 人动过的验收数（合格、不合格、入库，空的不写），和它们跟原单比有没有变（新加的行写了就算） */
function inspected(r: CorrectionRow, o: SourceLine | null) {
  const line: Pick<BodyLine, (typeof inspection)[number]> = {};
  let changed = false;
  if (r.touched)
    for (const k of inspection) {
      const value = r[k].trim();
      if (value === '') continue;
      line[k] = value;
      if (!o || value !== text(o[k])) changed = true;
    }
  return { line, changed };
}

/**
 * 库存品、采购明细、单价、计价方式：原单那一行改了的才写，新加的行写有值的。
 * 计价方式不能是空：原单有、改成空的不写。
 */
function managedChanges(r: CorrectionRow, o: SourceLine | null) {
  const line: Pick<BodyLine, 'stockId' | 'purchaseLineId' | 'unitPrice' | 'priceBasis'> = {};
  const differs = (value: unknown, before: unknown) => (o ? text(value) !== text(before) : value != null);
  if (differs(r.stockId, o?.stockId)) line.stockId = r.stockId;
  if (differs(r.purchaseLineId, o?.purchaseLineId)) line.purchaseLineId = r.purchaseLineId;
  const unitPrice = r.unitPrice === '' ? null : r.unitPrice;
  if (differs(unitPrice, o?.unitPrice)) line.unitPrice = unitPrice;
  if (differs(r.priceBasis, o?.priceBasis) && r.priceBasis != null) line.priceBasis = r.priceBasis;
  return line;
}

/**
 * 交给服务端的输入，和这次有没有改东西（没改不去核验）。
 * 原单那一行沿用的内容不写；新加的行写全（纸板、库存品、采购明细、单价）。
 */
export function correctionInput(
  arrival: ArrivalSource,
  head: CorrectionHead,
  rows: CorrectionRow[],
  reason: string,
): { input: ArrivalCorrectionBody; changed: boolean } {
  const original = arrival.lines;
  let changed = rows.length !== original.length || rows.some((r) => r.index === undefined);
  const lines = rows.map((r): BodyLine => {
    const o = r.index === undefined ? null : original[r.index];
    const quantity = r.quantity.trim();
    if (o && quantity !== text(o.quantity)) changed = true;
    const checked = inspected(r, o),
      managed = managedChanges(r, o);
    if (checked.changed || (o && Object.keys(managed).length > 0)) changed = true;
    // 新加的行还没选纸板时不带 item，服务端说清要先选哪种纸板
    const which = o ? { index: r.index } : r.item ? { item: r.item } : {};
    return { ...which, quantity, ...checked.line, ...managed };
  });
  const top: Pick<ArrivalCorrectionBody, 'date' | 'reference' | 'supplierId'> = {};
  if (head.date !== text(arrival.date)) top.date = head.date;
  if (head.reference.trim() !== text(arrival.reference)) top.reference = head.reference.trim();
  if (head.supplierId !== arrival.supplierId && head.supplierId) top.supplierId = head.supplierId;
  if (Object.keys(top).length) changed = true;
  return { input: { expectedVersion: arrival.version, reason: reason.trim(), ...top, lines }, changed };
}
