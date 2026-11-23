// 一笔收款跨多张单据、多个收款冲同一往来、欠款按单位的合计（全部是虚构数据，只用内存库）
import { sales } from '../../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../server/core/index.js';
import { customerSchema } from '../../shared/core/domain.js';
import { FinanceParties } from '../../server/finance/parties/parties.js';
import { FinanceEvents } from '../../server/finance/events/events.js';
import { FinanceMonthly } from '../../server/finance/reports/monthly.js';
import { FinanceBank } from '../../server/finance/cash/bank.js';
import { FinanceDue } from '../../server/finance/parties/due.js';
import { physical, deliveryDoc, funds, maker, newSettings, postDrafts, event, obligation } from './finance-fixture.js';
import { FinanceEventVouchers } from '../../server/finance/events/event-voucher.js';
import { FinanceAllocations } from '../../server/finance/cash/allocations.js';

test('一笔收款跨多张来源单，多个收款单冲同一往来单，下钻合计等于实际收入', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      monthly = new FinanceMonthly(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1', { price: '100.00', taxed: false, line: { taxRate: '0', taxMode: '未税' } }));
    physical(s, 2, 'delivery', '2026-02-10', deliveryDoc('1', { price: '200.00', taxed: false, line: { taxRate: '0', taxMode: '未税' } }));
    events.sync(maker);
    for (const id of [1, 2])
      new FinanceEventVouchers(s).generate(maker, event(s, id).id, { version: 1, requestId: 'source-' + id });
    postDrafts(s);
    const a = obligation(s, 1),
      b = obligation(s, 2);
    funds(s, cash, { kind: 'receipt', date: '2026-04-01', amount: 22000 }, [
      { obligationId: a.id, version: a.version, amount: 10000 },
      { obligationId: b.id, version: b.version, amount: 10000 },
    ]);
    funds(s, cash, { kind: 'receipt', date: '2026-04-02', amount: 5000 }, [
      { obligationId: b.id, version: 2, amount: 5000 },
    ]);
    const data = monthly.get(maker, { period: '2026-04' });
    assert.equal(data.actualIncome, 27000);
    const split = Object.fromEntries(data.sources.map((r) => [r.source_month, r.amount]));
    assert.deepEqual(split, { '2026-01': 10000, '2026-02': 15000, unallocated: 2000 });
    const details = monthly.detail(maker, {
      period: '2026-04',
      metric: 'actualIncome',
      sourceMonth: '2026-02',
    });
    assert.equal(details.rows.length, 2);
    assert.equal(
      details.rows.reduce((n, r) => n + Number(r.amount), 0),
      15000,
    );
    assert.equal(data.theoreticalProfit, 0);
    const bank = new FinanceBank(s);
    bank.import(maker, {
      accountId: 1,
      requestId: 'bank-import',
      rows: [{ date: '2026-04-01', amount: 22000, reference: '虚构合并流水' }],
    });
    const grouped = bank.suggestions(maker, 1).find((x) => x.entries);
    assert.equal(grouped?.entries?.length, 3);
    bank.match(maker, 1, { version: 1, requestId: 'bank-group', entries: grouped?.entries });
    assert.equal(
      bank.reconcile(maker, {
        accountId: 1,
        from: '2026-04-01',
        to: '2026-04-30',
        bankBalance: 22000,
      }).difference,
      0,
    );
  } finally {
    s.close();
  }
});

test('欠款按单位：页顶合计按全部单位算，不只加当前页', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01');
    sales(s).createCustomer(customerSchema.parse({ name: '虚构客户二' }));
    sales(s).createCustomer(customerSchema.parse({ name: '虚构客户三' }));
    const parties = new FinanceParties(s);
    const owe = (partyId: number, amount: number, dueDate?: string) =>
      parties.create(maker, {
        requestId: 'owe-' + partyId + '-' + amount,
        kind: 'receivable',
        partyId,
        date: '2026-01-05',
        ...(dueDate ? { dueDate } : {}),
        amount,
        description: '虚构货款',
        counterAccount: '5001',
      });
    owe(1, 10000, '2026-01-10');
    owe(2, 20000, '2026-03-31');
    owe(3, 30000);
    postDrafts(s);
    const page = new FinanceDue(s).held(maker, { kind: 'receivable', date: '2026-02-01', pageSize: 1 });
    assert.equal(page.rows.length, 1, '一页只有一个单位');
    // 没有预收：还欠 = 三列之和，和对账单期末一致
    assert.deepEqual(page.totals, { held: 20000, due: 10000, no_terms: 30000, advance: 0, uninvoiced: 0, net: 60000 });
  } finally {
    s.close();
  }
});

test('实际收入、实际支出按收付款日归月：预收以后才核销，收入仍在收款那个月；撤销核销也不挪月份', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      monthly = new FinanceMonthly(s);
    // 1 月 10 日先收 300（没有可核销的往来，是预收），1 月 12 日先付 100
    const receipt = funds(s, cash, { kind: 'receipt', date: '2026-01-10', amount: 30000 });
    funds(s, cash, { kind: 'payment', date: '2026-01-12', amount: 10000 });
    // 2 月才送货、入账，2 月 5 日把预收核销到这笔应收上
    physical(s, 1, 'delivery', '2026-02-01', deliveryDoc('1', { price: '300.00', taxed: false, line: { taxRate: '0', taxMode: '未税' } }));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const allocations = new FinanceAllocations(s);
    const doc = s.db.prepare('SELECT version FROM fin_cash_documents WHERE id=?').get(receipt);
    allocations.allocate(maker, receipt, {
      requestId: 'allocate',
      version: Number(doc?.version),
      date: '2026-02-05',
      allocations: [{ obligationId: Number(obligation(s, 1).id), version: Number(obligation(s, 1).version), amount: 30000 }],
    });
    postDrafts(s);
    const jan = monthly.get(maker, { period: '2026-01' }),
      feb = monthly.get(maker, { period: '2026-02' });
    assert.deepEqual([jan.actualIncome, jan.actualExpense, jan.actualProfit], [30000, 10000, 20000]);
    assert.deepEqual([feb.actualIncome, feb.actualExpense], [0, 0]);
    // 2 月 20 日撤销这笔核销：钱转回预收，仍算 1 月收到的
    const allocation = s.db.prepare('SELECT id,version FROM fin_allocations WHERE cash_id=? AND amount_cents>0').get(receipt);
    allocations.revoke(maker, Number(allocation?.id), {
      requestId: 'revoke',
      version: Number(allocation?.version),
      date: '2026-02-20',
      reason: '虚构：核销错了',
    });
    postDrafts(s);
    assert.equal(monthly.get(maker, { period: '2026-01' }).actualIncome, 30000);
    assert.equal(monthly.get(maker, { period: '2026-02' }).actualIncome, 0);
  } finally {
    s.close();
  }
});
