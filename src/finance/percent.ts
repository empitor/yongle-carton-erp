/* 比例（税率、残值率）：库里按基点存（1.5% 存 150），只用整数换算，不用浮点乘除。 */

/** 填的“1.5”换成 150；最多两位小数，填错时提示说的是哪一项比例。 */
export function percentToBp(text: string, label: string) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) throw new Error(label + '只能填数字，最多两位小数：' + text);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 150 写成“1.5”，300 写成“3” */
export function bpText(bp: number) {
  const whole = Math.trunc(Math.abs(bp) / 100),
    fraction = String(Math.abs(bp) % 100).padStart(2, '0').replace(/0+$/, '');
  return (bp < 0 ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

/** 两个数的比值写成百分数（只用来显示，例如现结优惠折合年化） */
export const percentOf = (numerator: unknown, denominator: unknown) =>
  denominator ? (Number(numerator) / Number(denominator)).toFixed(2) + '%' : '—';
