// 精度规则（纯函数为主）：单价的写法、上限、改价补丁的意思，不足一分的尾数，数量的写法，面积和金额按十进制精确换算。
// 单价和合计怎么存在 price-storage.test.ts。虚构数据。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/index.js';
import { orderSchema, productSchema } from '../shared/core/domain.js';
import { costCents, costYuan, plainPrice, precisionTotal, exactText, priceEdit, priceFromE4, priceToE4, productPricePatch } from '../shared/core/precision.js';
import { userError } from '../shared/core/user-errors.js';
import { errorMessage } from '../shared/core/error-message.js';
import { z } from 'zod';
import { flowInput } from '../shared/business/physical-flow.js';
import { sheetArea, purchaseLineAmount } from '../shared/business/operations.js';
import { stockItemSchema, lineMoney } from '../shared/business/operations.js';
import { positiveQuantity, quantityText, quantityString, quantityUnits, safeUnits } from '../shared/core/quantity.js';

test('不足一分的尾数不静默舍入，必须明确结算规则', () => {
  const base = {
    customerId: 1,
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-10',
    status: '待确认',
    notes: '',
    costs: null,
    lines: [
      {
        productId: 1,
        specification: 'test',
        quantity: 3,
        unitPriceCents: 123,
        unitPriceExact: '1.2345',
      },
    ],
  };
  assert.equal(orderSchema.safeParse(base).success, false);
  const accepted = orderSchema.parse({ ...base, roundingPolicy: 'half-up-cent' });
  const total = precisionTotal(accepted.lines);
  assert.equal(total.exact, '3.7035');
  assert.equal(total.cents, 370);
  assert.equal(
    orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], quantity: 1.5 }] }).success,
    false,
  );
});

test('单价全站一个写法：至少两位小数、最多四位，第三四位的尾零去掉，数值不变', () => {
  // 默认就是单价写法；minDecimals=0 只给不是单价的地方（数据管理里按金额填的预估成本）
  const shown = (value: string) => [plainPrice(value), plainPrice(value, 0)];
  assert.deepEqual(shown('2.7600'), ['2.76', '2.76']);
  assert.deepEqual(shown('2.5000'), ['2.50', '2.5']);
  assert.deepEqual(shown('10.7'), ['10.70', '10.7']);
  assert.deepEqual(shown('3.5425'), ['3.5425', '3.5425']);
  assert.deepEqual(shown('3.5400'), ['3.54', '3.54']);
  assert.deepEqual(shown('1.2340'), ['1.234', '1.234']);
  assert.deepEqual(shown('2.0000'), ['2.00', '2']);
  assert.deepEqual(shown('0.0000'), ['0.00', '0']);
  assert.deepEqual(shown('1000000.0000'), ['1000000.00', '1000000']);
  assert.deepEqual(shown('100'), ['100.00', '100']);
  // 0～3 元之间每一个万分之一元：显示出来的写法存回去还是同一个数，小数位在两到四位之间
  for (let e4 = 0; e4 <= 30000; e4++) {
    const exact = priceFromE4(e4);
    assert.equal(priceToE4(plainPrice(exact)), e4);
    assert.equal(priceToE4(plainPrice(exact, 0)), e4);
    assert.match(plainPrice(exact), /^\d+\.\d{2,4}$/);
  }
});

test('单价上限一百万元：超了报中文“单价不能超过 1000000 元”，订单里只报那一行，不再跟着多报合计和尾数', () => {
  const issues = (r: z.ZodSafeParseResult<unknown>) =>
    r.success ? [] : r.error.issues.map((i) => userError(i.path.join('.') + ': ' + i.message));
  assert.deepEqual(issues(productSchema.safeParse({ name: '虚构超价纸箱', priceExact: '2000000' })), [
    '参考单价：单价不能超过 1000000 元',
  ]);
  assert.deepEqual(issues(productSchema.safeParse({ name: '虚构超价纸箱', priceExact: '1000000.0001' })), [
    '参考单价：单价不能超过 1000000 元',
  ]);
  assert.deepEqual(issues(productSchema.safeParse({ name: '虚构上限纸箱', priceExact: '1000000' })), []);
  // 格式不对的只报格式，不多报一条超上限
  assert.deepEqual(issues(productSchema.safeParse({ name: '虚构乱写纸箱', priceExact: 'abc' })), ['参考单价：单价最多四位小数']);
  assert.deepEqual(issues(productSchema.safeParse({ name: '虚构超价纸箱', priceCents: 100_000_001 })), [
    '参考单价：金额不能超过 1000000 元',
  ]);
  const order = (line: Record<string, unknown>) => ({
    customerId: 1,
    orderDate: '2026-10-01',
    deliveryDate: '2026-10-02',
    status: '已确认',
    lines: [{ productId: 1, quantity: 3, unitPriceCents: 150, ...line }],
  });
  assert.deepEqual(issues(orderSchema.safeParse(order({ unitPriceExact: '2000000' }))), ['明细第1项的单价：单价不能超过 1000000 元']);
  assert.deepEqual(issues(orderSchema.safeParse(order({ unitPriceCents: 100_000_001 }))), ['明细第1项的单价：单价不能超过 1000000 元']);
  // 明细单价没填：请填写单价，不按 0 元
  assert.deepEqual(issues(orderSchema.safeParse(order({ unitPriceCents: null }))), ['明细第1项的单价：请填写单价']);
  // 换算函数和校验同一个上限
  assert.equal(priceToE4('1000000'), 10_000_000_000);
  assert.throws(() => priceToE4('1000000.0001'), /单价不能超过 1000000 元/);
  assert.throws(() => priceToE4('9999999'), /单价不能超过 1000000 元/);
});

test('改价补丁的意思（priceEdit）：清空价格、按分存、照提交的存，各种组合和保存规则一致', () => {
  const keys = { exact: 'priceExact', cents: 'priceCents' };
  const priced = { priceCents: 123, priceExact: '1.2345' };
  const cases: [string, Record<string, unknown>, Record<string, unknown> | undefined, boolean, string][] = [
    ['精确价点名 null、分没给', { priceExact: null }, priced, false, 'clear'],
    ['精确价点名空串、分没动', { priceExact: ' ', priceCents: 123 }, priced, false, 'clear'],
    ['整条带回来删掉精确价、分没动', { priceCents: 123 }, priced, true, 'clear'],
    ['精确价清空、分改了：按分', { priceExact: '', priceCents: 250 }, priced, false, 'cents'],
    ['精确价清空、分改成 0：按分（产品就是没定价）', { priceExact: null, priceCents: 0 }, priced, false, 'cents'],
    ['只点名分', { priceCents: 200 }, priced, false, 'cents'],
    ['分改了、精确价还是原来的', { priceCents: 200, priceExact: '1.2345' }, priced, false, 'cents'],
    ['分改了、精确价还是原来的（写法不同）', { priceCents: 200, priceExact: '1.5' }, { priceCents: 150, priceExact: '1.5000' }, false, 'cents'],
    ['分没动、精确价改了', { priceCents: 123, priceExact: '1.2346' }, priced, false, 'keep'],
    ['两头都改了：交给保存去核对', { priceCents: 999, priceExact: '4' }, priced, false, 'keep'],
    ['都没动', { priceCents: 123, priceExact: '1.2345' }, priced, false, 'keep'],
    ['只带别的字段的补丁没点名精确价：不算清空', { name: '虚构' }, priced, false, 'keep'],
    ['原来就没定价：清空也没什么可清', { priceExact: null }, { priceCents: 0 }, false, 'keep'],
    ['新建（没有原记录）', { priceExact: '1.5', priceCents: 150 }, undefined, false, 'keep'],
  ];
  for (const [name, patch, before, dropped, expected] of cases)
    assert.equal(priceEdit(patch, before, keys, dropped), expected, name);
  // 产品要盖到候选记录上的价格字段：清空价格是分给 0、不带精确价
  assert.deepEqual(productPricePatch({ priceExact: null }, priced), { priceExact: undefined, priceCents: 0 });
  assert.deepEqual(productPricePatch({ priceCents: 200 }, priced), { priceExact: undefined });
  assert.deepEqual(productPricePatch({ priceExact: '2' }, priced), {});
  // 盖上以后交给保存：清空的存成没定价（不是 0 元）
  const s = new Store(':memory:');
  try {
    let p = sales(s).createProduct(productSchema.parse({ name: '虚构清价纸箱', priceExact: '1.2345' }));
    p = sales(s).updateProduct(productSchema.parse({ ...p, ...productPricePatch({ priceExact: '' }, p) }), p.id, p.version);
    assert.deepEqual([p.priceCents, p.priceExact], [0, undefined]);
  } finally {
    s.close();
  }
});

test('订单预估成本元和分互换（costYuan、costCents）：BigInt 换算，小数位、上限分开说，订单编辑窗和数据管理同一套', () => {
  assert.equal(costYuan(100), '1');
  assert.equal(costYuan(250), '2.5');
  assert.equal(costYuan(1), '0.01');
  assert.equal(costYuan(0), '0');
  assert.equal(costYuan('300'), '3');
  assert.equal(costYuan(null), '');
  assert.equal(costYuan(undefined), '');
  assert.equal(costYuan(''), '');
  assert.equal(costYuan(1.5), '1.5', '不是整数的分原样写，留给保存校验');
  assert.equal(costCents('1'), 100);
  assert.equal(costCents('2.5'), 250);
  assert.equal(costCents('0.07'), 7);
  assert.equal(costCents(' 19.99 '), 1999);
  assert.equal(costCents('0'), 0);
  assert.equal(costCents('1000000'), 100_000_000);
  for (const bad of ['', '   ', 'abc', '-1', '1.234', '01', '1,000', '1.'])
    assert.throws(() => costCents(bad), /^Error: 请填写金额（元），最多两位小数$/, bad);
  assert.throws(() => costCents('1000000.01'), /^Error: 金额太大，不能超过 1000000 元$/);
  assert.throws(() => costCents('99999999999'), /^Error: 金额太大，不能超过 1000000 元$/);
  for (const cents of [0, 1, 99, 250, 123456, 100_000_000]) assert.equal(costCents(costYuan(cents)), cents);
});

test('exactText 负数不错位', () => {
  assert.equal(exactText(-15000n), '-1.5000');
  assert.equal(exactText(-5n), '-0.0005');
});

test('数量没填（没给、null、空串、只有空格）统一报“请填写数量”，是校验错误不是程序报错；别的非法值提示照旧', () => {
  const messages = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  for (const schema of [quantityText, positiveQuantity])
    for (const empty of [undefined, null, '', '   '])
      assert.deepEqual(messages(schema, empty), ['请填写数量'], JSON.stringify(empty));
  // 写法不对的只报写法，不再从“大于零”那一步抛出普通错误
  assert.deepEqual(messages(positiveQuantity, 'abc'), ['数量使用非负数字，最多3位小数']);
  assert.deepEqual(messages(positiveQuantity, '1.2345'), ['数量使用非负数字，最多3位小数']);
  assert.deepEqual(messages(positiveQuantity, '0'), ['数量必须大于零']);
  assert.deepEqual(messages(positiveQuantity, ' 2.5 '), []);
  assert.equal(positiveQuantity.parse(' 2.5 '), '2.5');
  // 数字等别的类型：默认提示（userError 转成“请填写文字内容”），和以前一样
  assert.match(messages(quantityText, 5)[0], /expected string, received number/);
  // 单据里没填数量：空串和 null 得到同一句提示
  for (const empty of [null, '']) {
    const r = taskSchemaCheck(empty);
    assert.deepEqual(r, ['数量：请填写数量'], JSON.stringify(empty));
  }
});

test('数量读成千分整数（safeUnits）：读不出给 0 或指定的值，不报错', () => {
  // 数字（订单明细存的数）×1000 四舍五入，负数照算
  assert.equal(safeUnits(12.5), 12_500);
  assert.equal(safeUnits(0), 0);
  assert.equal(safeUnits(1.2345), 1_235);
  assert.equal(safeUnits(-1), -1_000);
  assert.equal(safeUnits(Number.NaN), 0);
  assert.equal(safeUnits(Number.POSITIVE_INFINITY), 0);
  // 文字（单据里的数量）按 quantityUnits，前后空格不算
  assert.equal(safeUnits('3.25'), 3_250);
  assert.equal(safeUnits(' 7 '), 7_000);
  assert.equal(safeUnits('0.001'), 1);
  // 没填当 0（指定了别的读不出值时也是 0）
  for (const empty of [undefined, null, '', '   ']) {
    assert.equal(safeUnits(empty), 0, JSON.stringify(empty));
    assert.equal(safeUnits(empty, Number.NaN), 0, JSON.stringify(empty));
  }
  // 写法不对的：负数文字、带单位、超过三位小数、千分位、别的类型，都给读不出值
  for (const bad of ['-1', '5只', '1.2345', '1,000', 'abc', {}, true])
    assert.equal(safeUnits(bad), 0, String(bad));
  assert.ok(Number.isNaN(safeUnits('abc', Number.NaN)));
  assert.equal(safeUnits(Number.NaN, -1), -1);
});

function taskSchemaCheck(quantity: unknown): string[] {
  try {
    flowInput('task', { date: '2026-10-01', productId: 1, quantity, unit: '只', orderIds: [] });
    return [];
  } catch (e: unknown) {
    assert.ok(e instanceof z.ZodError, '是校验错误：' + errorMessage(e));
    return e.issues.map((i) => userError(i.path.join('.') + ': ' + i.message));
  }
}

test('面积计价精确处理 mm、cm 和小数张数，单位不明的不算面积；数量和金额按十进制精确换算', () => {
  assert.equal(sheetArea({ unit: '张', length: 100, width: 80, dimensionUnit: 'cm' }, '100'), '80');
  assert.equal(
    sheetArea({ unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' }, '100'),
    '80',
  );
  assert.equal(sheetArea({ unit: '张', length: 100, width: 80, dimensionUnit: null }, '100'), null);
  assert.equal(
    purchaseLineAmount({
      unit: '张',
      length: 100,
      width: 80,
      dimensionUnit: 'cm',
      quantity: '200',
      unitPrice: '2.1234',
      priceBasis: 'area',
    }),
    '339.744',
  );
  // 没写计价方式算不出金额，不当成按张或按平方米
  for (const priceBasis of [undefined, null])
    assert.equal(purchaseLineAmount({ unit: '张', quantity: '200', unitPrice: '2.1234', priceBasis }), null, String(priceBasis));
  assert.equal(quantityUnits('0.125'), 125);
  assert.equal(quantityString(1000000), '1000');
  assert.throws(() => quantityUnits('1.2345'));
  assert.equal(lineMoney('0.125', '1.2345'), '0.1543125');
  // 库存品可选的资料空着就是 null
  assert.equal(stockItemSchema.parse({ name: '可选资料空白', kind: 'raw', unit: '张', length: ' ', productId: '' }).length, null);
});
