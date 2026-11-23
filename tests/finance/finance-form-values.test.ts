// 财务通用表单窗口的值：初值放进输入框的写法、提交前转成金额（分）和编号（纯函数，虚构数据）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertValues, initialValues, type Field } from '../../src/finance/form-values.js';

const fields: Field[] = [
  { name: 'amount', label: '金额', type: 'money' },
  { name: 'months', label: '使用月数', type: 'int' },
  { name: 'partyId', label: '往来单位', type: 'party', partyKind: 'customer' },
  { name: 'description', label: '摘要' },
  { name: 'enabled', label: '启用', type: 'check' },
];

test('初值：金额（分）写成不带千分位的元，勾选是真假，别的是文字，没有就空着', () => {
  const values = initialValues(fields, { amount: 123450, months: 36, enabled: 1, extra: '原样留着' });
  assert.deepEqual(values, {
    amount: '1234.50',
    months: '36',
    partyId: '',
    description: '',
    enabled: true,
    extra: '原样留着',
  });
});

test('提交：金额按元转成分（带千分位、一位小数都认），整数和单位转成数，文字去掉首尾空白', () => {
  const out = convertValues(fields, {
    amount: '1,234.5',
    months: '36',
    partyId: '7',
    description: '  虚构摘要  ',
    enabled: true,
  });
  assert.deepEqual(out, { amount: 123450, months: 36, partyId: 7, description: '虚构摘要', enabled: true });
});

test('提交：空着的字段不带，勾选没勾是 false', () => {
  assert.deepEqual(convertValues(fields, { amount: '', months: '', description: '', enabled: false }), {
    enabled: false,
  });
});

test('提交：藏起来的字段、自带控件的字段不带', () => {
  const extra: Field[] = [
    { name: 'note', label: '备注', show: () => false },
    { name: 'file', label: '原件', render: () => null },
    { name: 'reason', label: '原因' },
  ];
  assert.deepEqual(convertValues(extra, { note: '藏起来的', file: '选好的文件', reason: '虚构原因' }), {
    reason: '虚构原因',
  });
});

test('提交：金额不是数字或超过两位小数时报中文，不四舍五入', () => {
  assert.throws(() => convertValues(fields, { amount: '一百' }), { message: '金额只能填数字，最多两位小数：一百' });
  assert.throws(() => convertValues(fields, { amount: '1.234' }), { message: '金额只能填数字，最多两位小数：1.234' });
});
