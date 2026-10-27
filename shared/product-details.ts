import { z } from 'zod';
export type DimensionUnit = 'mm' | 'cm';
export const dimensionKeys = ['length', 'width', 'height'] as const;
export const dimensionValueSchema = z
  .number()
  .finite()
  .positive('尺寸必须大于零，未提供请留空')
  .max(10000, '尺寸超出允许范围')
  .nullable()
  .default(null);
export function normalizeDimensionUnit(raw: unknown): DimensionUnit | null {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return ['mm', '毫米'].includes(s) ? 'mm' : ['cm', '厘米', '公分'].includes(s) ? 'cm' : null;
}
export function parseDimension(raw: unknown): number | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return null;
  if (typeof raw === 'string' && !/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()))
    throw new Error('尺寸必须是有效正数，未提供请留空');
  return dimensionValueSchema.parse(typeof raw === 'number' ? raw : Number(raw));
}
// 十进制移动小数点，避免0.29*10出现2.899999999之类显示误差。
export function shiftDecimal(value: number, places: number): number {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e'),
    [whole, fraction = ''] = coefficient.split('.'),
    digits = whole + fraction,
    position = whole.length + Number(exponent) + places;
  const text =
    position <= 0
      ? '0.' + '0'.repeat(-position) + digits
      : position >= digits.length
        ? digits + '0'.repeat(position - digits.length)
        : digits.slice(0, position) + '.' + digits.slice(position);
  return Number(text);
}
export function convertDimension(
  value: number | null,
  from: DimensionUnit,
  to: DimensionUnit,
): number | null {
  if (value === null || from === to) return value;
  const converted = shiftDecimal(value, from === 'cm' ? 1 : -1);
  if (!Number.isFinite(converted) || converted === 0)
    throw new Error('尺寸换算超出可表示的精度，请核对数值');
  return converted;
}
export function normalizedDimensions(p: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: unknown;
}) {
  const unit = normalizeDimensionUnit(p.dimensionUnit);
  return dimensionKeys.map((k) =>
    p[k] === null || p[k] === undefined ? null : unit ? convertDimension(p[k]!, unit, 'mm') : p[k],
  );
}
export function hasCompleteProductIdentity(p: any) {
  return (
    !!normalizeDimensionUnit(p.dimensionUnit) &&
    dimensionKeys.every((k) => typeof p[k] === 'number' && p[k] > 0) &&
    !!p.material?.trim() &&
    !!p.flute?.trim()
  );
}
export function uniqueMessages(values: Iterable<string>) {
  return [...new Set([...values].map((v) => v.trim()).filter(Boolean))];
}
export function productNotices(
  products: {
    name?: string | null;
    length?: number | null;
    width?: number | null;
    height?: number | null;
    material?: string | null;
    flute?: string | null;
    dimensionUnit?: unknown;
    dimensionUnitRaw?: string;
  }[],
): string[] {
  const groups = new Map<string, { missing: Set<string>; unknown: boolean }>();
  for (const p of products) {
    const name = p.name?.trim() || '未命名产品',
      g = groups.get(name) || { missing: new Set<string>(), unknown: false };
    for (const [k, label] of [
      ['length', '长'],
      ['width', '宽'],
      ['height', '高'],
      ['material', '配纸/材质'],
      ['flute', '类型/楞型'],
    ] as const)
      if (p[k] === null || p[k] === undefined || p[k] === '') g.missing.add(label);
    if (!normalizeDimensionUnit(p.dimensionUnit)) g.unknown = true;
    groups.set(name, g);
  }
  return [...groups].flatMap(([name, g]) => [
    ...(g.missing.size ? [`产品“${name}”资料可后续补充：${[...g.missing].join('、')}。`] : []),
    ...(g.unknown ? [`产品“${name}”尺寸单位待确认，未自动换算，不影响本次导入。`] : []),
  ]);
}
export function formatDimensions(p: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: unknown;
}) {
  const values = dimensionKeys.map((k) => p[k] ?? '—'),
    unit = normalizeDimensionUnit(p.dimensionUnit);
  return values.join(' × ') + (unit ? ' ' + unit : '（尺寸单位待确认）');
}
