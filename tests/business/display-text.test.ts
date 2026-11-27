// 全站统一的叫法和写法（shared/business/operations/display-text.ts、physical-flow.ts 的 flowStatusText）：同一样东西一个叫法，不猜。纯函数和内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowStatusText, orderTaxText, priceText, specLine } from '../../shared/business/index.js';
import { centsText } from '../../shared/core/display-amount.js';
import { toolsOf } from '../support/assistant-fixture.js';
import { flowFixture, clerk } from '../support/flow-fixture.js';
import { orderedPurchase } from '../support/receive-fixture.js';
import { readAs } from '../support/read-result.js';

test('单据状态：被更正的到货叫“已更正”，撤销的叫“已撤销”，取消的叫“已取消”', () => {
  assert.equal(flowStatusText({ kind: 'arrival', status: 'reversed', replacedBy: 'x' }), '已更正');
  assert.equal(flowStatusText({ kind: 'arrival', status: 'reversed' }), '已撤销');
  assert.equal(flowStatusText({ kind: 'arrival', status: 'cancelled' }), '已取消');
  assert.equal(flowStatusText({ kind: 'arrival', status: 'confirmed' }), '已入库');
  assert.equal(flowStatusText({ kind: 'arrival', pending: true }), '待入库');
  assert.equal(flowStatusText({ kind: 'delivery', status: 'confirmed', shippedAt: 't', deliveredAt: 't' }), '已送达');
});

test('以分存的金额（centsText）：千分位、两位小数、负号不丢；不是整数的四舍五入到分，不是数的按 0', () => {
  assert.equal(centsText(0), '0.00');
  assert.equal(centsText(5), '0.05');
  assert.equal(centsText(-5), '-0.05');
  assert.equal(centsText(123450), '1,234.50');
  assert.equal(centsText(123456789), '1,234,567.89');
  assert.equal(centsText(-1999), '-19.99');
  assert.equal(centsText(100000000), '1,000,000.00');
  assert.equal(centsText(12.6), '0.13');
  assert.equal(centsText(-0.4), '0.00');
  assert.equal(centsText(Number.NaN), '0.00');
  // @ts-expect-error 故意传不是数的值
  assert.equal(centsText(null), '0.00');
});

test('单价写法不猜计价方式；规格里已有的尺寸不重复、但不会误删相近的数', () => {
  assert.equal(priceText('2.15', null, '张'), '2.15 元（计价方式待确认）');
  assert.equal(priceText('2.15', 'area', '张'), '2.15 元/m²');
  assert.equal(priceText(null, 'quantity', '张'), '单价待定');
  assert.equal(specLine({ specification: '900×700', length: 900, width: 700, dimensionUnit: 'mm' }), '900×700');
  assert.match(specLine({ specification: '1200×800', length: 200, width: 800, dimensionUnit: 'mm' }), /200 × 800 mm/);
});

test('订单显示规范税率和原件写法，认不出的原话提示核对', () => {
  assert.equal(orderTaxText({ taxRate: 0, taxMode: '含税' }), '0% 含税');
  assert.equal(orderTaxText({ taxRate: 13, taxText: '１３％' }), '13% · 原件写法：１３％');
  // 订单详情是只读的：只说没认出来、原件写的是什么，不叫人去选
  assert.equal(orderTaxText({ taxText: '免税' }), '税率没认出来，原件写的是“免税”。');
  assert.equal(orderTaxText({}), '未明确');
});

test('助手按页面上的叫法筛采购单：“待到货”能找到存成“已订货”的', () => {
  const f = flowFixture();
  try {
    orderedPurchase(f, clerk, ['100']);
    const tools = toolsOf(f.store);
    for (const status of ['待到货', '已订货'])
      assert.equal(readAs(tools.read('records.search', { module: 'purchases', filters: { status } }, clerk), {}).total, 1, status);
  } finally {
    f.store.close();
  }
});
