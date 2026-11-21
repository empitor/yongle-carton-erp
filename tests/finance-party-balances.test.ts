// 应收应付按单位、超授信、到货详情的财务一段（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceOverview } from '../server/finance/overview.js';
import { FinanceDue } from '../server/finance/due.js';
import { FinanceStatements } from '../server/finance/statements.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, arrivalDoc, event, funds, reverseSource } from './finance-fixture.js';
import { businessBase } from './business-base-fixture.js';

test('到货详情的财务一段：应付一侧也成对显示，不列被替代的事件', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    physical(s, 1, 'arrival', '2026-01-10', arrivalDoc('10'));
    events.sync(maker, { requestId: 'scan' });
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'g' });
    postDrafts(s);
    const overview = new FinanceOverview(s);
    assert.deepEqual(
      overview.related(maker, 'arrival', 1, {}).rows.map((r) => [r.status, r.obligation_amount]),
      [['generated', 10000]],
    );
    reverseSource(s, 1, '2026-01-20');
    assert.deepEqual(
      overview.related(maker, 'arrival', 1, {}).rows.map((r) => [r.reversal_state, r.obligation_amount]),
      [
        ['reversed', 10000],
        ['reversal', -10000],
      ],
    );
    assert.deepEqual(overview.related(maker, 'delivery', 1, {}).rows, [], '送货一侧查不到这张到货单');
  } finally {
    s.close();
  }
});

/** 1 月 5 日已记账送货 100 元、1 月 3 日预收 50 元、1 月 15 日没记账的送货 200 元；返回收付款服务 */
function advanceAndDeliveries(s: Store) {
  const cash = newSettings(s),
    events = new FinanceEvents(s);
  physical(s, 1, 'delivery', '2026-01-05', deliveryDoc('1'));
  events.sync(maker, { requestId: 'scan-1' });
  new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate-1' });
  // 1 月 3 日收款 50 元：那天还没有欠款，直接记预收
  funds(s, cash, { kind: 'receipt', date: '2026-01-03', amount: 5000 });
  postDrafts(s);
  // 1 月 15 日再送一次货，凭证还没记账：按单位、对账单都算
  physical(s, 2, 'delivery', '2026-01-15', deliveryDoc('2'));
  events.sync(maker, { requestId: 'scan-2' });
  new FinanceEventVouchers(s).generate(maker, event(s, 2).id, { version: 1, requestId: 'generate-2' });
  return cash;
}

test('应收应付“按单位”：列出预收（预付），还欠和对账单期末一致（含没记账的送货）；只有预付没有欠款的单位也列出来', () => {
  const s = new Store(':memory:');
  try {
    const cash = advanceAndDeliveries(s),
      due = new FinanceDue(s);
    // 收款凭证的“来源”带上那笔收款（类型、日期、金额），界面写“收客户款 01-03 50.00”，不露收付款的内部编号
    const receiptVoucher = s.db.prepare("SELECT id FROM fin_vouchers WHERE module_source='cash' ORDER BY id LIMIT 1").get()?.id;
    const source = new FinanceLedger(s).get(maker, receiptVoucher).source;
    assert.ok(source && 'record' in source, '收款凭证的来源是收付款这个财务功能');
    assert.deepEqual({ ...source.record }, { kind: 'receipt', date: '2026-01-03', amount: 5000 });
    const party = (kind: 'receivable' | 'payable', date: string) => {
      const data = due.held(maker, { kind, date });
      return { row: data.rows.find((r) => String(r.party_id) === '1'), totals: data.totals };
    };
    const statementOf = (kind: 'receivable' | 'payable', to: string) =>
      new FinanceStatements(s).statement(maker, { kind, partyId: '1', from: '2026-01-01', to });

    const end = party('receivable', '2026-01-31');
    assert.ok(end.row, '客户在按单位里');
    const statement = statementOf('receivable', '2026-01-31');
    assert.equal(Number(end.row.held) + Number(end.row.due) + Number(end.row.no_terms), 30000, '欠款单子照旧按单据算');
    assert.equal(Number(end.row.advance), 5000, '预收款单独一列');
    assert.equal(Number(end.row.advance), statement.advance, '和对账单的预收一致');
    assert.equal(Number(end.row.net), 25000, '还欠扣掉预收');
    assert.equal(Number(end.row.net), statement.closing, '还欠 = 对账单期末');
    assert.deepEqual([end.totals.advance, end.totals.net], [5000, 25000], '页顶合计也有预收和还欠');

    // 截至 1 月 10 日：第二次送货还没发生，欠的 100 正好被预收抵掉一半
    const early = party('receivable', '2026-01-10');
    assert.ok(early.row, '1 月 10 日客户也在按单位里');
    assert.equal(Number(early.row.net), statementOf('receivable', '2026-01-10').closing);
    assert.equal(Number(early.row.net), 5000);

    // 应付一侧：只付了预付款、还没有到货，单位照样列出来，还欠是负数
    funds(s, cash, { kind: 'payment', date: '2026-01-04', amount: 3000 });
    postDrafts(s);
    const supplier = party('payable', '2026-01-31');
    assert.ok(supplier.row, '只有预付的供应商也在按单位里');
    assert.ok(supplier.row.party_name, '有单位名称');
    assert.deepEqual(
      [Number(supplier.row.held), Number(supplier.row.due), Number(supplier.row.no_terms)],
      [0, 0, 0],
    );
    assert.equal(Number(supplier.row.advance), 3000);
    assert.equal(Number(supplier.row.net), -3000);
    assert.equal(Number(supplier.row.net), statementOf('payable', '2026-01-31').closing, '还欠 = 对账单期末');
  } finally {
    s.close();
  }
});

test('应收应付“按单位”：超授信按还欠算（扣掉预收、预付），和“还欠”同一口径；还欠是负数不算超', () => {
  const s = new Store(':memory:');
  try {
    const cash = advanceAndDeliveries(s),
      parties = new FinanceParties(s),
      due = new FinanceDue(s);
    // 客户授信 200 元；供应商授信 0 元
    parties.saveTerms(maker, { kind: 'customer', partyId: 1, termDays: 30, creditLimit: 20000, requestId: 'terms-c' });
    parties.saveTerms(maker, { kind: 'supplier', partyId: 1, termDays: 30, creditLimit: 0, requestId: 'terms-s' });
    const row = (kind: 'receivable' | 'payable', date: string) => {
      const found = due.held(maker, { kind, date }).rows.find((r) => String(r.party_id) === '1');
      assert.ok(found, '单位 1 在按单位里');
      return found;
    };

    const end = row('receivable', '2026-01-31');
    assert.equal(Number(end.held) + Number(end.due) + Number(end.no_terms), 30000, '欠款单子 300 元');
    assert.equal(Number(end.net), 25000, '还欠扣掉 50 元预收');
    // 按欠款单子算会是 300 − 200 = 100 元；预收的 50 元抵授信，超 50 元
    assert.equal(Number(end.over_limit), 5000, '超授信 = 还欠 − 授信');
    assert.equal(Number(end.over_limit), Number(end.net) - Number(end.credit_limit));

    // 截至 1 月 10 日：还欠 50 元，没超
    assert.equal(Number(row('receivable', '2026-01-10').over_limit), 0);

    // 只付了 30 元预付款的供应商：还欠 −30 元，授信 0 也不算超
    funds(s, cash, { kind: 'payment', date: '2026-01-04', amount: 3000 });
    postDrafts(s);
    const supplier = row('payable', '2026-01-31');
    assert.equal(Number(supplier.net), -3000);
    assert.equal(Number(supplier.over_limit), 0, '还欠是负数不算超授信');
  } finally {
    s.close();
  }
});

test('账龄边界与到期提醒分开；没有账期的欠款单独一档，不按天数进 1–30 天', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    businessBase(maker, s).customer({ name: '虚构客户乙' });
    const parties = new FinanceParties(s);
    // 客户 1 压 10 天，客户 2 没设账期
    parties.saveTerms(maker, { requestId: 'term', kind: 'customer', partyId: 1, termDays: 10 });
    const items: [number, string][] = [[1, '2026-01-01'], [1, '2026-01-02'], [1, '2026-01-31'], [2, '2026-01-02']];
    for (const [i, [partyId, date]] of items.entries())
      parties.create(maker, {
        requestId: 'ar-' + i,
        kind: 'receivable',
        partyId,
        date,
        amount: 100,
        description: '虚构账龄',
        counterAccount: '5001',
      });
    postDrafts(s);
    const totalsOf = (basis: 'document' | 'due') =>
      parties.aging(maker, { kind: 'receivable', date: '2026-02-01', basis }).totals.map((r) => [r.bucket, r.count]);
    // 按单据日：31 天进 31–60，30 天和 1 天进 1–30；客户 2 那笔 30 天，但没有账期，单独一档（-1）放最后
    assert.deepEqual(totalsOf('document'), [[1, 2], [2, 1], [-1, 1]]);
    // 按到期日：01-11、01-12 到期的逾期 21、20 天，02-10 到期的没到期；没有账期的仍单独一档，不按单据日算进 1–30
    assert.deepEqual(totalsOf('due'), [[0, 1], [1, 2], [-1, 1]]);
    // 逐笔和合计读同一列
    const rows = parties.aging(maker, { kind: 'receivable', date: '2026-02-01' }).rows;
    assert.deepEqual(
      rows.map((r) => [r.date, r.bucket]),
      [['2026-01-01', 2], ['2026-01-02', -1], ['2026-01-02', 1], ['2026-01-31', 1]],
    );
    // 只看逾期：没有账期的不算逾期
    assert.equal(
      parties.aging(maker, { kind: 'receivable', date: '2026-02-01', overdue: '1' }).filteredRecords,
      2,
    );
  } finally {
    s.close();
  }
});
