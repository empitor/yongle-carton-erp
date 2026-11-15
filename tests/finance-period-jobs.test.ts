// 月末的折旧、工资分次发、损益结转和 12 月年度利润结转（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { entry } from '../server/finance/query.js';
import { maker, newSettings, postDrafts, ledgerBalance } from './finance-fixture.js';
import { z } from 'zod';

/** 结账检查的“损益结转”那一步（找不到就让测试失败） */
function profitStepOf(check: ReturnType<FinanceClosing['check']>) {
  const step = check.steps.find((x) => x.key === 'profit');
  assert.ok(step && 'annualNext' in step, '结账检查有“损益结转”这一步');
  return step;
}
/** 工资计提执行记录的明细里记的应付工资科目 */
const payrollDetails = z.object({ wagesAccount: z.unknown() });

test('平均年限折旧从下月开始，尾差提足后停止', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const assets = new FinanceAssets(s);
    assets.add(maker, {
      requestId: 'asset',
      number: 'FICT-ASSET-02',
      name: '虚构设备',
      category: '设备',
      original: 10001,
      date: '2026-01-20',
      months: 2,
      residualBp: 1000,
      department: '虚构部门',
      expenseAccount: '560205',
      counterAccount: '1002',
      cashFlow: '购建固定资产支付的现金',
    });
    postDrafts(s);
    const amounts = [];
    for (const period of ['2026-01', '2026-02', '2026-03', '2026-04']) {
      assets.depreciate(maker, { period, requestId: 'depreciation-' + period });
      postDrafts(s);
      amounts.push(Number(assets.depreciation(maker, { period }).rows[0]?.amount_cents ?? 0));
    }
    assert.deepEqual(amounts, [0, 4501, 4500, 0]);
  } finally {
    s.close();
  }
});

test('结转损益后又补录了损益，结账检查这一步提示补做，补完才能结账', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01', 100000);
    const assets = new FinanceAssets(s),
      payroll = new FinancePayroll(s),
      cost = new FinanceCosting(s),
      closing = new FinanceClosing(s),
      period = '2026-01';
    assets.depreciate(maker, { period, requestId: 'depr' });
    payroll.confirm(maker, { period, requestId: 'payroll' });
    postDrafts(s);
    cost.run(maker, { period, requestId: 'cost' });
    postDrafts(s);
    closing.accrueTax(maker, { period, requestId: 'tax' });
    postDrafts(s);
    closing.settleProfit(maker, { period, requestId: 'profit-first' });
    postDrafts(s);
    assert.ok(closing.check(maker, { period }).canClose, '结转完可以结账');
    new FinanceLedger(s).create(maker, {
      requestId: 'late-income',
      date: '2026-01-30',
      description: '虚构结转后补录的收入',
      entries: [entry('1002', 500, 0, null, '收到其他经营活动现金'), entry('5301', 0, 500)],
    });
    postDrafts(s);
    const stale = closing.check(maker, { period });
    const step = profitStepOf(stale);
    assert.equal(step.ok, false, '检查页这一步不能显示完成');
    assert.equal(step.stale, true);
    assert.equal(stale.canClose, false);
    closing.settleProfit(maker, { period, requestId: 'profit-supplement' });
    postDrafts(s);
    const fixed = closing.check(maker, { period });
    assert.equal(profitStepOf(fixed).stale, false);
    assert.ok(fixed.canClose, JSON.stringify(fixed.steps));
    closing.close(maker, { period, version: fixed.record?.version, requestId: 'close' });
  } finally {
    s.close();
  }
});

test('工资可以分几次发：月中先发一部分，月底补发剩下的，不能早于工资月份，累计不能超过实发', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01', 100000);
    const payroll = new FinancePayroll(s),
      reports = new FinanceReports(s),
      period = '2026-02';
    payroll.save(maker, {
      period,
      requestId: 'wages',
      rows: [
        {
          employeeId: 'e-1',
          employeeName: '虚构员工',
          department: '虚构部门',
          accountCode: '560204',
          gross: 300,
          social: 0,
          housing: 0,
          tax: 0,
          net: 300,
          employerSocial: 0,
          employerHousing: 0,
        },
      ],
    });
    payroll.confirm(maker, { period, requestId: 'accrue' });
    postDrafts(s);
    const pay = (requestId: string, date: string, amount?: number) =>
      payroll.pay(maker, { period, date, accountId: 1, requestId, ...(amount ? { amount } : {}) });
    assert.throws(() => pay('before-month', '2026-01-10', 100), /不能早于工资月份/, '2 月工资不能记到 1 月');
    pay('advance', '2026-02-15', 100);
    postDrafts(s);
    const job = s.db.prepare("SELECT details FROM fin_period_jobs WHERE period=? AND kind='payroll'").get(period);
    const wagesAccount = String(payrollDetails.parse(JSON.parse(String(job?.details))).wagesAccount);
    const owed = () => reports.balances(maker, period).filter((r) => r.account_code === wagesAccount).reduce((n, r) => n + r.ending, 0);
    assert.equal(owed(), -200, '先发 1 元，应付工资还剩 2 元（贷方）');
    assert.deepEqual(
      (({ net, paid, remaining, payments }) => ({ net, paid, remaining, payments }))(
        payroll.paymentStatus(maker, { period }),
      ),
      { net: 300, paid: 100, remaining: 200, payments: 1 },
    );
    assert.throws(() => pay('too-much', '2026-02-28', 250), /还剩 2\.00 元/);
    assert.throws(() => pay('final-early', '2026-02-20'), /不能早于月末/);
    pay('rest', '2026-02-28');
    postDrafts(s);
    assert.equal(payroll.paymentStatus(maker, { period }).remaining, 0);
    assert.throws(() => pay('again', '2026-02-28', 1), /已全部发放/);
    assert.equal(owed(), 0, '应付工资发完清零');
  } finally {
    s.close();
  }
});

test('12 月先月末损益结转再年度利润结转；年度结转后又补了损益，年度利润也要补结转，本年利润清零才能结账', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-12', 100000);
    const assets = new FinanceAssets(s),
      payroll = new FinancePayroll(s),
      cost = new FinanceCosting(s),
      closing = new FinanceClosing(s),
      period = '2026-12';
    assets.depreciate(maker, { period, requestId: 'depr' });
    payroll.confirm(maker, { period, requestId: 'payroll' });
    postDrafts(s);
    cost.run(maker, { period, requestId: 'cost' });
    postDrafts(s);
    closing.accrueTax(maker, { period, requestId: 'tax' });
    postDrafts(s);
    const profitStep = () => profitStepOf(closing.check(maker, { period }));
    assert.equal(profitStep().annualNext, false, '月末损益还没结转时不该走年度');
    closing.settleProfit(maker, { period, requestId: 'profit' });
    postDrafts(s);
    assert.equal(profitStep().annualNext, true);
    closing.settleProfit(maker, { period, annual: true, requestId: 'annual' });
    postDrafts(s);
    assert.ok(closing.check(maker, { period }).canClose, '年度结转完可以结账');
    new FinanceLedger(s).create(maker, {
      requestId: 'late-income',
      date: '2026-12-30',
      description: '虚构年度结转后补录的收入',
      entries: [entry('1002', 500, 0, null, '收到其他经营活动现金'), entry('5301', 0, 500)],
    });
    postDrafts(s);
    closing.settleProfit(maker, { period, requestId: 'profit-supplement' });
    postDrafts(s);
    const stale = closing.check(maker, { period });
    const step = profitStepOf(stale);
    assert.equal(step.stale, false, '月末损益已补做');
    assert.equal(step.annualStale, true, '本年利润又有余额');
    assert.equal(step.annualNext, true);
    assert.equal(step.ok, false);
    assert.equal(stale.canClose, false);
    const record = stale.record;
    assert.ok(record, '有 12 月的结账记录');
    assert.throws(
      () => closing.close(maker, { period, version: record.version, requestId: 'close-early' }),
      /结账检查未通过/,
    );
    closing.settleProfit(maker, { period, annual: true, requestId: 'annual-supplement' });
    postDrafts(s);
    const fixed = closing.check(maker, { period });
    assert.equal(profitStepOf(fixed).annualStale, false);
    assert.ok(fixed.canClose, JSON.stringify(fixed.steps));
    assert.equal(ledgerBalance(s, '3103', period), 0, '本年利润清零');
    assert.equal(ledgerBalance(s, '3104', period), -500, '利润转入未分配利润');
    closing.close(maker, { period, version: fixed.record?.version, requestId: 'close' });
  } finally {
    s.close();
  }
});
