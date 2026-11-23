import { z } from 'zod';
import { CENTS_PER_YUAN, roundedQuotient } from '../../../shared/core/index.js';
import { storedTaxModes } from '../../../shared/finance/index.js';
import { financeError } from './core.js';

/** 比例写成百分数文字：最多三位整数、六位小数（“13”“0.5”“36.5”），算的时候放大成整数 */
const PERCENT_DECIMALS = 6;
export const PERCENT_SCALE = 10n ** BigInt(PERCENT_DECIMALS);
/** 100% 放大以后的整数 */
export const HUNDRED_PERCENT = BigInt(100) * PERCENT_SCALE;
export const percentage = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,6})?$/)
  .refine((v) => /^\d{1,3}(\.\d{1,6})?$/.test(v) && percent(v) <= HUNDRED_PERCENT);
export function percent(v: string) {
  const [a, b = ''] = v.split('.');
  return BigInt(a + b.padEnd(PERCENT_DECIMALS, '0'));
}
export function percentCents(amount: number | bigint, rate: string, numerator = 1, denominator = 1) {
  const d = HUNDRED_PERCENT * BigInt(denominator);
  return safeCents(roundedQuotient(BigInt(amount) * percent(rate) * BigInt(numerator), d));
}

type Rational = { numerator: bigint; denominator: bigint };
const zero = { numerator: 0n, denominator: 1n };
/** 税率是百分数（13 就是 13%） */
const PERCENT = 100n;
function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}
function ratio(numerator: bigint, denominator: bigint) {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function add(a: Rational, b: Rational) {
  return ratio(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
function decimal(value: string) {
  const parts = /^(\d{1,24})(?:\.(\d{1,24}))?$/.exec(value);
  if (!parts) financeError('缺少或无法解析精确金额。');
  const [, whole, fraction = ''] = parts;
  return ratio(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}
function cents(value: Rational) {
  const n = roundedQuotient(value.numerator * CENTS_PER_YUAN, value.denominator);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) financeError('单据金额超出可保存范围。');
  return Number(n);
}

export function documentMoney(lines: { exact: string; mode: string; rate: string }[]) {
  const amounts = lines.map(({ exact, mode, rate }) => {
    if (!storedTaxModes.some((m) => m === mode)) financeError('含税口径未明确。');
    if (!rate) financeError('缺少税率。');
    const r = decimal(rate.replace(/%$/, ''));
    if (r.numerator > PERCENT * r.denominator) financeError('税率超出范围。');
    const base = decimal(exact);
    const denominator = r.denominator * PERCENT;
    const numerator = denominator + r.numerator;
    const net =
      mode === '含税' ? ratio(base.numerator * denominator, base.denominator * numerator) : base;
    const gross =
      mode === '含税' ? base : ratio(base.numerator * numerator, base.denominator * denominator);
    return { net, gross, exact };
  });
  const net = cents(amounts.reduce((a, l) => add(a, l.net), zero));
  const gross = cents(amounts.reduce((a, l) => add(a, l.gross), zero));
  const split = (key: 'net' | 'gross', total: number) => {
    const fractions = amounts.map((line, i) => {
      const { numerator, denominator } = line[key];
      const scaled = numerator * CENTS_PER_YUAN;
      return { i, whole: scaled / denominator, remainder: scaled % denominator, denominator };
    });
    const result = fractions.map((line) => Number(line.whole));
    const count = Number(BigInt(total) - fractions.reduce((sum, line) => sum + line.whole, 0n));
    fractions.sort((a, b) => {
      const delta = a.remainder * b.denominator - b.remainder * a.denominator;
      return delta === 0n ? a.i - b.i : delta > 0n ? -1 : 1;
    });
    for (const line of fractions.slice(0, count)) result[line.i]++;
    return result;
  };
  const nets = split('net', net),
    grosses = split('gross', gross);
  // 两次独立取整在跨行税率不同时可能把一分税挪到另一行。
  // 保持两项整单金额，并优先用同单有正税额的行补足，避免负税额。
  let donor = 0;
  for (let i = 0; i < nets.length; i++) {
    if (grosses[i] >= nets[i]) continue;
    while (grosses[donor] <= nets[donor]) donor++;
    grosses[donor]--;
    grosses[i]++;
  }
  const rounded = amounts.map((line, index) => {
    const lineNet = nets[index],
      lineGross = grosses[index];
    return { exact: line.exact, net: lineNet, gross: lineGross, tax: lineGross - lineNet };
  });
  return { net, gross, tax: gross - net, lines: rounded };
}

export function theoreticalMoney(lines: { exact: string }[]) {
  return documentMoney(lines.map(({ exact }) => ({ exact, mode: '未税', rate: '0' })));
}

/** 大整数转回普通数字，超出能精确保存的范围就报错 */
export function safeCents(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    financeError('金额超出可精确保存的范围。');
  return Number(value);
}
export function proportion(amount: number, numerator: number, denominator: number) {
  if (denominator <= 0 || numerator < 0) financeError('无有效分摊基数。');
  return safeCents(roundedQuotient(BigInt(amount) * BigInt(numerator), BigInt(denominator)));
}
