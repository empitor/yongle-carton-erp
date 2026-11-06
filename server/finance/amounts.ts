import { precisionTotal, exactText } from '../../shared/precision.js';
import { financeError } from './core.js';

type Rational = { numerator: bigint; denominator: bigint };
const zero = { numerator: 0n, denominator: 1n };
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
  const n = (value.numerator * 200n + value.denominator) / (value.denominator * 2n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) financeError('单据金额超出可保存范围。');
  return Number(n);
}

export function deliveryLineExact(quantity: string, unitPriceExact: string) {
  const q = /^(\d+)(?:\.(\d{1,3}))?$/.exec(quantity);
  if (!q) financeError('数量单位无法换算。');
  const units = BigInt(q[1] + (q[2] ?? '').padEnd(3, '0'));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) financeError('数量超出可保存范围。');
  return exactText(
    precisionTotal([{ quantity: Number(units), unitPriceExact, unitPriceCents: 0 }]).units,
    7,
  );
}

export function documentMoney(lines: { exact: string; mode: string; rate: string }[]) {
  const amounts = lines.map(({ exact, mode, rate }) => {
    if (!['含税', '未税', '不含税'].includes(mode)) financeError('含税口径未明确。');
    if (!rate) financeError('缺少税率。');
    const r = decimal(rate.replace(/%$/, ''));
    if (r.numerator > 100n * r.denominator) financeError('税率超出范围。');
    const base = decimal(exact);
    const denominator = r.denominator * 100n;
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
      const scaled = numerator * 100n;
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
