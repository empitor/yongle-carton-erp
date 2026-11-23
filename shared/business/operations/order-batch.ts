import { z } from 'zod';
import { MONTH_DAY_START, dateSchema, type SpecFields } from '../../core/index.js';
import { noteText, sumMoney } from './operations.js';
import { priceFromE4, priceToE4, quantityString, quantityUnits, quantityText } from '../../core/index.js';
import { specLine } from './display-text.js';
import { NO_DUE_DATE, arrivalTimeSchema } from './schedule.js';
import { MAX_RECEIVE_ROWS, MAX_SCHEDULE_ENTRIES } from './limits.js';

/** 订货单行的合并依据（JSON 文字）最多多长 */
const ROW_KEY_MAX_LENGTH = 2000;

/**
 * 订货批次：发给供应商的那一份订货单。可以包含同一家供应商的几张采购单，
 * 同一种纸板（名称、规格、尺寸、材质、楞型、单位、计价方式、单价都一样）在订货单上合成一行。
 * 系统里的采购单明细不合并；到货时按采购单先后把数量分回各条明细。
 *
 * 到货安排：每一行可以拆成几段“多少数量在哪天之前要到”，日期可以空着。
 * 已到的数量从截止日期最早的那段开始扣，没写日期的排在最后。
 */
export type BatchSourceLine = SpecFields & {
  purchaseId: number;
  purchaseNumber: string;
  purchaseOrderDate: string;
  id: number;
  name: string;
  unit: string;
  priceBasis?: string | null;
  unitPrice?: string | null;
  notes?: string | null;
  quantityUnits: number;
  receivedUnits: number;
  amount?: string | null;
};
/**
 * 采购单的明细带上采购单号、下单日期，数量换成数字：订货单的预览、详情、导出、到货登记都从这里取行。
 * 哪些采购单算进去（已订货的、没取消的）由调用方先挑好。
 */
/** 采购单视图的一行：订购、已到的千分整数可能是数字或文字，这里统一换成数字 */
type PurchaseLineView = Omit<BatchSourceLine, 'purchaseId' | 'purchaseNumber' | 'purchaseOrderDate' | 'quantityUnits' | 'receivedUnits'> & {
  quantityUnits?: unknown;
  receivedUnits?: unknown;
};
export const purchaseLinesOf = (
  purchases: readonly { id: number; number: string; orderDate: string; lines: readonly PurchaseLineView[] }[],
): BatchSourceLine[] =>
  purchases.flatMap((p) =>
    p.lines.map((l) => ({
      ...l,
      purchaseId: p.id,
      purchaseNumber: p.number,
      purchaseOrderDate: p.orderDate,
      quantityUnits: Number(l.quantityUnits),
      receivedUnits: Number(l.receivedUnits),
    })),
  );
export type ScheduleEntry = { rowKey: string; quantityUnits: number; dueDate: string | null };
type ScheduleView = ScheduleEntry & {
  /** 这段已经到了多少（按截止日期先后扣） */
  receivedUnits: number;
  remainingUnits: number;
  /** 没写日期时为 null；写了日期且还没到齐、已过截止日期时为 overdue */
  state: 'done' | 'overdue' | 'due' | 'undated';
  /** 没在到货安排里写、由系统补上的那段（订购数减去已安排数） */
  implicit?: boolean;
};
type BatchRow = {
  key: string;
  name: string;
  specification: string;
  unit: string;
  priceBasis: string | null;
  unitPrice: string | null;
  orderedUnits: number;
  receivedUnits: number;
  remainingUnits: number;
  amount: string | null;
  notes: string;
  /** 按采购单先后排好的明细，到货时按这个顺序分配 */
  lines: BatchSourceLine[];
  schedule: ScheduleView[];
};

const clean = (v: unknown) => (v == null ? '' : String(v).trim());

/** 订货单行的规格：和全站同一个规格行写法（shared/business/operations/display-text.ts 的 specLine） */
const batchSpecification = (l: BatchSourceLine) => specLine(l);

/** 算合并依据只看实物和价格：名称、规格、尺寸、材质、楞型、单位、计价方式、单价 */
type BatchKeySource = Pick<BatchSourceLine, 'name' | 'unit' | 'priceBasis' | 'unitPrice' | keyof SpecFields>;
/** 合并依据里的尺寸：固定用原来的写法（订货单里存着这个依据），显示文字以后再改也不影响 */
const sizeKey = (l: BatchKeySource) =>
  [l.length ?? '—', l.width ?? '—', ...(l.height == null ? [] : [l.height])].join(' × ') +
  (l.dimensionUnit ? ' ' + l.dimensionUnit : '（单位待确认）');
/**
 * 合并依据里的单价：按数值算，写法不同、数值相同的是同一个价（“2.76”“2.760”“2.7600”都记成“2.76”），
 * 不然订货单和印出来的单子上会出现两行一模一样的。换算走万分之一元的整数（shared/core/precision.ts），不经过浮点；
 * 去掉小数末尾的 0，原来就是这种写法的（“2.5”“3”）依据不变。不是合法单价的照原文。
 */
function priceKey(price: unknown) {
  const text = clean(price);
  if (!text) return '';
  try {
    return priceFromE4(priceToE4(text)).replace(/\.?0+$/, '');
  } catch {
    return text;
  }
}
/** 合并行的依据：实物和价格都一样才合成一行。 */
export function batchRowKey(l: BatchKeySource) {
  return JSON.stringify([
    clean(l.name),
    clean(l.specification),
    sizeKey(l),
    clean(l.material),
    clean(l.flute),
    clean(l.unit),
    clean(l.priceBasis) || 'quantity',
    priceKey(l.unitPrice),
  ]);
}

const lineOrder = (a: BatchSourceLine, b: BatchSourceLine) =>
  a.purchaseOrderDate.localeCompare(b.purchaseOrderDate) || a.purchaseId - b.purchaseId || a.id - b.id;

/** 把几张采购单的明细合成订货单的行，并按到货安排算出每段还差多少。 */
export function batchRows(lines: BatchSourceLine[], schedule: ScheduleEntry[] = [], today = ''): BatchRow[] {
  const groups = new Map<string, BatchSourceLine[]>();
  for (const l of [...lines].sort(lineOrder)) {
    const key = batchRowKey(l);
    groups.set(key, [...(groups.get(key) || []), l]);
  }
  return [...groups].map(([key, group]) => {
    const first = group[0];
    const orderedUnits = group.reduce((n, l) => n + l.quantityUnits, 0),
      receivedUnits = group.reduce((n, l) => n + Math.min(l.receivedUnits, l.quantityUnits), 0);
    return {
      key,
      name: first.name,
      specification: batchSpecification(first),
      unit: first.unit,
      priceBasis: first.priceBasis ?? null,
      unitPrice: first.unitPrice ?? null,
      orderedUnits,
      receivedUnits,
      remainingUnits: Math.max(0, orderedUnits - receivedUnits),
      amount: sumMoney(group.map((l) => (l.amount == null ? null : String(l.amount)))),
      notes: [...new Set(group.map((l) => clean(l.notes)).filter(Boolean))].join('；'),
      lines: group,
      schedule: scheduleView(
        schedule.filter((e) => e.rowKey === key),
        orderedUnits,
        receivedUnits,
        today,
      ),
    };
  });
}

/** 一行的到货安排：截止日期早的先扣已到数量；安排的总数不够订购数时补一段“日期未定”。 */
export function scheduleView(
  entries: ScheduleEntry[],
  orderedUnits: number,
  receivedUnits: number,
  today = '',
): ScheduleView[] {
  const sorted = [...entries]
    .filter((e) => e.quantityUnits > 0)
    .sort((a, b) => (a.dueDate ?? NO_DUE_DATE).localeCompare(b.dueDate ?? NO_DUE_DATE));
  let planned = 0;
  const kept: (ScheduleEntry & { implicit?: boolean })[] = [];
  for (const e of sorted) {
    const q = Math.min(e.quantityUnits, orderedUnits - planned);
    if (q <= 0) break;
    kept.push({ ...e, quantityUnits: q });
    planned += q;
  }
  if (planned < orderedUnits)
    kept.push({ rowKey: entries[0]?.rowKey ?? '', quantityUnits: orderedUnits - planned, dueDate: null, implicit: true });
  let left = receivedUnits;
  return kept.map((e) => {
    const got = Math.min(left, e.quantityUnits);
    left -= got;
    const remainingUnits = e.quantityUnits - got;
    return {
      ...e,
      receivedUnits: got,
      remainingUnits,
      state: !remainingUnits ? 'done' : !e.dueDate ? 'undated' : today && e.dueDate < today ? 'overdue' : 'due',
    };
  });
}

/** 一批还差多少、最近的截止日期、有没有逾期。 */
export function batchProgress(rows: BatchRow[]) {
  const pending = rows.flatMap((r) => r.schedule.filter((s) => s.remainingUnits > 0));
  const dated = pending.map((s) => s.dueDate).filter((d): d is string => !!d);
  return {
    state: rows.every((r) => !r.remainingUnits)
      ? ('已到齐' as const)
      : rows.some((r) => r.receivedUnits)
        ? ('部分到货' as const)
        : ('待到货' as const),
    overdue: pending.some((s) => s.state === 'overdue'),
    nextDue: dated.sort().at(0) ?? null,
  };
}

/**
 * 本次到货按行填的数量分到各条采购明细：按采购单先后，每条最多分到它还差的数。
 * 不合格的数量也按同样顺序分（每条不超过分到的数量）。超过这一行还差的数就报错。
 * 实际入库数不给就等于合格数；合格了没全部入库的，少入的数也按同样顺序从各条的合格数里扣。
 */
export function allocateReceipt(
  rows: BatchRow[],
  input: { key: string; quantityUnits: number; rejectedUnits: number; stockedUnits?: number }[],
) {
  const out: { lineId: number; purchaseId: number; quantityUnits: number; rejectedUnits: number; stockedUnits: number }[] = [];
  for (const item of input) {
    if (item.quantityUnits <= 0) continue;
    const row = rows.find((r) => r.key === item.key);
    if (!row) throw new Error('到货的这一行不在订货单里，请刷新后重填。');
    if (item.quantityUnits > row.remainingUnits)
      throw new Error(
        row.name + ' 这次填了 ' + quantityString(item.quantityUnits) + ' ' + row.unit + '，比还没到的 ' +
          quantityString(row.remainingUnits) + ' ' + row.unit + ' 多。多送的部分请单独登记无采购单到货并写明原因。',
      );
    if (item.rejectedUnits < 0 || item.rejectedUnits > item.quantityUnits)
      throw new Error(row.name + ' 的拒收数量不能超过本次实到数量。');
    const acceptedUnits = item.quantityUnits - item.rejectedUnits,
      stockedUnits = item.stockedUnits ?? acceptedUnits;
    if (stockedUnits < 0 || stockedUnits > acceptedUnits)
      throw new Error(row.name + ' 的入库数量不能超过验收合格数量。');
    let left = item.quantityUnits,
      rejected = item.rejectedUnits,
      short = acceptedUnits - stockedUnits;
    for (const l of row.lines) {
      const room = Math.max(0, l.quantityUnits - l.receivedUnits);
      if (!left) break;
      if (!room) continue;
      const q = Math.min(room, left),
        r = Math.min(rejected, q),
        s = Math.min(short, q - r);
      out.push({ lineId: l.id, purchaseId: l.purchaseId, quantityUnits: q, rejectedUnits: r, stockedUnits: q - r - s });
      left -= q;
      rejected -= r;
      short -= s;
    }
  }
  return out;
}

/** 到货安排的一段：数量写成和库存一样的文本，日期可以空。 */
export const scheduleEntrySchema = z.strictObject({
  rowKey: z.string().min(2).max(ROW_KEY_MAX_LENGTH),
  quantity: quantityText,
  dueDate: dateSchema.nullable(),
});
export const batchScheduleSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  schedule: z.array(scheduleEntrySchema).max(MAX_SCHEDULE_ENTRIES),
});
/**
 * 登记到货（server/flow/register-arrival.ts）：人工按送货单登记的当场入库；AI 识别的送货单传 pending，
 * 存成待入库，人核对后入库。每行实到、不合格，可选实际入库（不给就等于合格数）。
 */
export const batchReceiveSchema = z.strictObject({
  /** 订货单的版本；只给了采购单、这张采购单还没有订货单时不用传 */
  expectedVersion: z.number().int().positive().optional(),
  requestId: z.uuid(),
  date: dateSchema,
  actualTime: arrivalTimeSchema,
  /** 供应商送货单号；不填就用内部批次号 */
  reference: z.string().trim().max(100).optional(),
  notes: noteText.default(''),
  /** true：存成待入库，等人核对（AI 识别的送货单）；不传就当场入库 */
  pending: z.boolean().default(false),
  /** 识别的原件（AI 识别的送货单） */
  sourceId: z.uuid().nullable().default(null),
  /** 重新识别后改存到原来那张还没核对的待入库到货单上：它的 id 和版本 */
  arrival: z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() }).optional(),
  rows: z
    .array(
      z.strictObject({
        key: z.string().min(2).max(ROW_KEY_MAX_LENGTH),
        quantity: quantityText,
        rejectedQuantity: quantityText.default('0'),
        stockedQuantity: quantityText.optional(),
        /** 送货单上写的数量、面积和实收对不上的原因（AI 识别的送货单带上，核对时照到货单的规则查） */
        statedQuantity: quantityText.nullable().optional(),
        statedArea: z
          .string()
          .trim()
          .regex(/^(0|[1-9]\d{0,14})(\.\d{1,12})?$/, '面积使用非负十进制数，最多12位小数')
          .nullable()
          .optional(),
        differenceReason: noteText.optional(),
      }),
    )
    .min(1)
    .max(MAX_RECEIVE_ROWS),
});
export const toScheduleEntries = (schedule: z.infer<typeof scheduleEntrySchema>[]): ScheduleEntry[] =>
  schedule.map((s) => ({ rowKey: s.rowKey, quantityUnits: quantityUnits(s.quantity), dueDate: s.dueDate }));
/** 订货单上“交货安排”一栏的文字 */
export function scheduleText(row: BatchRow) {
  const parts = row.schedule.filter((s) => !s.implicit || row.schedule.length > 1);
  if (!parts.some((s) => s.dueDate)) return '日期待定';
  return parts
    .map((s) => (s.dueDate ? s.dueDate.slice(MONTH_DAY_START) + ' 前 ' : '其余 ') + quantityString(s.quantityUnits))
    .join('；');
}
/** 还没写到货安排时按采购单上的预计到货日期排：一行里各采购单的日期都一样才写上。 */
export function defaultSchedule(lines: BatchSourceLine[], expectedDate: (purchaseId: number) => string | null | undefined): ScheduleEntry[] {
  return batchRows(lines).flatMap((r) => {
    const dates = new Set(r.lines.map((l) => expectedDate(l.purchaseId) || null));
    const date = dates.size === 1 ? [...dates][0] : null;
    return date ? [{ rowKey: r.key, quantityUnits: r.orderedUnits, dueDate: date }] : [];
  });
}

/**
 * 今日页“今天要到”：截止日是这天、还没到齐的段，加上已过截止日还没到齐的（逾期，排在前面，再按截止日先后）。
 * batches 是还没到齐的订货单（OrderBatchService.open）；逾期按传进来的 date 算。
 */
export function dueSegments(
  batches: {
    id: number;
    number: string;
    supplierName: string;
    rows: { name: string; unit: string; schedule: { dueDate: string | null; remainingUnits: number }[] }[];
  }[],
  date: string,
) {
  return batches
    .flatMap((b) =>
      b.rows.flatMap((r) =>
        r.schedule.flatMap((s) =>
          s.remainingUnits > 0 && s.dueDate && s.dueDate <= date
            ? [
                {
                  batchId: b.id,
                  batchNumber: b.number,
                  supplierName: b.supplierName,
                  name: r.name,
                  unit: r.unit,
                  dueDate: s.dueDate,
                  remainingUnits: s.remainingUnits,
                  overdue: s.dueDate < date,
                },
              ]
            : [],
        ),
      ),
    )
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueDate.localeCompare(b.dueDate) || a.batchId - b.batchId);
}
