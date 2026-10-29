import { quantityUnits, quantityString } from './operations.js';
import { flowStatusLabel } from './physical-flow.js';

// 纯日期运算使用UTC，不受浏览器/服务器本地时区和夏令时影响。
export function shiftDate(date: string, days: number) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  if (d.getUTCFullYear() > 9999) return '9999-12-31';
  if (d.getUTCFullYear() < 0) return '0000-01-01';
  return d.toISOString().slice(0, 10);
}
export const planDate = (r: any): string => r.plannedDate || r.date;
export function scheduleSummary(rows: any[], unitForStock: (id: number) => string = () => '') {
  const active = rows.filter((r) => !r.archived && !['cancelled', 'reversed'].includes(r.status));
  const completed = active.filter((r) =>
    r.kind === 'task' ? flowStatusLabel(r) === '已完工' : r.status === 'confirmed',
  ).length;
  const quantities = new Map<string, number>();
  for (const row of active) {
    const lines = row.kind === 'task' ? [row] : row.lines || [];
    for (const l of lines) {
      const unit = l.unit || unitForStock(l.stockId) || '单位待核对';
      quantities.set(unit, (quantities.get(unit) || 0) + quantityUnits(l.quantity));
    }
  }
  return {
    total: active.length,
    completed,
    pending: active.length - completed,
    quantities: [...quantities]
      .map(([unit, units]) => `${quantityString(units)} ${unit}`)
      .join(' / '),
  };
}
