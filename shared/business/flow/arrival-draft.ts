import { RAW_UNIT, fieldName } from '../../core/index.js';
import { dateSchema } from '../../core/index.js';
import { arrivalSchema } from './physical-flow.js';
import { normalizeDimensionUnit, parseDimension } from '../../core/index.js';
import { rawStockKey, sameRawSpec } from '../operations/stock-identity.js';
import { sheetArea, sumMoney, type SheetItem } from '../operations/operations.js';
import { NOTE_MAX_LENGTH } from '../operations/limits.js';
import type { MaybeText } from '../operations/display-text.js';
export const blankArrivalLine = () => ({
  stockId: null,
  purchaseLineId: null,
  item: {
    name: '',
    unit: RAW_UNIT,
    specification: '',
    material: '',
    flute: '',
    length: null,
    width: null,
    height: null,
    dimensionUnit: null,
    notes: '',
  },
  quantity: '',
  statedQuantity: null,
  unitPrice: null,
  // 计价方式留空（显示“待确认”），和到货单的录入结构一样不猜按平方米；挂了采购明细的保存时跟采购明细走
  priceBasis: null,
  statedArea: null,
  differenceReason: '',
});

/** 比是不是同一种纸板要看的几项（stock-identity.ts 的 sameRawSpec、rawStockKey） */
type Board = Parameters<typeof sameRawSpec>[0];
/** 还没到齐的订货单（/api/order-batches 的一项）里对订货单要用的部分 */
type OpenBatch = {
  id: number;
  supplierId: number;
  number: string;
  rows: { key: string; board: Board }[];
};
/** 到货行里比订货单要看的：纸板资料 */
type BoardLine = { item: Board };
/**
 * 识别出的到货行各对上订货单的哪一行：规格一样的行（shared/business/operations/stock-identity.ts 的 sameRawSpec）；
 * 规格一样的有几行时再比名称。每一行都正好对上一行才返回行键，否则返回 null。
 */
export function batchKeysFor(lines: readonly BoardLine[], batch: Pick<OpenBatch, 'rows'>): string[] | null {
  const keys = lines.map((l) => {
    const same = batch.rows.filter((r) => sameRawSpec(l.item, r.board));
    const named = same.length > 1 ? same.filter((r) => rawStockKey(r.board) === rawStockKey(l.item)) : same;
    return named.length === 1 ? named[0].key : null;
  });
  return keys.every((k): k is string => k !== null) ? keys : null;
}
/** 识别出的送货单挂哪份订货单：同一家供应商、还没到齐的订货单里每行都对得上的只有一份才算，否则 null（人来选） */
export function matchArrivalBatch(supplierId: number | null, lines: readonly BoardLine[], batches: OpenBatch[]) {
  if (!supplierId || !lines.length) return null;
  const found = batches.filter((b) => b.supplierId === supplierId && batchKeysFor(lines, b));
  return found.length === 1 ? found[0].id : null;
}

/** 识别结果里的一行：原件上没有的格子是 null（server/import/receipt-form.ts 的 receiptResultSchema） */
type ReceiptLine = {
  name?: MaybeText;
  specification?: MaybeText;
  material?: MaybeText;
  flute?: MaybeText;
  length?: MaybeText;
  width?: MaybeText;
  dimensionUnit?: MaybeText;
  quantity?: MaybeText;
  unit?: MaybeText;
  area?: MaybeText;
  unitPrice?: MaybeText;
  priceBasis?: MaybeText;
  notes?: MaybeText;
};
/** 一份到货识别结果（原件记录的 result） */
type ReceiptResult = {
  supplierName?: MaybeText;
  reference?: MaybeText;
  purchaseNumber?: MaybeText;
  date?: MaybeText;
  notes?: MaybeText;
  warnings?: readonly string[];
  lines: readonly ReceiptLine[];
};

/** 识别出的一行整理成到货行：单位不是“张”的不填实收数量（不换算），尺寸、尺寸单位认不出的记进提醒 */
function recognizedLine(line: ReceiptLine, warnings: Set<string>) {
  const board = line.name || '纸板';
  const unit = String(line.unit || '').trim();
  if (unit !== RAW_UNIT) warnings.add(board + ' 的原文数量单位为' + (line.unit || '未知') + '，请确认实际张数，系统未换算。');
  const dimensionUnit = normalizeDimensionUnit(line.dimensionUnit);
  if (line.dimensionUnit && !dimensionUnit) warnings.add(board + ' 尺寸单位未确认：' + line.dimensionUnit);
  const dimension = (raw: MaybeText) => {
    try {
      return parseDimension(raw);
    } catch {
      warnings.add(board + ' 尺寸待确认：' + String(raw));
      return null;
    }
  };
  return {
    stockId: null,
    purchaseLineId: null,
    item: {
      name: line.name || '',
      specification: line.specification || '',
      material: line.material || '',
      flute: line.flute || '',
      length: dimension(line.length),
      width: dimension(line.width),
      height: null,
      dimensionUnit,
      unit: RAW_UNIT,
      notes: line.notes || '',
    },
    quantity: unit === RAW_UNIT ? line.quantity || '' : '',
    statedQuantity: unit === RAW_UNIT ? line.quantity : null,
    statedArea: line.area ?? null,
    unitPrice: line.unitPrice ?? null,
    priceBasis: line.priceBasis ?? null,
    differenceReason: '',
  };
}

/**
 * 识别结果整理成待核对的到货单。batches 是还没到齐的订货单：能唯一对上一份就挂上（orderBatchId），
 * 对不上留空，由 arrivalDraftIssues 列进要补的项，人选订货单或选“不挂采购单”。
 * existing 是已经登记的那张到货单（还待入库的接着改它）。
 */
export function recognizedArrivalDraft(
  source: { id: string; result: ReceiptResult },
  suppliers: readonly { id: number; name: string }[],
  existing?: { id: number; version: number; status: string } | null,
  batches: OpenBatch[] = [],
) {
  const result = source.result,
    warnings = new Set<string>(result.warnings || []);
  const matches = suppliers.filter((s) => s.name.replace(/\s+/g, '') === String(result.supplierName || '').replace(/\s+/g, ''));
  if (matches.length !== 1) warnings.add('供应商未唯一匹配，请人工选择档案。');
  const parsedDate = dateSchema.safeParse(result.date),
    date = parsedDate.success ? parsedDate.data : '';
  if (!date) warnings.add('原件未识别出有效到货日期，请填写，不会自动使用今天。');
  const lines = result.lines.map((line) => recognizedLine(line, warnings));
  const supplierId = matches.length === 1 ? matches[0].id : null,
    orderBatchId = matchArrivalBatch(supplierId, lines, batches);
  return {
    warnings: [...warnings],
    draft: {
      ...(existing?.status === 'draft' ? { id: existing.id, version: existing.version } : {}),
      supplierId,
      ...(orderBatchId ? { orderBatchId } : {}),
      date,
      reference: result.reference || '',
      sourceId: source.id,
      notes: [result.notes, result.purchaseNumber ? '原单采购号：' + result.purchaseNumber : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, NOTE_MAX_LENGTH),
      lines,
    },
  };
}
/** 核对中的到货单：选的订货单、是否“不挂采购单”、各行纸板；其余字段交给 arrivalSchema 校验 */
type ArrivalDraft = { withoutPurchase?: unknown; orderBatchId?: number | null; lines?: readonly BoardLine[] };
/**
 * 待核对的到货单还缺什么。挂订货单是要补的一项：没选订货单、也没选“不挂采购单”（withoutPurchase，只在核对窗里用，
 * 不存进单据）时列出来；选了订货单（batch 传进来）但有的行在订货单里对不上，也列出来。
 */
export function arrivalDraftIssues(draft: ArrivalDraft, batch?: Pick<OpenBatch, 'number' | 'rows'>): string[] {
  const linked: string[] = [];
  if (!draft.withoutPurchase) {
    if (draft.orderBatchId == null)
      linked.push('订货单：请选这批货是哪份订货单的；供应商多送、样品这类不挂采购单的货选“不挂采购单”');
    else if (batch)
      (draft.lines || []).forEach((l, i) => {
        if (!batchKeysFor([l], batch))
          linked.push('第' + String(i + 1) + '行：订货单 ' + batch.number + ' 里没有这种纸板，请改选订货单或选“不挂采购单”');
      });
  }
  return [...linked, ...schemaIssues({ ...draft, orderBatchId: draft.orderBatchId ?? undefined })];
}
/** 校验提示里字段的叫法：到货单上的栏目叫法（栏目登记表），按所在的那一层（单头、明细、纸板）查 */
function issueLabel(path: readonly PropertyKey[], i: number) {
  const key = String(path[i]),
    parent = i > 0 && typeof path[i - 1] === 'number' ? String(path[i - 2] ?? '') : String(path[i - 1] ?? '');
  return fieldName(key, { record: 'arrival', parent }) || key;
}
function schemaIssues(draft: unknown): string[] {
  let parsed;
  try {
    parsed = arrivalSchema.safeParse(draft);
  } catch (e) {
    // 例如单位未识别导致数量为空时，数量校验会直接抛错；不能让它冒到 render
    // 阶段把整页卸载，只返回可核对提示。
    return ['到货识别结果字段格式待修正：' + (e instanceof Error ? e.message : '请核对数量、单价、面积等字段')];
  }
  if (parsed.success) return [];
  return [
    ...new Set(
      parsed.error.issues.map((i) => {
        const field = i.path
          .map((key, n, path) =>
            typeof key === 'number' ? `第${key + 1}行` : key === 'lines' || key === 'item' ? '' : issueLabel(path, n),
          )
          .filter(Boolean)
          .join(' · ');
        return field + '：' + (i.message.startsWith('Invalid input') ? '请选择或填写有效资料' : i.message);
      }),
    ),
  ];
}
/** 一行纸板的面积（平方米）；数量还不是有效的数（核对时没填完、填错）算不出时为 null，记进“面积待定” */
function lineArea(line: { item: SheetItem; quantity: string }) {
  try {
    return sheetArea(line.item, line.quantity);
  } catch {
    return null;
  }
}
export function arrivalTotals(lines: readonly { item: SheetItem; quantity: string }[]) {
  let quantity = 0,
    unknownArea = 0;
  const areas: string[] = [];
  for (const line of lines) {
    if (/^\d+$/.test(String(line.quantity))) quantity += Number(line.quantity);
    const value = lineArea(line);
    if (value === null) unknownArea++;
    else areas.push(value);
  }
  return { quantity, area: (sumMoney(areas) || '0').replace(/\.?0+$/, '') || '0', unknownArea };
}
