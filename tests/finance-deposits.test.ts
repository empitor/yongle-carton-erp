// 保证金退回和转抵、压款利息（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store, many, one, rows } from '../server/core/index.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceMonthly } from '../server/finance/reports/monthly.js';
import { FinanceDepositsInterest } from '../server/finance/parties/deposits-interest.js';
import { physical, deliveryDoc, funds, maker, newSettings, postDrafts, event, obligation, booked } from './finance-fixture.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { overdueInterest } from '../server/finance/parties/terms.js';

/** 月度台账里没有单号的财务记录那一行的明细：叫法、日期、金额（交给拼单号的函数） */
const recordDetail = z.object({ recordKind: z.unknown(), recordDate: z.unknown(), recordTotal: z.unknown() });

/**
 * 客户 1 账期 30 天、按单据日起息年 36.5%、免息 5 天（deposits 为 true 时也收保证金），
 * 一张 01-01 的 100 元送货单入账记账。
 */
function interestDelivery(s: Store, deposits: boolean) {
  const term = new FinanceDepositsInterest(s),
    parties = new FinanceParties(s),
    events = new FinanceEvents(s);
  parties.saveTerms(maker, {
    requestId: 'term',
    kind: 'customer',
    partyId: 1,
    termDays: 30,
    options: {
      ...(deposits ? { deposits: true } : {}),
      interest: { rate: '36.5', unit: 'annual', basis: 'document', freeDays: 5 },
    },
  });
  physical(s, 1, 'delivery', '2026-01-01', deliveryDoc('1', { price: '100.00', taxed: false, line: { taxMode: '未税', taxRate: '0' } }));
  events.sync(maker);
  new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
  postDrafts(s);
  return { term, parties };
}

/** 01-03 收 10 元保证金记账，01-04 退回 2 元、01-05 转抵 3 元到送货单的应收，都记账；返回保证金 */
function depositRefundedAndApplied(s: Store, term: FinanceDepositsInterest) {
  const deposit = term.deposit(maker, {
    requestId: 'deposit',
    kind: 'received',
    partyKind: 'customer',
    partyId: 1,
    accountId: 1,
    date: '2026-01-03',
    amount: 1000,
    description: '虚构保证金',
  });
  postDrafts(s);
  term.depositAction(maker, deposit.id, {
    requestId: 'refund',
    version: 1,
    kind: 'refund',
    date: '2026-01-04',
    accountId: 1,
    amount: 200,
    reason: '部分退回',
  });
  term.depositAction(maker, deposit.id, {
    requestId: 'apply',
    version: 2,
    kind: 'apply',
    date: '2026-01-05',
    obligationId: obligation(s, 1).id,
    amount: 300,
    reason: '部分转抵',
  });
  postDrafts(s);
  return deposit;
}

test('保证金部分退回和转抵，利息确认及免除可追溯', async () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const { term, parties } = interestDelivery(s, true);
    const deposit = depositRefundedAndApplied(s, term);
    assert.equal(term.deposits(maker, {}).rows[0].balance, 500);
    assert.equal(parties.obligations(maker, { kind: 'receivable' }).rows[0].balance, 9700);
    const estimate = term.interest(maker, { period: '2026-01', kind: 'receivable' }).rows[0]
      .estimate;
    assert.equal(estimate?.days, 25);
    assert.equal(estimate?.amount, 243);
    // 月中看：只算到看的那天（01-06 起到 01-10 共 4 天），没过的日子不先算
    const midMonth = term.interest(maker, { period: '2026-01', kind: 'receivable', date: '2026-01-10' })
      .rows[0].estimate;
    assert.deepEqual([midMonth?.days, midMonth?.amount, midMonth?.asOf], [4, 39, '2026-01-10']);
    const interest = term.confirmInterest(maker, {
      period: '2026-01',
      obligationId: obligation(s, 1).id,
      version: 2,
      amount: 0,
      reason: '虚构免息',
      requestId: 'waive',
    });
    assert.equal(interest.voucher_id, null);
    const monthly = new FinanceMonthly(s).get(maker, { period: '2026-01' });
    assert.equal(monthly.actualIncome, 0);
    assert.equal(monthly.depositIncome, 1000);
    assert.equal(monthly.depositExpense, 200);
    assert.equal(monthly.theoreticalProfit, 10000);
    // 保证金没有单号：月度台账（页面、导出）和凭证“来源”都写“叫法 月-日 金额”，不露内部编号
    const { documentName, voucherSourceText } = await import('../src/finance/labels.js');
    const { financeRecordText } = await import('../shared/finance/index.js');
    const rowOf = (metric: 'depositIncome' | 'depositExpense') =>
      new FinanceMonthly(s).detail(maker, { period: '2026-01', metric }).rows[0];
    const received = rowOf('depositIncome'),
      refunded = rowOf('depositExpense');
    assert.equal(documentName(received), '保证金 01-03 10.00');
    assert.equal(documentName(refunded), '退回保证金 01-04 2.00');
    const record = recordDetail.parse(received.detail);
    assert.equal(financeRecordText(record.recordKind, record.recordDate, record.recordTotal), '保证金 01-03 10.00');
    const depositVoucher = one(s.db, rows.fin_deposits.pick({ voucher_id: true }), 'SELECT voucher_id FROM fin_deposits WHERE id=?', deposit.id);
    const source = new FinanceLedger(s).get(maker, depositVoucher?.voucher_id).source;
    assert.equal(voucherSourceText(source), '保证金 01-03 10.00');
    // 退回、转抵的凭证也挂在保证金上：来源写它自己的叫法、日期和金额，和月度台账同一行对得上，不写原保证金的
    const actionSource = (kind: string) => {
      const action = one(
        s.db,
        rows.fin_deposit_actions.pick({ voucher_id: true }),
        'SELECT voucher_id FROM fin_deposit_actions WHERE deposit_id=? AND kind=?',
        deposit.id,
        kind,
      );
      return voucherSourceText(new FinanceLedger(s).get(maker, action?.voucher_id).source);
    };
    assert.equal(actionSource('refund'), '退回保证金 01-04 2.00');
    assert.equal(actionSource('refund'), documentName(refunded), '和月度台账那一行同一写法');
    assert.equal(actionSource('apply'), '保证金转抵 01-05 3.00');
  } finally {
    s.close();
  }
});

test('压款利息的往来：逐笔的“单据”写“压款利息 月-日 金额”，和月度台账、凭证来源一样，不笼统写“手工”', async () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const { term, parties } = interestDelivery(s, false);
    const owed = obligation(s, 1);
    term.confirmInterest(maker, {
      period: '2026-01',
      obligationId: owed.id,
      version: Number(owed.version),
      requestId: 'interest',
    });
    postDrafts(s);
    const listed = parties.obligations(maker, { kind: 'receivable' }).rows;
    const interest = listed.find((r) => r.record_kind === 'interest');
    assert.ok(interest, '利息那笔标着 record_kind=interest');
    assert.equal(interest.source_number, null);
    const delivered = listed.find((r) => Number(r.id) === Number(owed.id));
    assert.ok(delivered, '送货的往来在逐笔里');
    assert.equal(delivered.record_kind, null, '送货的往来不标');
    const { obligationSource } = await import('../src/finance/parties/shared.js');
    const { voucherSourceText } = await import('../src/finance/labels.js');
    const text = obligationSource(interest, '手工');
    assert.equal(text, '压款利息 01-31 ' + (Number(interest.amount_cents) / 100).toFixed(2));
    assert.equal(text, voucherSourceText(new FinanceLedger(s).get(maker, interest.voucher_id).source), '和凭证来源一样');
    const noDocument = { source_number: null, date: '2026-01-31', amount_cents: 100 };
    assert.equal(obligationSource({ ...noDocument, record_kind: null }, '手工'), '手工', '手工新建的照旧');
    assert.equal(obligationSource({ ...noDocument, record_kind: 'opening' }, '手工'), '期初往来');
  } finally {
    s.close();
  }
});

test('压款利息只算已经过去的天数，下一次确认从上次算到的那天之后接着算，付清的第二天起不算', () => {
  const item = {
    date: '2026-10-22',
    due_date: '2026-11-21',
    amount_cents: 100000,
    terms_snapshot: JSON.stringify({
      options: JSON.stringify({ interest: { rate: '36.5', unit: 'annual', basis: 'overdue', freeDays: 0 } }),
    }),
  };
  const at = (asOf: string, after: string | null = null, paid: { date: string; amount: number }[] = []) => {
    const r = overdueInterest(item, asOf, after, paid);
    return [r?.days, r?.amount];
  };
  // 1000 元、年 36.5%，每天 1 元。11-21 到期，11-25 确认：4 天 4 元（不预算到月底）
  assert.deepEqual(at('2026-11-25'), [4, 400]);
  // 11-30 再确认：从 11-25 之后接着算 5 天，两次合计 9 天
  assert.deepEqual(at('2026-11-30', '2026-11-25'), [5, 500]);
  // 11-27 付清：第二次只算 11-26、11-27 两天（付款当天仍按付款前的余额）
  assert.deepEqual(at('2026-11-30', '2026-11-25', [{ date: '2026-11-27', amount: 100000 }]), [2, 200]);
  // 11-23 先付一半：11-22、11-23 按 1000 元，11-24、11-25 按 500 元
  assert.deepEqual(at('2026-11-25', null, [{ date: '2026-11-23', amount: 50000 }]), [4, 300]);
  // 还没到期：没有利息；到期前付清：也没有
  assert.deepEqual(at('2026-11-15'), [0, 0]);
  assert.deepEqual(at('2026-11-30', null, [{ date: '2026-11-20', amount: 100000 }]), [0, 0]);
  // 11 月没确认，12-10 确认：11-22 起一直算到 12-10，不丢 11 月的天数
  assert.deepEqual(at('2026-12-10'), [19, 1900]);
  // 没设利息规则：不给建议
  assert.equal(overdueInterest({ ...item, terms_snapshot: null }, '2026-11-25', null, []), null);
});

test('压款利息一个月确认几次：凭证按算到的那天，合计等于实际逾期天数；同一天不重复算', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s);
    const term = new FinanceDepositsInterest(s);
    new FinanceParties(s).saveTerms(maker, {
      requestId: 'term',
      kind: 'customer',
      partyId: 1,
      termDays: 20,
      options: { interest: { rate: '36.5', unit: 'annual', basis: 'overdue', freeDays: 0 } },
    });
    // 两张 100 元的送货，01-21 到期；每天 0.10 元
    physical(s, 1, 'delivery', '2026-01-01', deliveryDoc('1', { price: '100.00', taxed: false, line: { taxMode: '未税', taxRate: '0' } }));
    physical(s, 2, 'delivery', '2026-01-01', deliveryDoc('1', { price: '100.00', taxed: false, line: { taxMode: '未税', taxRate: '0' } }));
    new FinanceEvents(s).sync(maker);
    for (const source of [1, 2])
      new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
    postDrafts(s);
    const first = obligation(s, 1), second = obligation(s, 2);
    // 第二张 01-27 付清
    funds(s, cash, { kind: 'receipt', date: '2026-01-27', amount: 10000 }, [{ obligationId: second.id, version: second.version, amount: 10000 }]);
    const confirm = (o: { id: number }, date: string, requestId: string) =>
      term.confirmInterest(maker, { period: '2026-01', obligationId: o.id, version: Number(obligation(s, o === first ? 1 : 2).version), date, requestId });
    const amounts = (o: { id: number }) =>
      many(s.db, rows.fin_interest.pick({ date: true, amount_cents: true }), 'SELECT date,amount_cents FROM fin_interest WHERE obligation_id=? ORDER BY id', o.id).map((r) => [
        r.date,
        r.amount_cents,
      ]);
    confirm(first, '2026-01-25', 'i1');
    confirm(first, '2026-01-31', 'i2');
    assert.deepEqual(amounts(first), [['2026-01-25', 40], ['2026-01-31', 60]], '4 天 + 6 天 = 10 天');
    assert.deepEqual(
      many(s.db, rows.fin_vouchers.pick({ date: true }), "SELECT date FROM fin_vouchers WHERE module_source='interest' ORDER BY id").map((r) => r.date),
      ['2026-01-25', '2026-01-31'],
      '凭证日期是算到的那天',
    );
    assert.throws(() => confirm(first, '2026-01-31', 'i3'), /没有新的天数/);
    // 付清了也还在列表里，等着把付清前那几天确认掉
    const listed = (date: string) =>
      term.interest(maker, { period: '2026-01', kind: 'receivable', date }).rows.map((r) => [r.id, r.estimate?.days]);
    assert.deepEqual(listed('2026-01-25').find((r) => r[0] === second.id), [second.id, 4]);
    confirm(second, '2026-01-25', 'i4');
    assert.deepEqual(listed('2026-01-31').find((r) => r[0] === second.id), [second.id, 2]);
    confirm(second, '2026-01-31', 'i5');
    assert.deepEqual(amounts(second), [['2026-01-25', 40], ['2026-01-31', 20]], '01-27 付清，第二次只算 2 天');
    assert.equal(listed('2026-01-31').find((r) => r[0] === second.id), undefined, '确认完就不再列');
  } finally {
    s.close();
  }
});

test('补录到已结账月份的单据按开单日起息：从单据日期算起，不从记账日算', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    new FinanceParties(s).saveTerms(maker, {
      requestId: 'term',
      kind: 'customer',
      partyId: 1,
      termDays: 30,
      options: { interest: { rate: '36.5', unit: 'annual', basis: 'document', freeDays: 0 } },
    });
    // 1 月已结账（只在内存库里直接标记），之后补录 1 月 20 日的送货，凭证记在 2 月 1 日
    s.db.prepare("UPDATE fin_periods SET status='closed' WHERE period='2026-01'").run();
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    booked(s, 1);
    assert.equal(obligation(s, 1).date, '2026-02-01');
    const estimate = new FinanceDepositsInterest(s).interest(maker, { period: '2026-02', kind: 'receivable' }).rows[0].estimate;
    assert.equal(estimate?.days, 39, '01-20 到 02-28');
  } finally {
    s.close();
  }
});
