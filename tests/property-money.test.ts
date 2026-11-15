// 金额和单价的属性测试（fast-check 随机生成）：分和元来回换算不丢分，四位小数单价乘数量四舍五入到分和大整数精确算的一致，
// 负数拒收、0 和上限都成立，四舍五入对正负数对称。纯函数、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  MAX_PRICE_UNITS,
  MAX_PRICE_YUAN,
  exactText,
  legacyCents,
  precisionTotal,
  priceFromCents,
  priceFromE4,
  priceToE4,
  priceUnits,
  roundedQuotient,
} from '../shared/core/precision.js';

/** 单价上限折成分 */
const MAX_PRICE_CENTS = MAX_PRICE_YUAN * 100;
/** 一张单据里的数量上限（随机取值用，够大就行） */
const MAX_LINE_QUANTITY = 1_000_000;
const RUNS = { numRuns: 300 };

/** 万分之一元的整数单价，0 到上限 */
const priceUnitsArb = fc.bigInt({ min: 0n, max: MAX_PRICE_UNITS });
/** 单价文字：随机去掉尾零，写法不同、数值相同 */
const priceTextArb = priceUnitsArb.chain((units) =>
  fc.integer({ min: 0, max: 4 }).map((drop) => {
    const text = exactText(units);
    const trimmed = text.slice(0, text.length - drop).replace(/\.$/, '');
    return { units, text: priceUnits(trimmed) === units ? trimmed : text };
  }),
);

/** 四舍五入到分：不用 roundedQuotient，按商和余数直接判，非负数 */
function halfUpCents(units: bigint) {
  const whole = units / 100n,
    rest = units % 100n;
  return rest >= 50n ? whole + 1n : whole;
}

test('任意分数的单价换成精确单价再换回分，一分不差', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: MAX_PRICE_CENTS }), (cents) => {
      return priceUnits(priceFromCents(cents)) === BigInt(cents) * 100n && legacyCents(priceFromCents(cents)) === cents;
    }),
    RUNS,
  );
});

test('任意合法单价存成万分之一元整数再读回，数值不变', () => {
  fc.assert(
    fc.property(priceTextArb, ({ units, text }) => priceUnits(priceFromE4(priceToE4(text))) === units),
    RUNS,
  );
});

test('四位小数单价乘整数数量，合计的分和用大整数精确算再四舍五入的一致', () => {
  const line = fc.record({
    price: priceTextArb,
    quantity: fc.integer({ min: 1, max: MAX_LINE_QUANTITY }),
  });
  fc.assert(
    fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (lines) => {
      const exact = lines.reduce((sum, l) => sum + l.price.units * BigInt(l.quantity), 0n);
      const total = precisionTotal(
        lines.map((l) => ({ quantity: l.quantity, unitPriceCents: 0, unitPriceExact: l.price.text })),
      );
      return (
        total.units === exact &&
        total.exact === exactText(exact) &&
        BigInt(total.cents) === halfUpCents(exact) &&
        total.hasFractionalCent === (exact % 100n !== 0n)
      );
    }),
    RUNS,
  );
});

test('负数单价、超过上限的单价、五位小数一律拒收；0 和上限本身收下', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: MAX_PRICE_UNITS }), (units) => {
      const negative = '-' + exactText(units);
      const over = exactText(MAX_PRICE_UNITS + units);
      const fiveDecimals = exactText(units) + '1';
      return [negative, over, fiveDecimals].every((text) => {
        try {
          priceUnits(text);
          return false;
        } catch {
          return true;
        }
      });
    }),
    RUNS,
  );
  fc.assert(
    fc.property(fc.constantFrom('0', '0.0000', String(MAX_PRICE_YUAN), exactText(MAX_PRICE_UNITS)), (text) => {
      return priceUnits(text) === (text.startsWith('0') ? 0n : MAX_PRICE_UNITS);
    }),
  );
});

test('整数四舍五入拒绝负数和零作为除数', () => {
  for (const divisor of [-100n, 0n])
    assert.throws(() => roundedQuotient(-151n, divisor), { name: 'RangeError', message: '除数必须为正' });
});

test('被除数是负数时四舍五入往离零远的方向进：-1.5 → -2、-1.4 → -1，整数不变', () => {
  const cases: [bigint, bigint, bigint][] = [
    [-1n, 1n, -1n],
    [-151n, 100n, -2n],
    [-150n, 100n, -2n],
    [-149n, 100n, -1n],
    [-140n, 100n, -1n],
    [-50n, 100n, -1n],
    [-49n, 100n, 0n],
  ];
  for (const [a, b, expected] of cases) assert.equal(roundedQuotient(a, b), expected, `${a} / ${b}`);
});

test('四舍五入的整数除法对正负数对称：-a/b 就是 a/b 取负，红字和原数加起来是零', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (a, b) => {
      return roundedQuotient(-a, b) === -roundedQuotient(a, b);
    }),
    RUNS,
  );
});

test('精确金额文字对正负数对称：负数就是同一个数前面加负号', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 10n ** 18n }), (units) => exactText(-units) === '-' + exactText(units)),
    RUNS,
  );
});
