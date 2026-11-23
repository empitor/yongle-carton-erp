// 财务表单的值取成正文要的类型：下拉选出来的取值、必选的下拉、必填的文字（纯函数，虚构数据）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chosen, filled, optionOf, type Option } from '../../src/finance/submit-pick.js';

const directions: readonly Option<'debit' | 'credit'>[] = [
  ['debit', '借'],
  ['credit', '贷'],
];

test('下拉的值是选项之一时就是它', () => {
  assert.equal(optionOf('credit', directions), 'credit');
  assert.equal(chosen('debit', directions, '方向'), 'debit');
});

test('下拉没选或不是选项之一时是 undefined', () => {
  assert.equal(optionOf(undefined, directions), undefined);
  assert.equal(optionOf('借', directions), undefined);
  assert.equal(optionOf(1, directions), undefined);
});

test('必选的下拉没选上时报“请选择……。”', () => {
  assert.throws(() => chosen(undefined, directions, '方向'), { message: '请选择方向。' });
  assert.throws(() => chosen('sideways', directions, '方向'), { message: '请选择方向。' });
});

test('必填的文字原样交出', () => {
  assert.equal(filled('虚构摘要', '摘要'), '虚构摘要');
});

test('必填的文字空着、不是文字时报“请填写……。”', () => {
  assert.throws(() => filled('', '摘要'), { message: '请填写摘要。' });
  assert.throws(() => filled(undefined, '冲销日期'), { message: '请填写冲销日期。' });
  assert.throws(() => filled(20260101, '冲销日期'), { message: '请填写冲销日期。' });
});
