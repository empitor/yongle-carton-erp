// 数量和单位的属性测试（fast-check 随机生成）：数量和千分整数来回换算不丢，库存品单位只收“只”“张”，别的一律拒收。
// 纯函数和内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { MAX_STOCK_UNITS, UNITS_PER_QUANTITY, quantityString, quantityUnits, safeUnits } from '../shared/core/quantity.js';
import { FINISHED_UNIT, RAW_UNIT, stockUnit } from '../shared/core/units.js';
import { productSchema } from '../shared/core/domain.js';
import { clerk, flowFixture } from './flow-fixture.js';

const RUNS = { numRuns: 300 };
/** 只和张的各种写法，加上一些别的单位 */
const unitArb = fc.oneof(
  fc.constantFrom('', ' ', FINISHED_UNIT, RAW_UNIT, '个', 'pcs', 'PCS', 'Pc', ' 只 ', '箱', '套', '公斤', 'kg', '张 ', '件'),
  fc.string({ maxLength: 4 }),
);

test('千分整数写成数量文字再读回，0 到库存上限一个不丢', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: MAX_STOCK_UNITS }), (units) => quantityUnits(quantityString(units)) === units),
    RUNS,
  );
});

test('合法的数量文字读成千分整数再写回，数值不变（尾零去掉）', () => {
  const text = fc
    .tuple(fc.integer({ min: 0, max: 999_999_999 }), fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }))
    .map(([whole, fraction]) => (fraction === undefined ? String(whole) : whole + '.' + String(fraction).padStart(3, '0')));
  fc.assert(
    fc.property(text, (value) => quantityUnits(quantityString(quantityUnits(value))) === quantityUnits(value)),
    RUNS,
  );
});

test('列表里按数字存的数量（三位小数以内）换成千分整数不丢', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: MAX_STOCK_UNITS }), (units) => safeUnits(units / UNITS_PER_QUANTITY) === units),
    RUNS,
  );
});

test('四位小数、负数、带符号的数量一律拒收', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 999_999 }), (n) =>
      ['-' + n, '+' + n, n + '.0001', String(n) + 'e3', ' ' + n + '.1234'].every((v) => {
        try {
          quantityUnits(v);
          return false;
        } catch {
          return true;
        }
      }),
    ),
    RUNS,
  );
});

test('库存品的单位：原材料只存成“张”、成品只存成“只”，别的单位一律拒收、库里不多一条', () => {
  const f = flowFixture();
  try {
    let serial = 0;
    fc.assert(
      fc.property(fc.constantFrom('raw', 'finished'), unitArb, (kind, unit) => {
        const expected = kind === 'raw' ? RAW_UNIT : FINISHED_UNIT;
        const before = f.ops.repo.items(true).length;
        // 成品要挂一个还没有成品库存的产品
        const productId = kind === 'finished' ? f.store.saveProduct(productSchema.parse({ name: '虚构单位产品' + ++serial })).id : undefined;
        try {
          const saved = f.ops.saveItem({ name: '虚构单位' + ++serial, kind, unit, productId }, clerk);
          return stockUnit(kind, unit) === expected && saved.unit === expected;
        } catch {
          return stockUnit(kind, unit) !== expected && f.ops.repo.items(true).length === before;
        }
      }),
      { numRuns: 60 },
    );
  } finally {
    f.store.close();
  }
});

test('单位规则本身：成品只认“只”和登记过的别名，原材料只认“张”和空着，别的原样交给校验去拦', () => {
  const finishedAliases = new Set(['', FINISHED_UNIT, '个', 'pcs', 'pc']);
  fc.assert(
    fc.property(unitArb, (unit) => {
      const text = unit.trim();
      assert.equal(stockUnit('finished', unit), finishedAliases.has(text.toLowerCase()) ? FINISHED_UNIT : text);
      assert.equal(stockUnit('raw', unit), text === '' ? RAW_UNIT : text);
    }),
    RUNS,
  );
});
