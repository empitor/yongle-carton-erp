import { dateSchema, today } from './domain.js';
import {
  normalizeDimensionUnit,
  normalizedDimensions,
  hasCompleteProductIdentity,
} from './product-details.js';
import { formatStockSize } from './operations.js';
export type ListResult<T, M = Record<string, never> | null> = {
  rows: T[];
  totalRecords: number;
  metrics: M;
};
export const pendingOrder = (row: { status: string }) =>
  ['已确认', '生产中', '待发货'].includes(row.status);
const pastDate = (value: unknown, date: string) =>
  typeof value === 'string' && dateSchema.safeParse(value).success && value < date;
export function orderMetrics(rows: { status: string; deliveryDate?: unknown }[], date = today()) {
  return {
    total: rows.length,
    pending: rows.filter(pendingOrder).length,
    overdue: rows.filter((r) => pendingOrder(r) && pastDate(r.deliveryDate, date)).length,
  };
}
export function pendingPurchase(row: any) {
  return (
    (row.businessStatus || row.status) !== '已取消' &&
    row.lines.some((line: any) =>
      line.remainingUnits === undefined
        ? line.quantityUnits > line.receivedUnits
        : line.remainingUnits > 0,
    )
  );
}
export function purchaseMetrics(rows: any[], date = today()) {
  return {
    total: rows.length,
    pending: rows.filter(pendingPurchase).length,
    overdue: rows.filter((r) => pendingPurchase(r) && pastDate(r.expectedDate, date)).length,
  };
}
export const productIncomplete = (row: any) => !hasCompleteProductIdentity(row);
export function productMetrics(rows: any[]) {
  return {
    total: rows.length,
    enabled: rows.filter((r) => !r.archived).length,
    incomplete: rows.filter(productIncomplete).length,
  };
}
export function matchesProduct(row: any, q: string) {
  return [row.name, row.material, row.flute, row.requirements]
    .join(' ')
    .toLowerCase()
    .includes(q.toLowerCase());
}
export function matchesOperationalRecord(row: any, q = '') {
  return [
    row.name,
    row.number,
    row.supplierName,
    row.specification,
    row.material,
    row.flute,
    row.contact,
    row.phone,
    row.address,
    row.notes,
    ...(row.lines || []).map((line: any) => line.name),
  ]
    .join(' ')
    .toLowerCase()
    .includes(q.toLowerCase());
}
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
export function inventoryMetrics(rows: any[], kind: 'raw' | 'finished') {
  const items = rows.filter((r) => r.kind === kind),
    positive = items.filter((r) => r.balanceUnits > 0),
    quantities = new Map<string, bigint>(),
    variants = new Set<string>();
  let area = 0n,
    scale = 0,
    converted = 0,
    excluded = 0;
  for (const row of items)
    quantities.set(row.unit, (quantities.get(row.unit) || 0n) + BigInt(row.balanceUnits));
  for (const row of positive) {
    const unit = normalizeDimensionUnit(row.dimensionUnit),
      dimensions = normalizedDimensions(row);
    const knownShape =
      !!row.material?.trim() &&
      !!row.flute?.trim() &&
      ((unit && row.length > 0 && row.width > 0) || !!row.specification?.trim());
    const shape = [
      row.unit,
      row.material?.trim(),
      row.flute?.trim(),
      row.specification?.trim(),
      unit ? dimensions : [row.length, row.width, row.height, row.dimensionUnit],
    ];
    variants.add(
      JSON.stringify(
        kind === 'raw' && knownShape
          ? shape
          : kind === 'finished' && row.productId
            ? [row.productId, ...shape]
            : ['stock-item', row.id],
      ),
    );
    if (kind !== 'raw') continue;
    let term: bigint, termScale: number;
    if (['平方米', '㎡', 'm²', 'm2'].includes(String(row.unit).trim().toLowerCase())) {
      term = BigInt(row.balanceUnits);
      termScale = 3;
    } else if (
      row.unit === '张' &&
      unit &&
      Number.isFinite(row.length) &&
      row.length > 0 &&
      Number.isFinite(row.width) &&
      row.width > 0
    ) {
      const l = decimal(row.length),
        w = decimal(row.width);
      term = l.coefficient * w.coefficient * BigInt(row.balanceUnits);
      termScale = l.scale + w.scale + (unit === 'mm' ? 6 : 4) + 3;
    } else {
      excluded++;
      continue;
    }
    const nextScale = Math.max(scale, termScale);
    area = area * 10n ** BigInt(nextScale - scale) + term * 10n ** BigInt(nextScale - termScale);
    scale = nextScale;
    converted++;
  }
  return {
    varieties: variants.size,
    areaSquareMetres: decimalText(area, scale),
    areaConverted: converted,
    areaExcluded: excluded,
    quantities: [...quantities].map(([unit, value]) => ({ unit, quantity: decimalText(value, 3) })),
    lowStockConfigured: false as const,
    lowStockCount: null,
  };
}
export type InventoryMetrics = ReturnType<typeof inventoryMetrics>;
export function summarizeMovements(rows: any[], items: any[]) {
  const catalogue = new Map(items.map((i) => [i.id, i])),
    groups = new Map<
      number,
      {
        itemId: number;
        name: string;
        specification: string;
        kind: string;
        unit: string;
        incomingUnits: bigint;
        outgoingUnits: bigint;
        currentQuantity: string;
        archived: boolean;
      }
    >();
  for (const item of items)
    groups.set(item.id, {
      itemId: item.id,
      name: item.name,
      specification: item.specification || formatStockSize(item),
      kind: item.kind,
      unit: item.unit,
      incomingUnits: 0n,
      outgoingUnits: 0n,
      currentQuantity: item.quantity,
      archived: !!item.archived,
    });
  for (const row of rows) {
    const item = catalogue.get(Number(row.item_id));
    if (!item) throw new Error('流水关联库存品不存在');
    const group = groups.get(item.id) || {
      itemId: item.id,
      name: item.name,
      specification: row.itemSpecification || '',
      kind: item.kind,
      unit: item.unit,
      incomingUnits: 0n,
      outgoingUnits: 0n,
      currentQuantity: item.quantity,
      archived: !!item.archived,
    };
    const delta = BigInt(row.delta_units);
    if (delta > 0n) group.incomingUnits += delta;
    else group.outgoingUnits -= delta;
    groups.set(item.id, group);
  }
  return [...groups.values()].map(({ incomingUnits, outgoingUnits, ...group }) => ({
    ...group,
    incoming: decimalText(incomingUnits, 3),
    outgoing: decimalText(outgoingUnits, 3),
  }));
}
export type MovementSummary = ReturnType<typeof summarizeMovements>;
