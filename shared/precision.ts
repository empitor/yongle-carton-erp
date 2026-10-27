// 单价按万分之一元计算；不使用浮点乘法计算订单金额。
export function priceUnits(value: string): bigint {
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,4})?$/.test(value))
    throw new Error('单价必须为非负数，最多四位小数');
  const [a, b = ''] = value.split('.');
  return BigInt(a) * 10000n + BigInt(b.padEnd(4, '0'));
}
export function exactText(units: bigint, scale = 4) {
  const s = units.toString().padStart(scale + 1, '0');
  return s.slice(0, -scale) + '.' + s.slice(-scale);
}
export function precisionTotal(
  lines: { quantity: number; unitPriceCents: number; unitPriceExact?: string }[],
) {
  const units = lines.reduce(
    (s, l) =>
      s +
      priceUnits(l.unitPriceExact ?? exactText(BigInt(l.unitPriceCents) * 100n)) *
        BigInt(l.quantity),
    0n,
  );
  return {
    units,
    exact: exactText(units),
    cents: Number((units + 50n) / 100n),
    hasFractionalCent: units % 100n !== 0n,
  };
}
export function legacyCents(price: string) {
  return Number((priceUnits(price) + 50n) / 100n);
}
