// 红字冲销成对看：逐笔、按单位、到期、账龄、可核销口径一致（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, one, rows } from '../server/core/index.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { FinanceOverview } from '../server/finance/reports/overview.js';
import { FinanceMonthly } from '../server/finance/reports/monthly.js';
import { FinanceStatements } from '../server/finance/parties/statements.js';
import { FinanceEventViews } from '../server/finance/events/event-views.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { FinanceAllocations } from '../server/finance/cash/allocations.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, arrivalDoc, event, obligation, obligationRow, funds, ledgerBalance, subledger, pairViews, suggestedFor, reverseSource } from './finance-fixture.js';

/**
 * 送货单 1（2026-01-10，100 元，客户账期 10 天）入账记账，2026-02-03 撤销并红字冲销（红字凭证还没记账）。
 * 返回原来那笔应收、红冲的结果和冲销那笔往来。
 */
function reversedDelivery(s: Store) {
  const cash = newSettings(s),
    events = new FinanceEvents(s),
    parties = new FinanceParties(s);
  parties.saveTerms(maker, { kind: 'customer', partyId: 1, termDays: 10, requestId: 'terms' });
  physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
  events.sync(maker);
  new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
  postDrafts(s);
  const original = obligation(s, 1);
  const corrected = reverseSource(s, 1, '2026-02-03');
  const reversal = one(s.db, rows.fin_obligations, 'SELECT * FROM fin_obligations WHERE reversal_of=?', original.id);
  if (!reversal) throw new Error('测试数据：往来 ' + original.id + ' 没有红字冲销的那笔');
  return { cash, events, parties, original, corrected, reversal };
}

test('红字冲销成对：没收过钱整笔冲销，红字凭证没记账时两笔都不欠不多，逐笔、按单位、到期、账龄、可核销口径一致', () => {
  const s = new Store(':memory:');
  try {
    const { cash, original, corrected, reversal } = reversedDelivery(s);
    assert.equal(original.due_date, '2026-01-20');
    assert.equal(corrected.status, 'corrected');
    assert.equal(Number(reversal.amount_cents), -10000);

    // 红字凭证还没记账：逐笔里两笔成对、都记 0，不出现“多付”
    const views = pairViews(s, 'receivable', '2026-02-28');
    const rowOf = (id: unknown) => {
      const row = views.rows.find((r) => r.id === Number(id));
      assert.ok(row, '逐笔里有往来 ' + String(id));
      return row;
    };
    assert.equal(rowOf(original.id).reversal_state, 'reversed');
    assert.equal(rowOf(original.id).balance, 0, '原来那笔不再显示未结清');
    assert.equal(rowOf(original.id).pair_id, Number(reversal.id));
    assert.equal(rowOf(original.id).pair_date, '2026-02-03');
    assert.equal(rowOf(original.id).pair_amount_cents, -10000);
    assert.equal(rowOf(reversal.id).reversal_state, 'reversal');
    assert.equal(rowOf(reversal.id).balance, 0, '冲销那笔余额小于 0 也不算多付');
    assert.equal(rowOf(reversal.id).pair_id, Number(original.id));
    assert.equal(rowOf(reversal.id).pair_source_number, 'FICT-1', '写明冲的是哪张单据');
    assert.equal(rowOf(reversal.id).pair_date, '2026-01-10');
    assert.equal(rowOf(reversal.id).pair_amount_cents, 10000);
    assert.deepEqual([views.held, views.soon, views.plan], [[], [], []], '按单位、到期提醒、收付计划都不算');
    assert.deepEqual(suggestedFor(s, cash, 'receipt', '2026-02-05'), [], '收款核销时选不到这两笔');
    // 账龄按已记账算：红字凭证还没记账时总账里这笔应收还在，标出来给界面写一句说明
    assert.deepEqual(views.aging.map((r) => [r.id, r.reversal_pending]), [[Number(original.id), 1]]);
    assert.deepEqual(
      views.rows.map((r) => r.days_to_due),
      [null, null],
      '成对的两笔不带距到期天数，助手不会说成逾期',
    );
    // 红字凭证和冲销往来的摘要写明冲的是哪张单据，原因放后面
    assert.equal(reversal.description, '红字冲销 送货单 FICT-1：虚构撤销单据');
    assert.equal(
      s.db.prepare('SELECT description FROM fin_vouchers WHERE id=?').get(reversal.voucher_id)?.description,
      '红字冲销 送货单 FICT-1：虚构撤销单据',
    );
    // 业务单据：原来那条、红字冲销的那条都标出来
    const listed = new FinanceEventViews(s).list(maker, { pageSize: 200 }).rows;
    assert.deepEqual(
      listed.map((e) => [e.status, e.reversal_state]).sort(),
      [
        ['corrected', 'reversal'],
        ['generated', 'reversed'],
      ],
    );
    assert.equal(listed.find((e) => e.status === 'corrected')?.previous_voucher_id, original.voucher_id);
  } finally {
    s.close();
  }
});

test('红字冲销成对：红字凭证记账后账龄不算、逐笔两清和总账一致，到期对照、单据详情、对账单都标出两笔的关系', () => {
  const s = new Store(':memory:');
  try {
    const { parties, original } = reversedDelivery(s);
    postDrafts(s);
    const posted = pairViews(s, 'receivable', '2026-02-28');
    assert.deepEqual(posted.aging, [], '红字凭证记账后账龄也不算');
    assert.deepEqual(
      posted.rows.map((r) => [r.reversal_state, r.balance]).sort(),
      [
        ['reversal', 0],
        ['reversed', 0],
      ],
    );
    assert.equal(subledger(s, 'receivable'), 0);
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 0, '逐笔合计和总账一致');
    assert.deepEqual(
      parties.aging(maker, { kind: 'receivable', date: '2026-01-31' }).rows.map((r) => r.id),
      [Number(original.id)],
      '按 1 月底看，那时还没冲销，仍欠着',
    );

    // 到期对照：冲销那笔不算到期（它的到期日只是冲销日），按冲销日以前的月底看原来那笔仍欠
    const dueOf = (period: string) =>
      new FinanceMonthly(s)
        .get(maker, { period })
        .due.filter((r) => r.kind === 'receivable')
        .map((r) => [r.due, r.settled, r.outstanding]);
    assert.deepEqual(dueOf('2026-01'), [[10000, 0, 10000]]);
    assert.deepEqual(dueOf('2026-02'), [], '冲销日所在的月份不出现负数到期');

    // 订单、送货详情里的财务一段也标出两笔的关系
    const related = new FinanceOverview(s).related(maker, 'delivery', 1, {}).rows;
    assert.deepEqual(related.map((r) => r.reversal_state).sort(), ['reversal', 'reversed']);

    // 对账单：红字那行标出来，不带到期日
    const statement = new FinanceStatements(s).statement(maker, { kind: 'receivable', partyId: '1', from: '2026-01-01', to: '2026-02-28' });
    const red = statement.items.find((r) => Number(r.delta) < 0);
    assert.ok(red, '对账单里有红字那行');
    assert.equal(red.red, 1);
    assert.equal(red.due_date, null);
    assert.equal(red.description, '红字冲销 送货单 FICT-1', '外发的对账单不带操作员写的冲销原因');
    const blue = statement.items.find((r) => Number(r.delta) > 0);
    assert.ok(blue, '对账单里有原来那行');
    assert.deepEqual([blue.reversed, blue.due_date], [1, null], '被冲销的原来那行标已冲销、不带到期日');
    assert.equal(statement.closing, 0);
    const january = new FinanceStatements(s).statement(maker, { kind: 'receivable', partyId: '1', from: '2026-01-01', to: '2026-01-31' });
    assert.deepEqual(
      january.items.map((r) => [r.reversed, r.due_date]),
      [[0, '2026-01-20']],
      '对到 1 月底时还没冲销，原来那行照常带到期日',
    );
  } finally {
    s.close();
  }
});

test('红字冲销成对：另有一笔欠款时两笔都不能多付转抵过去，逐笔列表里冲销那笔紧跟原来那笔', () => {
  const s = new Store(':memory:');
  try {
    const { events, parties, original, reversal } = reversedDelivery(s);
    postDrafts(s);
    physical(s, 2, 'delivery', '2026-02-04', deliveryDoc('1'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 2).id, { version: 1, requestId: 'generate-2' });
    postDrafts(s);
    const other = obligation(s, 2);
    for (const [from, message] of [
      [reversal, /红字冲销的那笔/],
      [original, /没有多付/],
    ] as const)
      assert.throws(
        () =>
          new FinanceAllocations(s).transferCredit(maker, {
            requestId: 'transfer-' + from.id,
            date: '2026-02-05',
            from: { id: Number(from.id), version: Number(obligationRow(s, from.id).version) },
            to: { id: Number(other.id), version: Number(other.version) },
            amount: 100,
          }),
        message,
      );
    // 逐笔列表里冲销那笔紧跟在原来那笔后面，不被中间日期的单据隔开
    assert.deepEqual(
      parties.obligations(maker, { kind: 'receivable' }).rows.map((r) => r.id),
      [Number(other.id), Number(original.id), Number(reversal.id)],
    );
  } finally {
    s.close();
  }
});

test('红字冲销成对：红字凭证作废后冲销不成立，原来那笔恢复成未结清，各读取一起恢复', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const original = obligation(s, 1);
    reverseSource(s, 1, '2026-01-20');
    const red = one(s.db, rows.fin_vouchers, 'SELECT * FROM fin_vouchers WHERE reversal_of IS NOT NULL');
    assert.ok(red, '有红字凭证');
    assert.equal(red.status, 'draft');
    new FinanceLedger(s).transition(
      maker,
      red.id,
      'void',
      { version: Number(red.version), requestId: 'void-red' },
      { linked: true },
    );
    const views = pairViews(s, 'receivable');
    assert.deepEqual(
      views.rows.map((r) => [r.id, r.reversal_state, r.balance]),
      [[Number(original.id), null, 10000]],
      '冲销往来随红字凭证作废不再显示，原来那笔照常',
    );
    assert.equal(views.held.reduce((n, r) => n + Number(r.no_terms), 0), 10000);
    assert.deepEqual(views.aging.map((r) => r.id), [Number(original.id)]);
    assert.deepEqual(suggestedFor(s, cash, 'receipt', '2026-01-25'), [Number(original.id)]);
    assert.deepEqual(
      new FinanceOverview(s).related(maker, 'delivery', 1, {}).rows
        .filter((r) => r.obligation_id != null)
        .map((r) => [
        r.obligation_id,
        r.reversal_state,
      ]),
      [[Number(original.id), null]],
    );
  } finally {
    s.close();
  }
});

test('红字冲销成对：冲销前已收的钱成了多付，只有这部分能多付转抵，冲销那笔不能转出也不能被抵', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      ledger = new FinanceLedger(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    physical(s, 2, 'delivery', '2026-01-11', deliveryDoc('1'));
    events.sync(maker);
    for (const source of [1, 2])
      new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
    postDrafts(s);
    const first = obligation(s, 1),
      second = obligation(s, 2);
    funds(s, cash, { kind: 'receipt', date: '2026-01-12', amount: 3000 }, [
      { obligationId: first.id, version: Number(first.version), amount: 3000 },
    ]);
    // 现在的更正流程要求先撤销核销（收的钱转成预收），不会留下这种状态
    assert.throws(() => reverseSource(s, 1, '2026-01-20'), /先撤销/);
    // 直接写库造出“收过钱再冲销”：红冲原凭证，记一笔整笔的冲销往来
    const voucher = ledger.get(maker, first.voucher_id).header;
    const redVoucher = ledger.reverse(
      maker,
      first.voucher_id,
      { version: Number(voucher.version), requestId: 'red', date: '2026-01-20', description: '虚构冲销送货' },
      { linked: true },
    );
    const reversalId = Number(
      s.db
        .prepare(
          `INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,reversal_of)
        VALUES('receivable','1','虚构客户','2026-01-20','2026-01-20',-10000,'虚构冲销送货',?,?,?)`,
        )
        .run(first.event_id, redVoucher.header.id, first.id).lastInsertRowid,
    );
    postDrafts(s);
    const balance = (id: unknown) =>
      pairViews(s, 'receivable').rows.find((r) => r.id === Number(id))?.balance;
    assert.equal(balance(first.id), -3000, '冲销只抵掉没收的 70 元，已收的 30 元成了多付');
    assert.equal(balance(reversalId), 0);
    assert.equal(balance(second.id), 10000);
    assert.equal(subledger(s, 'receivable'), 7000);
    assert.equal(ledgerBalance(s, '1122'), 7000, '逐笔合计和总账一致');
    assert.deepEqual(
      pairViews(s, 'receivable').held.map((r) => Number(r.no_terms)),
      [10000],
      '按单位只算第二张的 100 元',
    );
    const transfer = (from: unknown, to: unknown, amount: number, requestId: string) =>
      new FinanceAllocations(s).transferCredit(maker, {
        requestId,
        date: '2026-01-25',
        from: { id: Number(from), version: Number(obligationRow(s, from).version) },
        to: { id: Number(to), version: Number(obligationRow(s, to).version) },
        amount,
      });
    assert.throws(() => transfer(first.id, second.id, 3001, 'too-much'), /超过多付/, '最多转已收的 30 元');
    assert.throws(() => transfer(reversalId, second.id, 100, 'from-red'), /红字冲销的那笔/);
    assert.throws(() => transfer(second.id, reversalId, 100, 'to-red'), /红字冲销的那笔/);
    transfer(first.id, second.id, 3000, 'transfer');
    postDrafts(s);
    assert.equal(balance(first.id), 0, '转抵后原来那笔两清');
    assert.equal(balance(second.id), 7000);
    assert.equal(subledger(s, 'receivable'), 7000);
    assert.equal(ledgerBalance(s, '1122'), 7000);
    assert.throws(() => transfer(second.id, first.id, 100, 'to-reversed'), /没有多付|已经红字冲销/);
  } finally {
    s.close();
  }
});

test('红字冲销成对：到货撤销后应付一侧同样成对，不算欠供应商、付款时选不到', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s);
    physical(s, 1, 'arrival', '2026-01-10', arrivalDoc('10'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const original = obligation(s, 1);
    assert.equal(Number(original.amount_cents), 10000);
    assert.equal(reverseSource(s, 1, '2026-01-20').status, 'corrected');
    postDrafts(s);
    const views = pairViews(s, 'payable');
    assert.deepEqual(
      views.rows.map((r) => [r.reversal_state, r.balance, r.pair_amount_cents]).sort(),
      [
        ['reversal', 0, 10000],
        ['reversed', 0, -10000],
      ],
    );
    assert.equal(views.rows.find((r) => r.reversal_state === 'reversal')?.pair_source_number, 'FICT-1');
    assert.deepEqual([views.held, views.soon, views.plan, views.aging], [[], [], [], []]);
    assert.deepEqual(suggestedFor(s, cash, 'payment', '2026-01-25'), []);
    assert.equal(subledger(s, 'payable'), 0);
    assert.equal(ledgerBalance(s, '2202'), 0);
  } finally {
    s.close();
  }
});
