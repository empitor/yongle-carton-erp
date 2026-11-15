import { centsText } from '../../shared/core/index';

/** 金额（分）给人看：“1,234.50”，写法就是 shared/core 的 centsText；没有值、不是数写“—”。 */
export function yuan(cents: unknown) {
  if (cents === null || cents === undefined || cents === '') return '—';
  const n = Number(cents);
  return Number.isFinite(n) ? centsText(n) : '—';
}
/** “1,234.5” 转 123450。超过两位小数或不是数字时抛错，不四舍五入。 */
export function toCents(text: string) {
  const v = text.replace(/[,，\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new Error('金额只能填数字，最多两位小数：' + text);
  const n = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new Error('金额太大：' + text);
  return m[1] ? -n : n;
}
/** 金额（分）放进输入框的写法：“1234.50”，不带千分位；没有值是空串。给人看的用 yuan。 */
export const centsInput = (c: unknown) =>
  c === null || c === undefined || c === '' ? '' : yuan(c).replace(/,/g, '');

