import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centsText, percentOf, toCents, yuan } from '../src/finance/money.js';

test('财务页面的元和分互转不走浮点，也不四舍五入', () => {
  assert.equal(toCents('1,234.5'), 123450);
  assert.equal(toCents('0.07'), 7);
  assert.equal(toCents('19.99'), 1999);
  assert.equal(toCents('-3.20'), -320);
  assert.equal(toCents('1 000'), 100000);
  assert.throws(() => toCents('1.234'), /两位小数/);
  assert.throws(() => toCents('abc'), /数字/);
  assert.throws(() => toCents(''), /数字/);
});

test('金额显示用整数分拼接，缺值显示破折号', () => {
  assert.equal(yuan(123456789), '1,234,567.89');
  assert.equal(yuan(5), '0.05');
  assert.equal(yuan(-1999), '-19.99');
  assert.equal(yuan(0), '0.00');
  assert.equal(yuan(null), '—');
  assert.equal(yuan(undefined), '—');
  assert.equal(centsText(123450), '1234.50');
  assert.equal(centsText(null), '');
  assert.equal(percentOf('730000000', '97000000'), '7.53%');
  assert.equal(percentOf(1, 0), '—');
});
