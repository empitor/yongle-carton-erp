// 待补税率的收付核销和批量补税、税率来源、账期和分期、现结优惠（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/index.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceReports, FinanceInfoPending } from '../server/finance/reports/reports.js';
import { FinanceMonthly } from '../server/finance/reports/monthly.js';
import { FinanceDue } from '../server/finance/parties/due.js';
import { documentMoney } from '../server/finance/base/amounts.js';
import { dueDate, installments, termOptions } from '../server/finance/parties/terms.js';
import { physical, deliveryDoc, funds, maker, newSettings, postDrafts, event, obligation, obligationRow } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';
import { FinanceCashAccounts } from '../server/finance/cash/cash-accounts.js';
import { FinanceSettlements } from '../server/finance/cash/settlements.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/events/event-handling.js';
import { readSnapshot } from '../server/finance/events/source-snapshot.js';

test('财务不卡业务：订单和供应商都没写税率时，送货、到货照常确认，收款照常核销到理论金额往来；只有正式报表和结账被拦，补完税率放行', async () => {
  const t = await flowFinance();
  try {
    const s = t.f.store;
    const parties = new FinanceParties(s);
    // 供应商的默认税率清掉（底子里设过未税 0），客户订单本来就没写税率
    const supplierTerms = parties.getTerms(maker, 'supplier', t.f.supplier.id);
    parties.saveTerms(maker, {
      kind: 'supplier',
      partyId: t.f.supplier.id,
      termDays: 0,
      taxRate: null,
      taxMode: null,
      version: Number(supplierTerms?.version),
      requestId: 'supplier-no-tax',
    });
    const untaxed = t.f.order(100);
    const sent = t.deliver('10', [untaxed]);
    const arrival = t.receive('100', '虚构供应商单号-税');
    assert.equal(t.f.flow.get(sent.id).status, 'confirmed', '送货照常确认');
    assert.equal(t.f.flow.get(arrival.id).status, 'confirmed', '到货照常确认');
    t.sync();
    assert.deepEqual([t.current(sent.id).status, t.current(arrival.id).status], ['info_pending', 'info_pending']);
    const monthly = new FinanceMonthly(s).get(maker, { period: '2026-10' });
    assert.equal(monthly.missingTax, 2);
    assert.deepEqual([monthly.theoreticalIncome, monthly.theoreticalExpense], [1000, 10000], '理论金额先进账');
    // 收款照常核销到按理论金额挂的应收
    const [receivable] = t.active('delivery', sent.id);
    assert.equal(Number(receivable.amount_cents), 1000);
    new FinanceCashAccounts(s).saveAccount(maker, { kind: 'bank', name: '虚构资金账户', accountCode: '1002', lastFour: '0001', requestId: 'bank' });
    funds(s, new FinanceSettlements(s), { kind: 'receipt', date: '2026-10-28', amount: 1000 }, [
      { obligationId: Number(receivable.id), version: Number(receivable.version), amount: 1000 },
    ]);
    // 只有正式报表和结账被拦
    const pending = (error: unknown) => error instanceof FinanceInfoPending && error.code === 'FINANCE_INFO_PENDING';
    assert.throws(() => new FinanceReports(s).get(maker, 'balance', { period: '2026-10' }), pending);
    assert.equal(t.closingOk(), false);
    // 补税率：客户按 13%，供应商不含税
    const handling = new FinanceEventHandling(s);
    handling.resolveBatch(maker, { kind: 'customer', partyId: t.f.customer.id, period: '2026-10', rate: '13', mode: '未税', requestId: 'customer-batch' });
    const e = t.current(arrival.id);
    handling.resolveBatch(maker, { items: [{ id: Number(e.id), version: Number(e.version) }], noTax: true, requestId: 'no-tax' });
    postDrafts(s);
    assert.equal(Number(t.active('delivery', sent.id)[0].amount_cents), 1130, '补完税率按含税入账，往来还是原来那一条');
    assert.equal(new FinanceReports(s).get(maker, 'balance', { period: '2026-10' }).balanced, true);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

/** 客户按月结账期（3 个月、25 号付、25 号截止）、含税 13%，带现结优惠和两期分期；1 月 26 日送货 100 元生成凭证并记账 */
function monthlyTermsDelivery(s: Store) {
  const cash = newSettings(s),
    parties = new FinanceParties(s),
    events = new FinanceEvents(s),
    due = new FinanceDue(s);
  const options = {
    discounts: [{ type: 'days', days: 10, rate: '2' }],
    installments: [
      { rate: '30', rule: { type: 'days', days: 15 } },
      { rate: '70', rule: { type: 'monthly', months: 3, paymentDay: 25 } },
    ],
  };
  parties.saveTerms(maker, {
    kind: 'customer',
    partyId: 1,
    termType: 'monthly',
    termMonths: 3,
    paymentDay: 25,
    cutoffDay: 25,
    taxRate: '13',
    taxMode: '含税',
    options,
    requestId: 'term',
  });
  physical(s, 1, 'delivery', '2026-01-26', deliveryDoc('1', { price: '100.0000', taxed: false, line: { taxRate: '0', taxMode: '未明确' } }));
  events.sync(maker);
  new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
  postDrafts(s);
  const o = obligation(s, 1);
  return { cash, parties, due, options, o };
}

test('税率来源和账期：明细没写清的口径取往来单位默认；按月账期的到期日和月底边界；分期合计正好等于金额；两百行取整不出负数', () => {
  const s = new Store(':memory:');
  try {
    const { options, o } = monthlyTermsDelivery(s);
    assert.deepEqual(readSnapshot(event(s, 1)).taxSource, [
      { mode: 'party', rate: 'line' },
    ]);
    assert.equal(o.due_date, '2026-05-25');
    assert.equal(
      dueDate('2027-12-25', {
        term_type: 'monthly',
        term_months: 2,
        payment_day: 31,
        cutoff_day: 25,
      }),
      '2028-02-29',
    );
    assert.equal(
      dueDate('2027-12-26', {
        term_type: 'monthly',
        term_months: 2,
        payment_day: 31,
        cutoff_day: 25,
      }),
      '2028-03-31',
    );
    assert.equal(dueDate('2026-01-31', { term_type: 'days', term_days: 30 }), '2026-03-02');
    assert.throws(
      () => termOptions.parse({ installments: [{ rate: '99', rule: { type: 'days', days: 0 } }] }),
      /100%/,
    );
    const split = installments(3, '2026-01-26', { options: JSON.stringify(options) });
    assert.equal(
      split.reduce((n, r) => n + r.amount, 0),
      3,
    );
    const many = documentMoney(
      Array.from({ length: 200 }, () => ({ exact: '0.0050', mode: '未税', rate: '0' })),
    );
    assert.equal(many.gross, 100);
    assert.ok(many.lines.every((r) => r.gross >= 0));
  } finally {
    s.close();
  }
});

test('收付计划和现结优惠：按分期预测、优惠期内收款扣优惠；改账期不改旧往来，手工改到期日留审计', () => {
  const s = new Store(':memory:');
  try {
    const { cash, parties, due, o } = monthlyTermsDelivery(s);
    const plan = due.plan(maker, { date: '2026-01-31', months: 5 });
    assert.equal(plan.forecast.find((r) => r.period === '2026-02')?.receivable, 3000);
    assert.equal(due.discounts(maker, { date: '2026-02-01' }).rows[0].offer.amount, 200);
    assert.equal(due.discounts(maker, { date: '2026-02-10' }).filteredRecords, 0);
    funds(s, cash, { kind: 'receipt', date: '2026-02-01', amount: 9800 }, [
      { obligationId: o.id, version: o.version, amount: 10000, discount: 200 },
    ]);
    const data = new FinanceMonthly(s).get(maker, { period: '2026-02' });
    assert.equal(data.discountExpense, 200);
    assert.equal(data.actualIncome, 9800);
    assert.equal(
      due
        .plan(maker, { date: '2026-02-01', months: 5 })
        .forecast.reduce((n, r) => n + r.receivable, 0),
      0,
    );
    parties.saveTerms(maker, {
      kind: 'customer',
      partyId: 1,
      termDays: 45,
      version: 1,
      requestId: 'change-term',
    });
    assert.equal(obligation(s, 1).due_date, '2026-05-25');
    const preview = due.preview(maker, { kind: 'receivable', partyId: '1' });
    assert.equal(preview.rows.length, 0);
    const result = due.change(maker, o.id, {
      version: 2,
      requestId: 'manual-date',
      dueDate: '2026-06-25',
      reason: '虚构约定',
    });
    assert.equal(result.due_date, '2026-06-25');
    assert.ok(
      s.db
        .prepare("SELECT id FROM business_audit WHERE action='due_change' AND record_id=?")
        .get(o.id),
    );
  } finally {
    s.close();
  }
});

test('账期“没有约定”单独保存：到期日留空，读回来还是没有约定，和压 0 天区分开', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01');
    const parties = new FinanceParties(s),
      due = new FinanceDue(s);
    parties.saveTerms(maker, {
      kind: 'customer',
      partyId: 1,
      termType: 'none',
      termDays: 30,
      taxRate: '13',
      requestId: 'terms-none',
    });
    const terms = () => {
      const found = parties.getTerms(maker, 'customer', 1);
      assert.ok(found, '读得到客户的账期');
      return found;
    };
    const saved = terms();
    assert.equal(saved.term_type, 'none', '读回来仍是没有约定');
    assert.equal(saved.tax_rate, '13', '税率等其他规则照常保存');
    assert.equal(saved.term_months, null);
    assert.equal(dueDate('2026-01-10', saved), null, '没有约定时到期日留空');
    const open = parties.create(maker, {
      requestId: 'ob-none',
      kind: 'receivable',
      partyId: 1,
      date: '2026-01-10',
      amount: 5000,
      description: '虚构应收',
      counterAccount: '5001',
    });
    assert.equal(open.due_date, null);
    const held = due.held(maker, { kind: 'receivable', date: '2026-03-01' }).rows[0];
    assert.equal(Number(held.no_terms), 5000, '算进没有约定，不算到期');
    assert.equal(Number(held.due), 0);
    parties.saveTerms(maker, {
      kind: 'customer',
      partyId: 1,
      termType: 'days',
      termDays: 0,
      version: Number(saved.version),
      requestId: 'terms-zero',
    });
    const zero = terms();
    assert.equal(zero.term_type, 'days');
    assert.equal(dueDate('2026-01-10', zero), '2026-01-10', '压 0 天是当天到期');
  } finally {
    s.close();
  }
});

test('按新账期重算到期日：预览以后到期日又被人改过，带旧摘要重算被拒（409 preview-changed）、什么都不改；重新预览后照常重算', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01');
    const parties = new FinanceParties(s),
      due = new FinanceDue(s);
    parties.saveTerms(maker, { kind: 'customer', partyId: 1, termType: 'days', termDays: 30, requestId: 'terms-30' });
    const open = parties.create(maker, {
      requestId: 'ob-30',
      kind: 'receivable',
      partyId: 1,
      date: '2026-01-10',
      amount: 5000,
      description: '虚构应收',
      counterAccount: '5001',
    });
    const moved = due.change(maker, open.id, { version: open.version, requestId: 'manual-1', dueDate: '2026-03-01', reason: '虚构约定' });
    const query = { kind: 'receivable', partyId: '1' } as const;
    const stale = due.preview(maker, query);
    assert.equal(stale.rows.length, 1);
    due.change(maker, open.id, { version: moved.version, requestId: 'manual-2', dueDate: '2026-03-15', reason: '虚构再约定' });
    assert.throws(
      () => due.recalculate(maker, { ...query, requestId: 'recalc-stale', digest: stale.digest, reason: '虚构重算' }),
      (e: unknown) =>
        typeof e === 'object' && e !== null && 'status' in e && e.status === 409 && 'code' in e && e.code === 'preview-changed',
    );
    assert.equal(obligationRow(s, open.id).due_date, '2026-03-15', '被拒时一条都不改');
    const fresh = due.preview(maker, query);
    due.recalculate(maker, { ...query, requestId: 'recalc', digest: fresh.digest, reason: '虚构重算' });
    assert.equal(obligationRow(s, open.id).due_date, '2026-02-09');
  } finally {
    s.close();
  }
});
