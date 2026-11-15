// 财务设置、科目两个编辑窗：表单的值转成保存的正文，设置转成编辑窗的初值（纯函数，虚构数据）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FinData } from '../src/finance/fin-api.js';
import { settingsBody, settingsInitial, subjectBody, type AccountRow } from '../src/finance/settings/settings-forms.js';

const settings: FinData<'GET /finance/settings'> = {
  version: 4,
  startPeriod: '2026-01',
  taxpayer: 'general',
  requireSeparateApprover: true,
  revenueRecognition: 'delivery',
  costAllocation: 'output',
  agingDays: [30, 60, 90, 180, 365],
  archiveRetention: { voucherYears: 30, ledgerYears: 30, bankYears: 10, taxWorkpaperYears: 10, starts: '虚构起算日' },
  taxRates: { smallVat: 300, urban: 700, education: null, localEducation: 150, income: 2500 },
};
const account: AccountRow = {
  code: '660201',
  parent_code: '6602',
  name: '虚构办公费',
  category: 'profit',
  direction: 'debit',
  cash_kind: null,
  auxiliary: null,
  enabled: 1,
  version: 3,
  used: 0,
  leaf: 1,
};

test('设置的初值：账龄用顿号连起来，税率由万分之几写成百分数，没填的空着', () => {
  assert.deepEqual(settingsInitial(settings), {
    revenueRecognition: 'delivery',
    costAllocation: 'output',
    requireSeparateApprover: true,
    agingDays: '30、60、90、180、365',
    smallVat: '3',
    urban: '7',
    education: '',
    localEducation: '1.5',
    income: '25',
  });
});

test('保存设置：账龄按顿号、逗号、空格拆开，税率带小数的换成万分之几，空着的是未设置', () => {
  const body = settingsBody(
    settings,
    {
      revenueRecognition: 'invoice',
      costAllocation: 'material',
      agingDays: '30、60, 90，180 365',
      smallVat: '3',
      urban: '1.5',
      education: '',
      income: '25',
    },
    false,
  );
  assert.deepEqual(body, {
    version: 4,
    revenueRecognition: 'invoice',
    costAllocation: 'material',
    agingDays: [30, 60, 90, 180, 365],
    taxRates: { smallVat: 300, urban: 150, education: null, localEducation: null, income: 2500 },
  });
});

test('保存设置：只有超级管理员带“制单和审核分开”', () => {
  assert.equal(settingsBody(settings, { requireSeparateApprover: false }, true).requireSeparateApprover, false);
  assert.equal('requireSeparateApprover' in settingsBody(settings, { requireSeparateApprover: true }, false), false);
});

test('保存设置：收入确认不是选项之一时发出去的正文里没有这一项（服务端照旧）', () => {
  const sent: unknown = JSON.parse(JSON.stringify(settingsBody(settings, { revenueRecognition: 'later' }, false)));
  assert.equal(typeof sent === 'object' && sent !== null && 'revenueRecognition' in sent, false);
});

test('保存设置：税率不是数字或超过两位小数时报中文', () => {
  assert.throws(() => settingsBody(settings, { urban: '七' }, false), { message: '税率只能填数字，最多两位小数：七' });
  assert.throws(() => settingsBody(settings, { urban: '1.234' }, false), {
    message: '税率只能填数字，最多两位小数：1.234',
  });
});

test('新建科目：不带版本，没选资金类型、辅助核算的是 null', () => {
  assert.deepEqual(
    subjectBody(null, { code: '660299', name: '虚构杂费', category: 'profit', direction: 'debit', enabled: true }),
    {
      account: {
        code: '660299',
        name: '虚构杂费',
        category: 'profit',
        direction: 'debit',
        cashKind: null,
        auxiliary: null,
        enabled: true,
      },
    },
  );
});

test('编辑科目：带上打开时的版本，选了的资金类型、辅助核算照带', () => {
  const body = subjectBody(account, {
    code: '660201',
    name: '虚构办公费',
    category: 'profit',
    direction: 'debit',
    cashKind: 'bank',
    auxiliary: 'department',
    enabled: false,
  });
  assert.equal(body.version, 3);
  assert.deepEqual(
    [body.account.cashKind, body.account.auxiliary, body.account.enabled],
    ['bank', 'department', false],
  );
});

test('科目的编码、名称空着，类别、方向没选上时报中文，不发出去', () => {
  const ok = { code: '660299', name: '虚构杂费', category: 'profit', direction: 'debit' };
  assert.throws(() => subjectBody(null, { ...ok, code: '' }), { message: '请填写编码。' });
  assert.throws(() => subjectBody(null, { ...ok, name: undefined }), { message: '请填写名称。' });
  assert.throws(() => subjectBody(null, { ...ok, category: 'other' }), { message: '请选择类别。' });
  assert.throws(() => subjectBody(null, { ...ok, direction: undefined }), { message: '请选择方向。' });
});
