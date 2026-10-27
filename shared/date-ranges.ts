import { today } from './domain.js';
export type DatePreset = '1' | '2' | '3' | 'all' | 'custom';
export type OrderView = 'current' | 'pending' | 'history';
// 按自然月回退；月末夹取目标月最后一天，使用UTC避免本机时区/夏令时偏移。
export function monthsBefore(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
export function presetRange(preset: DatePreset, date = today()) {
  return ['1', '2', '3'].includes(preset)
    ? { start: monthsBefore(date, Number(preset)), end: date }
    : { start: '', end: '' };
}
export const closedOrder = (status: string) => status === '已发货' || status === '已取消';
export function orderInView(
  order: { orderDate: string; status: string },
  query: {
    view?: OrderView;
    start?: string;
    end?: string;
    retainPending?: boolean;
  },
  date = today(),
) {
  const closed = closedOrder(order.status);
  if (query.view === 'history' && !(closed && order.orderDate < monthsBefore(date, 2)))
    return false;
  if (query.view === 'pending' && closed) return false;
  if (query.end && order.orderDate > query.end) return false;
  return (
    !query.start ||
    order.orderDate >= query.start ||
    (query.view === 'current' && !!query.retainPending && !closed)
  );
}
