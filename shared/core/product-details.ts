import { z } from 'zod';
import { fieldLabel } from './field-names.js';
export type DimensionUnit = 'mm' | 'cm';
/** 名称后带所属客户：只有客户名非空时才带括号（成品库存、产品修改卡片、送货安排等共用） */
export function nameWithCustomer(name: string, customerName?: string | null) {
  const who = customerName?.trim();
  return who ? name + '（' + who + '）' : name;
}
/** 尺寸单位的叫法：选择、说单位本身时写全“毫米（mm）”；跟在尺寸数值后面照旧写 mm、cm */
export const dimensionUnitNames: Record<DimensionUnit, string> = { mm: '毫米（mm）', cm: '厘米（cm）' };
/** 规格字段：规格说明、长宽高和尺寸单位、材质、楞型（都可以没写）。产品、纸板、订货单行、查重都用这一组。 */
export type SpecFields = {
  specification?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string | null;
  material?: string | null;
  flute?: string | null;
};
/** 认产品身份用到的字段（产品、识别出来的产品定义都有，都可以没写） */
export type ProductIdentity = SpecFields & {
  name?: string | null;
  dimensionUnitRaw?: string | null;
  requirements?: string | null;
  customerProductCode?: string | null;
};
export const dimensionKeys = ['length', 'width', 'height'] as const;
/** 长、宽、高的上限（数值本身，不分单位） */
const MAX_DIMENSION = 10000;
/** 厘米尺寸的上限（1000cm，等于 10000mm）：产品资料、识别核对、正式导入都按它拦 */
export const MAX_CM_DIMENSION = 1000;
export const dimensionValueSchema = z
  .number()
  .positive('尺寸必须大于零，未提供请留空')
  .max(MAX_DIMENSION, '尺寸超出允许范围')
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
/** 尺寸单位只收毫米、厘米：产品、库存品、采购明细同一份 */
export const dimensionUnitSchema = z.enum(['mm', 'cm'], { error: '尺寸单位只能选毫米或厘米' });
type CmSized = { dimensionUnit?: DimensionUnit | null; length: number | null; width: number | null; height: number | null };
/** 按厘米填的尺寸不能超过 MAX_CM_DIMENSION：产品、库存品、采购明细同一条规则、同一句提示 */
export const withinCmLimit = (v: CmSized) =>
  v.dimensionUnit !== 'cm' || [v.length, v.width, v.height].every((n) => n === null || n <= MAX_CM_DIMENSION);
export const cmLimitIssue = {
  message: '厘米尺寸不能超过' + MAX_CM_DIMENSION + 'cm（等于' + String(convertDimension(MAX_CM_DIMENSION, 'cm', 'mm')) + 'mm）',
  path: ['dimensionUnit'],
};
export function normalizedDimensions(p: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: unknown;
}) {
  const unit = normalizeDimensionUnit(p.dimensionUnit);
  return dimensionKeys.map((k) => {
    const value = p[k];
    return value === null || value === undefined ? null : unit ? convertDimension(value, unit, 'mm') : value;
  });
}
/** 长、宽、高都是正数 */
const hasAllDimensions = (p: SpecFields) =>
  dimensionKeys.every((k) => {
    const value = p[k];
    return typeof value === 'number' && value > 0;
  });
export function hasCompleteProductIdentity(p: SpecFields) {
  return !!normalizeDimensionUnit(p.dimensionUnit) && hasAllDimensions(p) && !!p.material?.trim() && !!p.flute?.trim();
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
    for (const k of ['length', 'width', 'height', 'material', 'flute'] as const)
      if (p[k] === null || p[k] === undefined || p[k] === '') g.missing.add(fieldLabel(k));
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
// 与正式导入相同的完整身份；仅移动共用比较，不改变既有指纹内容。
/**
 * 同一批导入里，后面的文件能不能复用前面刚建的产品。真实订单经常不写材质，加工要求每份也不一样，
 * 所以只看名称和尺寸相同、材质楞型料号没有冲突。没有尺寸的不算，不猜。
 */
export function sameProductInBatch(a: ProductIdentity, b: ProductIdentity) {
  const nameA = productIdentityParts(a)[0];
  if (!nameA || nameA !== productIdentityParts(b)[0]) return false;
  // 原件没写单位时，两边都没写、数字又一样才算
  if (!normalizeDimensionUnit(a.dimensionUnit) !== !normalizeDimensionUnit(b.dimensionUnit)) return false;
  if (!hasAllDimensions(a) || !hasAllDimensions(b)) return false;
  if (normalizedDimensions(a).join() !== normalizedDimensions(b).join()) return false;
  const text = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, '').toLowerCase();
  return (['material', 'flute', 'customerProductCode'] as const).every((k) => {
    const x = text(a[k]),
      y = text(b[k]);
    return !x || !y || x === y;
  });
}
export function productIdentityParts(p: ProductIdentity) {
  const key = (s: string) => s.trim().replace(/\s+/g, '').toLowerCase();
  return [
    key(p.name || ''),
    ...normalizedDimensions(p),
    normalizeDimensionUnit(p.dimensionUnit) ? 'known' : p.dimensionUnitRaw || 'unknown',
    key(p.material || ''),
    key(p.flute || ''),
    key(p.requirements || ''),
    key(p.customerProductCode || ''),
  ];
}
