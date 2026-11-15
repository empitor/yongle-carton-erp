// 单价规则的边界（只看非负数）：报错文字、导入预览的单价写法、同价判断、改价补丁的默认参数和非文字的值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linePrice, priceEdit, priceToE4, productPricePatch, samePrice } from '../shared/core/index.js';

const keys = { exact: 'priceExact', cents: 'priceCents' };
const priced = { priceCents: 123, priceExact: '1.2345' };

test('单价写法不对时应该报“单价必须为非负数，最多四位小数”', () => {
  for (const bad of ['-1', '1.23456', 'abc', '']) assert.throws(() => priceToE4(bad), /^Error: 单价必须为非负数，最多四位小数$/);
});

test('导入预览的单价：精确价优先，只有整数分时按分换算，分不是整数或没有就写“待定”', () => {
  assert.equal(linePrice({ unitPriceExact: '3.5425', unitPriceCents: 100 }), '3.5425');
  assert.equal(linePrice({ unitPriceExact: null, unitPriceCents: 250 }), '2.50');
  assert.equal(linePrice({ unitPriceCents: 0 }), '0.00');
  assert.equal(linePrice({ unitPriceCents: 1.5 }), '待定');
  assert.equal(linePrice({ unitPriceExact: null, unitPriceCents: null }), '待定');
});

test('同价判断：去掉首尾空格后按数值比；格式不对或不是文字的一律不算同价', () => {
  assert.equal(samePrice(' 1.5 ', '1.5000'), true);
  assert.equal(samePrice('2', ' 2.00 '), true);
  assert.equal(samePrice('1.5', '1.5001'), false);
  assert.equal(samePrice('abc', 'abc'), false);
  assert.equal(samePrice('1.5', 1.5), false);
  assert.equal(samePrice(null, null), false);
});

test('改价补丁不传“整条带回来”时应该按只带改的字段算：没点名精确价就是没动', () => {
  assert.equal(priceEdit({ name: '虚构纸箱' }, priced, keys), 'keep');
  assert.deepEqual(productPricePatch({ name: '虚构纸箱' }, priced), {});
});

test('精确价点名为 undefined 应该算清空，点名成数字不算清空（留给保存去核对）', () => {
  assert.equal(priceEdit({ priceExact: undefined }, priced, keys), 'clear');
  assert.equal(priceEdit({ priceExact: 2 }, priced, keys), 'keep');
});
