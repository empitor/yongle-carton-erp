// 数量和单位的边界：带空格的数量、报错文字、千分整数写回文字去尾零、单位没填时的默认单位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantityString, quantityUnits, rawUnit, stockUnit } from '../../shared/core/index.js';

test('数量前后带空格应该照样换算成千分整数', () => {
  assert.equal(quantityUnits(' 1.5 '), 1500);
  assert.equal(quantityUnits('12.005\t'), 12005);
});

test('数量写法不对时应该报“数量格式无效，最多3位小数”', () => {
  for (const bad of ['abc', '-1', '1.2345', '']) assert.throws(() => quantityUnits(bad), /^Error: 数量格式无效，最多3位小数$/);
});

test('千分整数写回数量文字应该去掉小数尾零，整数不带小数点', () => {
  const cases: [number | bigint, string][] = [
    [0, '0'], [10, '0.01'], [120, '0.12'], [1000, '1'], [1001, '1.001'], [1500, '1.5'], [10000, '10'], [1500n, '1.5'],
  ];
  for (const [units, text] of cases) assert.equal(quantityString(units), text, String(units));
});

test('原材料单位没填（null、undefined、空格）应该是“张”，别的写法原样交给校验', () => {
  assert.equal(rawUnit(null), '张');
  assert.equal(rawUnit(undefined), '张');
  assert.equal(rawUnit('  '), '张');
  assert.equal(rawUnit(' 箱 '), '箱');
  assert.equal(stockUnit('raw', null), '张');
  assert.equal(stockUnit('finished', null), '只');
});
