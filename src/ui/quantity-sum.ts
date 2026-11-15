import { quantityString, quantityUnits } from '../../shared/core/index';

/**
 * 按单位分别合计（千分整数相加，不出浮点尾差）；不同单位不相加，各写各的，例如“1200 张”“300 只、5 箱”。
 * 空着的算 0；有填错的数字返回“—”。登记完工、批量登记到货的“合计”都用它。
 */
export function sumByUnit(rows: { value: string; unit: string }[]) {
  const totals = new Map<string, number>();
  try {
    for (const r of rows)
      totals.set(
        r.unit,
        (totals.get(r.unit) || 0) + quantityUnits(String(r.value || '0').trim() || '0'),
      );
  } catch {
    return '—';
  }
  if (!totals.size) return '—';
  return [...totals].map(([unit, n]) => quantityString(n) + (unit ? ' ' + unit : '')).join('、');
}
