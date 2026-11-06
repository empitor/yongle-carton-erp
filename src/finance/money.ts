/** 金额：只做整数分和字符串转换，不做浮点相乘。 */
export function yuan(cents: unknown) {
  if (cents === null || cents === undefined || cents === '') return '—';
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n),
    whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + whole + '.' + String(abs % 100).padStart(2, '0');
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
export const centsText = (c: unknown) =>
  c === null || c === undefined || c === '' ? '' : yuan(c).replace(/,/g, '');
export const percentOf = (numerator: unknown, denominator: unknown) =>
  denominator ? (Number(numerator) / Number(denominator)).toFixed(2) + '%' : '—';

