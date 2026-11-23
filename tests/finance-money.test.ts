import assert from 'node:assert/strict';
import { quietLog } from './finance-catch-up-fixture.js';
import { test } from 'node:test';
import { z } from 'zod';
import { centsInput, toCents, yuan } from '../src/ui/money.js';
import { bpText, percentOf, percentToBp } from '../src/finance/percent.js';
import { centsText as sharedCentsText } from '../shared/core/index.js';
import { financeAmountsInYuan, readFinanceTool, financeMoneyFields } from '../server/finance/assistant.js';
import { displayAmount } from '../shared/core/display-amount.js';
import { Store } from '../server/core/index.js';
import { FinanceSettings } from '../server/finance/base/settings.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { financeReadTools } from '../shared/finance/finance-tools.js';
import { entry } from '../server/finance/base/query.js';
import { documentMoney } from '../server/finance/base/amounts.js';
import { deliveryLineExact } from '../shared/business/flow/document-value.js';
import { maker, post } from './finance-fixture.js';

/** 换成元以后的结果按结构认：各项的值留给断言去比（没换的数字、换了的文字都原样拿到） */
const fields = z.record(z.string(), z.unknown());
const withRows = z.looseObject({ rows: z.array(fields) });
const withLines = z.looseObject({ lines: z.array(fields) });

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
  assert.equal(centsInput(123450), '1234.50');
  assert.equal(centsInput(null), '');
  assert.equal(sharedCentsText(123456789), '1,234,567.89');
  assert.equal(sharedCentsText(-5), '-0.05');
});

test('税率、残值率按基点换算只用整数，填错时说是哪一项比例', () => {
  assert.equal(percentToBp('3', '税率'), 300);
  assert.equal(percentToBp('1.5', '税率'), 150);
  assert.equal(percentToBp(' 0.07 ', '税率'), 7);
  assert.throws(() => percentToBp('1.234', '税率'), /^Error: 税率只能填数字，最多两位小数/);
  assert.throws(() => percentToBp('abc', '残值率'), /^Error: 残值率只能填数字/);
  assert.equal(bpText(300), '3');
  assert.equal(bpText(150), '1.5');
  assert.equal(bpText(105), '1.05');
  assert.equal(bpText(7), '0.07');
  assert.equal(percentOf('730000000', '97000000'), '7.53%');
  assert.equal(percentOf(1, 0), '—');
});

test('助手财务金额给模型前换成元（曾把 7692.60 元说成 76.9 万）：金额字段换元、带负号，条数、页码、编号、天数不换', () => {
  const more = withRows.parse(financeAmountsInYuan({
    ordered: 769260,
    theoreticalProfit: -12345,
    missingPrice: 3,
    filteredRecords: 2,
    page: 1,
    rows: [{ amount: 5, partyId: 7, overdueDays: 30, remainingAmount: 100 }],
  }));
  assert.equal(more.ordered, '7692.60');
  assert.equal(more.theoreticalProfit, '-123.45');
  assert.equal(more.missingPrice, 3, '条数不换');
  assert.equal(more.filteredRecords, 2);
  assert.equal(more.page, 1);
  assert.equal(more.rows[0].amount, '0.05');
  assert.equal(more.rows[0].partyId, 7);
  assert.equal(more.rows[0].overdueDays, 30);
  assert.equal(more.rows[0].remainingAmount, '1.00');

  const out = fields.parse(financeAmountsInYuan({
    paid: 11300,
    linked: 11300,
    creditLimit: 11300,
    amount: 11300,
    id: 5,
    party_id: 7,
    voucherId: 9,
    quantity_units: 1000,
  }));
  assert.equal(out.paid, '113.00');
  assert.equal(out.linked, '113.00');
  assert.equal(out.creditLimit, '113.00');
  assert.equal(out.amount, '113.00');
  assert.equal(out.id, 5);
  assert.equal(out.party_id, 7);
  assert.equal(out.voucherId, 9);
  assert.equal(out.quantity_units, 1000);
});

test('金额显示保留负号：-0.50 不丢负号，-0 显示 0.00', () => {
  assert.equal(displayAmount('-0.50'), '-0.50');
  assert.equal(displayAmount('-1234.5000'), '-1,234.50');
  assert.equal(displayAmount('-0.0000'), '0.00');
  assert.equal(displayAmount('0.1543125'), '0.1543125');
});

test('助手财务查询：科目余额、本年累计、利润表本年数、资产负债表差额都换成元，次数和编号不换', () => {
  const s = new Store(':memory:');
  try {
    new FinanceSettings(s).enable(maker, {
      period: '2026-03',
      taxpayer: 'general',
      version: 1,
      requestId: 'enable',
      rows: [
        { accountCode: '1002', debit: 1000000, credit: 0, yearDebit: 300000, yearCredit: 0 },
        { accountCode: '3001', debit: 0, credit: 1000000, yearDebit: 0, yearCredit: 0 },
        { accountCode: '5001', debit: 0, credit: 0, yearDebit: 0, yearCredit: 300000 },
      ],
    });
    const ledger = new FinanceLedger(s);
    const voucher = ledger.create(maker, {
      requestId: 'income',
      date: '2026-03-10',
      description: '虚构收入',
      entries: [entry('1002', 50000, 0, null, '销售商品收到的现金'), entry('5001', 0, 50000)],
    });
    post(s, voucher.header.id);
    const read = (name: string, extra: Record<string, unknown> = {}) =>
      readFinanceTool(s, maker, name, { period: '2026-03', ...extra }, quietLog);
    const trial = withRows.parse(read('finance.reports', { kind: 'trial' }));
    const cash = trial.rows.find((r) => r.account_code === '1002');
    assert.equal(cash?.ending, '10500.00', '科目期末余额');
    assert.equal(cash?.year_debit, '3500.00', '本年累计借方');
    assert.equal(trial.rows.find((r) => r.account_code === '5001')?.year_credit, '3500.00');
    const profit = withLines.parse(read('finance.reports', { kind: 'profit' }));
    assert.equal(profit.netProfit, '500.00');
    assert.equal(profit.yearProfit, '3500.00', '利润表本年数');
    assert.ok(profit.lines.some((l) => l.ytd === '3500.00'), '利润表各行本年累计');
    const balance = fields.parse(read('finance.reports', { kind: 'balance' }));
    assert.equal(balance.difference, '0.00', '资产负债表差额');
    assert.equal(balance.totalAssets, '10500.00');
    // 每个工具返回的整数字段，要么是金额（已换成元的文字），要么在下面登记过不是金额，免得新字段又漏掉
    const notMoney = new Set([
      'id', 'version', 'page', 'pageSize', 'filteredRecords', 'count', 'events', 'pendingApproval', 'missing',
      'missingPrice', 'missingTax', 'missing_tax', 'position', 'number', 'entries', 'enabled', 'event_id',
      'voucher_id', 'reversal_of', 'opening_id', 'estimate_voucher_id', 'days_to_due', 'original_id',
      'transfer_voucher_id', 'attachment_id', 'attachment_count',
    ]);
    const leftovers = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== 'object') return;
      for (const [key, v] of Object.entries(value)) {
        if (typeof v === 'number' && Number.isInteger(v) && !notMoney.has(key)) leftovers.add(key);
        if (typeof v === 'number' && financeMoneyFields.has(key)) leftovers.add(key + '（金额没换）');
        walk(v);
      }
    };
    for (const name of financeReadTools)
      for (const kind of name === 'finance.reports' ? ['trial', 'balance', 'profit', 'cashflow'] : [undefined])
        walk(read(name, kind ? { kind } : {}));
    assert.deepEqual([...leftovers], [], '没登记的整数字段');
  } finally {
    s.close();
  }
});

test('四位小数单价先整单取整，用最大余数分配，税额与价税合计相等', () => {
  const exact = deliveryLineExact('1.500', '0.0150');
  assert.equal(exact, '0.0225000');
  const money = documentMoney(Array.from({ length: 3 }, () => ({ exact: '0.0150', mode: '未税', rate: '0%' })));
  assert.equal(money.gross, 5);
  assert.deepEqual(
    money.lines.map((entry) => entry.gross),
    [2, 2, 1],
  );
  const included = documentMoney([{ exact: '113.0000', mode: '含税', rate: '13%' }]);
  assert.deepEqual([included.net, included.tax, included.gross], [10000, 1300, 11300]);
  assert.throws(() => documentMoney([{ exact: '100.00', mode: '含税', rate: '' }]), /缺少税率/);
});

test('多行分摊补的那一分落在余数最大的行；余数相同时落在靠前的行；各行加起来等于整单', () => {
  const line = (exact: string) => ({ exact, mode: '未税', rate: '0' });
  // 0.1、0.9、0.5 分：整单 1.5 → 2 分，补给余数 0.9 和 0.5 的两行
  const uneven = documentMoney(['0.001', '0.009', '0.005'].map(line));
  assert.deepEqual(uneven.lines.map((l) => l.gross), [0, 1, 1]);
  // 0.3、0.5、0.5 分：整单 1.3 → 1 分，后两行余数相同，给靠前的第二行
  const tied = documentMoney(['0.003', '0.005', '0.005'].map(line));
  assert.deepEqual(tied.lines.map((l) => l.gross), [0, 1, 0]);
  for (const money of [uneven, tied]) {
    assert.equal(money.lines.reduce((n, l) => n + l.gross, 0), money.gross);
    assert.equal(money.lines.reduce((n, l) => n + l.net, 0), money.net);
  }
});

test('未税口径填的就是不含税额，价税合计另加税；含税口径填的是价税合计，不含税额倒算', () => {
  const untaxed = documentMoney([
    { exact: '10.005', mode: '未税', rate: '13' },
    { exact: '20.004', mode: '未税', rate: '13' },
  ]);
  // 不含税 1000.5 + 2000.4 = 3000.9 → 3001 分；价税 1130.565 + 2260.452 = 3391.017 → 3391 分
  assert.deepEqual([untaxed.net, untaxed.tax, untaxed.gross], [3001, 390, 3391]);
  assert.deepEqual(untaxed.lines.map((l) => [l.net, l.tax, l.gross]), [[1001, 130, 1131], [2000, 260, 2260]]);
  const plain = documentMoney([{ exact: '100.00', mode: '不含税', rate: '13' }]);
  assert.deepEqual([plain.net, plain.tax, plain.gross], [10000, 1300, 11300]);
  // 同样填 100 元，含税口径：100 / 1.13 = 88.4956 → 8850 分不含税
  const included = documentMoney([{ exact: '100.00', mode: '含税', rate: '13' }]);
  assert.deepEqual([included.net, included.tax, included.gross], [8850, 1150, 10000]);
});

test('跨行税率不同、各行独立取整会出负税额时：从有正税额的行挪一分，每行税额不为负，整单不含税额和价税合计不变', () => {
  const money = documentMoney([
    { exact: '0.005', mode: '未税', rate: '0' },
    { exact: '0.005', mode: '未税', rate: '13' },
  ]);
  assert.deepEqual([money.net, money.gross, money.tax], [1, 1, 0]);
  assert.ok(money.lines.every((l) => l.tax >= 0), JSON.stringify(money.lines));
  assert.equal(money.lines.reduce((n, l) => n + l.net, 0), money.net);
  assert.equal(money.lines.reduce((n, l) => n + l.gross, 0), money.gross);
});

test('金额写坏、税率超过 100%、口径没写清、数量小数超过 3 位：报中文错，不算出金额', () => {
  assert.throws(() => documentMoney([{ exact: '1,000', mode: '未税', rate: '0' }]), /无法解析精确金额/);
  assert.throws(() => documentMoney([{ exact: '100', mode: '未税', rate: '101' }]), /税率超出范围/);
  assert.throws(() => documentMoney([{ exact: '100', mode: '', rate: '13' }]), /含税口径未明确/);
  assert.throws(() => deliveryLineExact('1.2345', '1.0000'), /数量单位无法换算/);
});
