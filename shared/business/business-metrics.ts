import { QUANTITY_DECIMALS, dateSchema, deliverableOrder, today, type SpecFields } from '../core/index.js';
import { normalizeDimensionUnit, normalizedDimensions, hasCompleteProductIdentity } from '../core/index.js';
import { formatStockSize } from './operations.js';
import { SQUARE_METRE_SHIFT } from './limits.js';
import type { MaybeText } from './display-text.js';
export type ListResult<T, M = Record<string, never> | null> = {
  rows: T[];
  totalRecords: number;
  metrics: M;
  /** 筛选后的总条数；分页时 rows 只是其中一页。 */
  filteredRecords: number;
  page?: number;
  pageSize?: number;
};
const pastDate = (value: unknown, date: string) =>
  typeof value === 'string' && dateSchema.safeParse(value).success && value < date;
export function orderMetrics(rows: { status: string; deliveryDate?: unknown }[], date = today()) {
  return {
    total: rows.length,
    pending: rows.filter(deliverableOrder).length,
    overdue: rows.filter((r) => deliverableOrder(r) && pastDate(r.deliveryDate, date)).length,
  };
}
/** 判断采购单还差没到要用的：状态和每行订购、已到、还差的数量（千分整数；没给还差的按订购减已到） */
type PurchaseProgress = {
  businessStatus?: string | null;
  status?: string | null;
  expectedDate?: unknown;
  lines: { quantityUnits: number; receivedUnits: number; remainingUnits?: number }[];
};
export function pendingPurchase(row: PurchaseProgress) {
  return (
    (row.businessStatus || row.status) !== '已取消' &&
    row.lines.some((line) =>
      line.remainingUnits === undefined
        ? line.quantityUnits > line.receivedUnits
        : line.remainingUnits > 0,
    )
  );
}
export function purchaseMetrics(rows: PurchaseProgress[], date = today()) {
  return {
    total: rows.length,
    pending: rows.filter(pendingPurchase).length,
    overdue: rows.filter((r) => pendingPurchase(r) && pastDate(r.expectedDate, date)).length,
  };
}
export const productIncomplete = (row: SpecFields) => !hasCompleteProductIdentity(row);
export function productMetrics(rows: (SpecFields & { archived?: unknown })[]) {
  return {
    total: rows.length,
    enabled: rows.filter((r) => !r.archived).length,
    incomplete: rows.filter(productIncomplete).length,
  };
}
export function matchesProduct(
  row: { name?: MaybeText; customerName?: MaybeText; material?: MaybeText; flute?: MaybeText; requirements?: MaybeText },
  q: string,
) {
  return [row.name, row.customerName, row.material, row.flute, row.requirements]
    .join(' ')
    .toLowerCase()
    .includes(q.toLowerCase());
}
/** 客户、供应商共用的搜索文字：名称、联系方式和备注 */
type PartySearchText = {
  name?: MaybeText;
  contact?: MaybeText;
  phone?: MaybeText;
  address?: MaybeText;
  notes?: MaybeText;
};
/** 客户、供应商、库存品的关键词搜索要看的文字 */
type OperationalText = PartySearchText & {
  number?: MaybeText;
  customerName?: MaybeText;
  supplierName?: MaybeText;
  specification?: MaybeText;
  material?: MaybeText;
  flute?: MaybeText;
};
/**
 * 一条记录能被搜到的文字（小写）：列表按整句找，命令面板按几个词都要有。
 * 没填、这类记录没有的栏目不拼进去，字段之间只隔一个空格，“公司名 联系人”这种跨栏的整句才搜得到。
 */
export function operationalSearchText(row: OperationalText) {
  return [
    row.name,
    row.number,
    row.customerName,
    row.supplierName,
    row.specification,
    row.material,
    row.flute,
    row.contact,
    row.phone,
    row.address,
    row.notes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
export const matchesOperationalRecord = (row: OperationalText, q = '') =>
  operationalSearchText(row).includes(q.toLowerCase());
// 以BigInt十进制累加面积，避免毫米/厘米与小数数量换算引入浮点误差。
function decimal(value: number) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e'),
    [whole, fraction = ''] = mantissa.split('.');
  let coefficient = BigInt(whole + fraction),
    scale = fraction.length - Number(exponent);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}
function decimalText(value: bigint, scale: number) {
  const digits = value.toString().padStart(scale + 1, '0');
  return scale
    ? (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '')
    : digits;
}
/** 库存统计要用的库存品资料：种类、结余（千分整数）、单位和规格 */
type InventoryRow = SpecFields & { id: number; kind: string; unit: string; balanceUnits: number; productId?: number | null };
const finitePositive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
/**
 * 算“有几种”时一个库存品归哪一种：原材料材质、楞型和尺寸（或规格说明）都写了的按实物算，一样的是一种；
 * 成品按产品和实物算；别的一个库存品一种。
 */
function varietyKey(row: InventoryRow, kind: 'raw' | 'finished') {
  const unit = normalizeDimensionUnit(row.dimensionUnit);
  const knownShape =
    !!row.material?.trim() &&
    !!row.flute?.trim() &&
    ((unit && (row.length ?? 0) > 0 && (row.width ?? 0) > 0) || !!row.specification?.trim());
  const shape = [
    row.unit,
    row.material?.trim(),
    row.flute?.trim(),
    row.specification?.trim(),
    unit ? normalizedDimensions(row) : [row.length, row.width, row.height, row.dimensionUnit],
  ];
  return JSON.stringify(
    kind === 'raw' && knownShape
      ? shape
      : kind === 'finished' && row.productId
        ? [row.productId, ...shape]
        : ['stock-item', row.id],
  );
}
/** 精确的十进制数：整数值和小数位数 */
type Decimal = { value: bigint; scale: number };
/** 原材料一个库存品的面积（长 × 宽 × 张数，平方米）；尺寸或尺寸单位不全的是 null */
function sheetAreaOf(row: InventoryRow): Decimal | null {
  const unit = normalizeDimensionUnit(row.dimensionUnit);
  if (!unit || !finitePositive(row.length) || !finitePositive(row.width)) return null;
  const l = decimal(row.length),
    w = decimal(row.width);
  return {
    value: l.coefficient * w.coefficient * BigInt(row.balanceUnits),
    scale: l.scale + w.scale + SQUARE_METRE_SHIFT[unit] + QUANTITY_DECIMALS,
  };
}
const addDecimal = (sum: Decimal, term: Decimal): Decimal => {
  const scale = Math.max(sum.scale, term.scale);
  return { value: sum.value * 10n ** BigInt(scale - sum.scale) + term.value * 10n ** BigInt(scale - term.scale), scale };
};
export function inventoryMetrics(rows: InventoryRow[], kind: 'raw' | 'finished') {
  const items = rows.filter((r) => r.kind === kind),
    positive = items.filter((r) => r.balanceUnits > 0),
    quantities = new Map<string, bigint>();
  for (const row of items)
    quantities.set(row.unit, (quantities.get(row.unit) || 0n) + BigInt(row.balanceUnits));
  // 原材料只有“张”（数据库约束）：面积 = 长 × 宽 × 张数；尺寸或尺寸单位不全的不算
  const areas = kind === 'raw' ? positive.map(sheetAreaOf) : [],
    counted = areas.filter((a) => a !== null),
    area = counted.reduce(addDecimal, { value: 0n, scale: 0 });
  return {
    varieties: new Set(positive.map((row) => varietyKey(row, kind))).size,
    areaSquareMetres: decimalText(area.value, area.scale),
    areaConverted: counted.length,
    areaExcluded: areas.length - counted.length,
    quantities: [...quantities].map(([unit, value]) => ({ unit, quantity: decimalText(value, QUANTITY_DECIMALS) })),
    lowStockConfigured: false as const,
    lowStockCount: null,
  };
}
/** 流水汇总要用的库存品：名称、种类、单位、现有数量，没写规格说明时用尺寸 */
type MovementItem = Parameters<typeof formatStockSize>[0] & {
  id: number;
  name: string;
  specification?: string | null;
  kind: string;
  unit: string;
  quantity: string;
  archived?: unknown;
};
/** 一笔流水：哪个库存品、变动多少（千分整数，入库为正） */
type MovementTotal = { item_id: number | string; delta_units: number | string | bigint };
export function summarizeMovements(rows: readonly MovementTotal[], items: readonly MovementItem[]) {
  const groups = new Map(
    items.map((item) => [
      item.id,
      {
        itemId: item.id,
        name: item.name,
        specification: item.specification || formatStockSize(item),
        kind: item.kind,
        unit: item.unit,
        incomingUnits: 0n,
        outgoingUnits: 0n,
        currentQuantity: item.quantity,
        archived: !!item.archived,
      },
    ]),
  );
  for (const row of rows) {
    const group = groups.get(Number(row.item_id));
    if (!group) throw new Error('流水关联库存品不存在');
    const delta = BigInt(row.delta_units);
    if (delta > 0n) group.incomingUnits += delta;
    else group.outgoingUnits -= delta;
  }
  return [...groups.values()].map(({ incomingUnits, outgoingUnits, ...group }) => ({
    ...group,
    incoming: decimalText(incomingUnits, QUANTITY_DECIMALS),
    outgoing: decimalText(outgoingUnits, QUANTITY_DECIMALS),
  }));
}
export type MovementSummary = ReturnType<typeof summarizeMovements>;
