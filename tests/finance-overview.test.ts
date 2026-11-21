// 财务概览、业务单据列表、助手的应收应付读工具（全部是虚构数据，只用内存库）
import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceOverview } from '../server/finance/overview.js';
import { FinanceDue } from '../server/finance/due.js';
import { FinanceStatements } from '../server/finance/statements.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { readFinanceTool } from '../server/finance/assistant.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, event, obligation, obligationRow, funds } from './finance-fixture.js';
import { z } from 'zod';

/** 助手读工具和给模型的结果按结构认：各项的值留给断言去比 */
const fields = z.record(z.string(), z.unknown());
const receivablesOut = z.looseObject({
  rows: z.array(fields),
  byParty: z.looseObject({ rows: z.array(fields), totals: fields }),
});
const shownToModel = z.looseObject({ 按单位汇总: z.looseObject({ 各单位: z.array(fields), 合计: fields }) });

test('财务概览：按送货单、按订单都能找到它的应收和收款；月度流水的应收、已收、未收对得上', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s);
    const ofOrder = deliveryDoc('3');
    // 送货单 1 送的是订单 42 的货（300 元），送货单 2 和订单 42 无关（100 元）
    physical(s, 1, 'delivery', '2026-01-20', { ...ofOrder, lines: ofOrder.lines.map((l) => ({ ...l, orderId: 42 })) });
    physical(s, 2, 'delivery', '2026-01-20', deliveryDoc('1'));
    const events = new FinanceEvents(s);
    events.sync(maker);
    for (const source of [1, 2]) new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
    postDrafts(s);
    const o = obligation(s, 1);
    funds(s, cash, { kind: 'receipt', date: '2026-01-25', amount: 10000 }, [
      { obligationId: o.id, version: Number(obligationRow(s, o.id).version), amount: 10000 },
    ]);
    const overview = new FinanceOverview(s);

    const byDelivery = overview.related(maker, 'delivery', 1, {}).rows;
    assert.equal(byDelivery.length, 1);
    assert.equal(Number(byDelivery[0].obligation_amount), 30000);
    assert.equal(Number(byDelivery[0].paid), 10000);
    assert.deepEqual(
      z.array(fields).parse(JSON.parse(byDelivery[0].receipts)).map((r) => [r.amount, r.date]),
      [[10000, '2026-01-25']],
    );
    const byOrder = overview.related(maker, 'orders', 42, {}).rows;
    assert.deepEqual(byOrder.map((r) => r.source_id), ['1'], '订单只带出送了它的货的送货单');
    assert.equal(overview.related(maker, 'orders', 43, {}).filteredRecords, 0);
    assert.throws(() => overview.related(maker, 'purchases', 1, {}));

    const month = overview.monthlyLedger(maker, { period: '2026-01' }).summary;
    assert.equal(Number(month.receivable), 40000);
    assert.equal(Number(month.receivablePaid), 10000);
    assert.equal(month.receivableRemaining, 30000);
    assert.equal(month.payableRemaining, 0);
    // 月份只看本月：下个月没有往来
    assert.equal(Number(overview.monthlyLedger(maker, { period: '2026-02' }).summary.receivable), 0);
    // 不是财务账号不能看
    assert.throws(() => overview.related(pageActor({ id: 'x', name: '虚构业务员', permissions: ['business:edit'] }), 'delivery', 1, {}));
  } finally {
    s.close();
  }
});

test('助手应收应付读工具：带按单位汇总，预收和还欠和页面“按单位”、对账单期末同一个数，金额换成元', async () => {
  const { financeForModel, financeToolDescriptions } = await import('../shared/finance/finance-tools.js');
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s);
    physical(s, 1, 'delivery', '2026-01-05', deliveryDoc('1'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate-1' });
    // 1 月 3 日先收 30 元，那天还没有欠款，记预收
    funds(s, cash, { kind: 'receipt', date: '2026-01-03', amount: 3000 });
    postDrafts(s);
    const raw = readFinanceTool(s, maker, 'finance.receivables', { date: '2026-01-31', partyId: '1' });
    const out = receivablesOut.parse(raw);
    assert.equal(out.金额单位, '元');
    assert.ok(Array.isArray(out.rows) && out.rows.length > 0, '逐笔照旧在');
    const party = out.byParty.rows[0];
    const held = new FinanceDue(s).held(maker, { kind: 'receivable', date: '2026-01-31' }).rows.find(
      (r) => String(r.party_id) === '1',
    );
    const statement = new FinanceStatements(s).statement(maker, { kind: 'receivable', partyId: '1', from: '2026-01-01', to: '2026-01-31' });
    assert.equal(party.advance, '30.00', '预收款');
    assert.equal(party.net, '70.00', '还欠已扣预收');
    assert.equal(Number(held?.net), 7000, '和页面“按单位”一致');
    assert.equal(statement.closing, 7000, '和对账单期末一致');
    assert.deepEqual([out.byParty.totals.advance, out.byParty.totals.net], ['30.00', '70.00']);
    // 逐笔 balance 加起来是 100，不扣预收：说明里写明问“还欠多少”按 byParty 的 net 答
    assert.equal(
      out.rows.reduce((n, r) => n + Number(r.balance), 0),
      100,
    );
    assert.match(financeToolDescriptions['finance.receivables'], /按单位汇总.*预收款.*还欠/);
    assert.match(financeToolDescriptions['finance.payables'], /按单位汇总.*预付款.*还欠/);
    // 给模型的按单位汇总用中文叫法（以前是 held、net，模型照搬进回答）
    const shown = shownToModel.parse(financeForModel('finance.receivables', raw));
    assert.equal(shown.byParty, undefined);
    assert.deepEqual([shown.按单位汇总.各单位[0].预收款, shown.按单位汇总.各单位[0].还欠], ['30.00', '70.00']);
    assert.deepEqual([shown.按单位汇总.合计.预收款, shown.按单位汇总.合计.还欠], ['30.00', '70.00']);
    assert.doesNotMatch(JSON.stringify(shown.按单位汇总), /"(held|due|no_terms|advance|net)"/);
    assert.equal(shownToModel.parse(financeForModel('finance.payables', raw)).按单位汇总.各单位[0].预付款, '30.00');
    // 只看一个单位时，别的单位不在汇总里
    const other = receivablesOut.parse(readFinanceTool(s, maker, 'finance.receivables', { date: '2026-01-31', partyId: '999' }));
    assert.deepEqual(other.byParty.rows, []);
  } finally {
    s.close();
  }
});
