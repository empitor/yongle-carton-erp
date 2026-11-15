// 月度台账、概览明细里没算进理论金额的送货、到货：缺数量的写“缺数量或单位”，缺价格的写“缺价格”（纯函数，虚构数据）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingAmountName, monthlyRowStatus } from '../shared/finance/index.js';

const pending = (missing: string[]) => ({
  metric: 'theoreticalIncome',
  status: 'info_pending',
  missing_tax: 0,
  amount: null,
  detail: { missing },
});

test('缺数量的送货单：状态写“缺数量或单位”，不写成缺价格', () => {
  assert.deepEqual(monthlyRowStatus(pending(['quantity'])), ['缺数量或单位', 'warning']);
  assert.deepEqual(monthlyRowStatus(pending(['quantity', 'price'])), ['缺数量或单位', 'warning']);
});

test('缺价格的送货单、明细里没记缺什么的：状态仍是缺价格', () => {
  assert.deepEqual(monthlyRowStatus(pending(['price'])), ['缺价格', 'warning']);
  assert.deepEqual(monthlyRowStatus({ metric: 'theoreticalExpense', status: 'ready', amount: null }), [
    '缺价格',
    'warning',
  ]);
});

test('明细不是对象或没有 missing 时按缺价格写', () => {
  for (const detail of [null, 'quantity', ['quantity'], {}, { missing: 'quantity' }])
    assert.equal(missingAmountName(detail), '缺价格');
  assert.equal(missingAmountName({ missing: ['tax', 'quantity'] }), '缺数量或单位');
});
