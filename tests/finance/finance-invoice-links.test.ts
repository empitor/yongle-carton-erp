// 发票关联往来：账期、带数量的关联、已开票合计、分期跟着往来走（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, one, rows } from '../../server/core/index.js';
import { FinanceSettings } from '../../server/finance/base/settings.js';
import { FinanceParties } from '../../server/finance/parties/parties.js';
import { FinanceEvents } from '../../server/finance/events/events.js';
import { FinanceInvoices } from '../../server/finance/cash/invoices.js';
import { FinanceDue } from '../../server/finance/parties/due.js';
import { FinanceEventVouchers } from '../../server/finance/events/event-voucher.js';
import { FinanceEventHandling } from '../../server/finance/events/event-handling.js';
import { FinanceInvoiceConfirm } from '../../server/finance/cash/invoice-confirm.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, arrivalDoc, event, obligationRow, confirmBlue, confirmRed, rawObligation } from './finance-fixture.js';

/** 财务事件名下那笔往来的编号（这些测试里一张单据只有一笔；没有就让测试失败） */
function obligationOfEvent(s: Store, eventId: number) {
  const row = one(s.db, rows.fin_obligations.pick({ id: true }), 'SELECT id FROM fin_obligations WHERE event_id=?', eventId);
  if (!row) throw new Error('测试数据：财务事件 ' + eventId + ' 名下没有往来');
  return row.id;
}

test('发票再加一条关联时，原来带数量和单位的关联原样保留', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store, '2026-02');
    const first = rawObligation(store, 5000),
      second = rawObligation(store, 5000);
    const invoices = new FinanceInvoices(store);
    const blue = invoices.create(maker, {
      requestId: 'b', direction: 'sale', type: '虚构数电票', partyId: 1, rate: '0', tax: 0,
      number: 'B-1', date: '2026-02-10', net: 10000, gross: 10000,
    });
    invoices.link(maker, blue.id, {
      version: 1, requestId: 'l1', links: [{ obligationId: first, amount: 5000, quantity: '12.5', unit: '只' }],
    });
    const view = invoices.get(maker, blue.id);
    assert.equal(view.links[0].quantity, '12.5', '返回给页面的是数量文字');
    // 照页面的做法：原有关联原样带回，再加一条
    invoices.link(maker, blue.id, {
      version: view.invoice.version,
      requestId: 'l2',
      links: [
        ...view.links.map((l) => ({
          obligationId: l.obligation_id,
          amount: l.amount_cents,
          ...(l.quantity != null && l.unit ? { quantity: l.quantity, unit: l.unit } : {}),
        })),
        { obligationId: second, amount: 5000 },
      ],
    });
    const after = invoices.get(maker, blue.id);
    assert.equal(after.links.length, 2);
    assert.equal(after.links[0].quantity, '12.5');
    assert.equal(after.links[0].unit, '只');
  } finally {
    store.close();
  }
});

test('往来列表的已开票只算确认过的发票，并扣掉红票', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store, '2026-02');
    const billed = rawObligation(store, 100),
      drafted = rawObligation(store, 100);
    const invoices = new FinanceInvoices(store);
    const bill = (extra: Record<string, unknown>) => ({ direction: 'sale', type: '虚构数电票', partyId: 1, rate: '0', tax: 0, ...extra });
    const blue = invoices.create(maker, bill({ requestId: 'b', number: 'B-1', date: '2026-02-10', net: 100, gross: 100 }));
    invoices.link(maker, blue.id, { version: 1, requestId: 'l', links: [{ obligationId: billed, amount: 100 }] });
    new FinanceInvoiceConfirm(store).confirm(maker, blue.id, { version: 2, requestId: 'bc' });
    const red = invoices.create(
      maker,
      bill({ requestId: 'r', number: 'R-1', date: '2026-02-11', net: -40, gross: -40, originalId: blue.id }),
    );
    new FinanceInvoiceConfirm(store).confirm(maker, red.id, { version: 1, requestId: 'rc' });
    // 只保存了草稿、没有确认的发票不算已开票
    const draft = invoices.create(maker, bill({ requestId: 'd', number: 'D-1', date: '2026-02-12', net: 100, gross: 100 }));
    invoices.link(maker, draft.id, { version: 1, requestId: 'dl', links: [{ obligationId: drafted, amount: 100 }] });
    const listed = new FinanceParties(store).obligations(maker, { kind: 'receivable' }).rows;
    const invoiced = (id: number) => {
      const row = listed.find((r) => r.id === id);
      assert.ok(row, '逐笔里有往来 ' + id);
      return Number(row.invoiced);
    };
    assert.equal(invoiced(billed), 60, '开了 100，红冲 40，还算 60');
    assert.equal(invoiced(drafted), 0, '草稿不算已开票');
  } finally {
    store.close();
  }
});

test('分期付款跟着往来金额走：收到含税发票、红票冲减后按原比例重算，尾差落在最后一期', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const parties = new FinanceParties(s),
      events = new FinanceEvents(s),
      due = new FinanceDue(s);
    const split = {
      installments: [
        { rate: '33.333333', rule: { type: 'days' as const, days: 10 } },
        { rate: '66.666667', rule: { type: 'days' as const, days: 40 } },
      ],
    };
    parties.saveTerms(maker, { kind: 'supplier', partyId: 1, termType: 'days', termDays: 30, options: split, requestId: 'terms-supplier' });
    parties.saveTerms(maker, { kind: 'customer', partyId: 1, termType: 'days', termDays: 30, options: split, requestId: 'terms-customer' });
    const plan = (id: number) =>
      s.db
        .prepare('SELECT amount_cents FROM fin_installments WHERE obligation_id=? ORDER BY position')
        .all(id)
        .map((r) => Number(r.amount_cents));
    // 采购：暂估 1000 元，收到 13% 的专票，应付变成 1130 元
    physical(s, 1, 'arrival', '2026-02-05', arrivalDoc('100', { price: '10.00' }));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate-arrival' });
    postDrafts(s);
    const payable = obligationOfEvent(s, event(s, 1).id);
    assert.deepEqual(plan(payable), [33333, 66667]);
    confirmBlue(
      s,
      { direction: 'purchase', number: 'P-13', date: '2026-02-10', gross: 113000, extra: { net: 100000, rate: '13', tax: 13000 } },
      [{ obligationId: payable, amount: 113000 }],
    );
    assert.equal(Number(obligationRow(s, payable).amount_cents), 113000);
    assert.deepEqual(plan(payable), [37666, 75334], '按原比例重算，尾差在最后一期');
    const held = due.held(maker, { kind: 'payable', date: '2026-12-31' }).rows[0];
    assert.equal(Number(held.due), 113000, '按单位汇总按新金额');
    const forecast = due.plan(maker, { date: '2026-02-10', months: 6 }).forecast;
    assert.equal(forecast.reduce((n, r) => n + Number(r.payable), 0), 113000, '收付计划按新金额');
    // 销售：应收 100 元，折让红票冲掉 20 元
    physical(s, 2, 'delivery', '2026-02-06', deliveryDoc('1', { price: '100.0000' }));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 2).id, { version: 1, requestId: 'generate-delivery' });
    postDrafts(s);
    const receivable = obligationOfEvent(s, event(s, 2).id);
    assert.deepEqual(plan(receivable), [3333, 6667]);
    const blue = confirmBlue(s, { direction: 'sale', number: 'S-BLUE', date: '2026-02-10' }, [{ obligationId: receivable, amount: 10000 }]);
    confirmRed(s, { direction: 'sale', number: 'S-RED', date: '2026-02-12' }, blue.id, 2000, '5001');
    assert.equal(Number(obligationRow(s, receivable).amount_cents), 8000);
    assert.deepEqual(plan(receivable), [2666, 5334]);
    const soon = due.soon(maker, { date: '2026-12-31', days: 0 }).rows;
    assert.equal(
      soon.filter((r) => Number(r.id) === receivable).reduce((n, r) => n + Number(r.balance), 0),
      8000,
      '到期提醒按新金额',
    );
    // 送货缺税率：理论金额 100 元先挂应收并分期，补上 13% 税率后应收变成 113 元
    const untaxed = deliveryDoc('1', { price: '100.0000' });
    physical(s, 3, 'delivery', '2026-02-07', {
      ...untaxed,
      lines: untaxed.lines.map((line) => ({ ...line, taxRate: undefined })),
    });
    events.sync(maker);
    const waiting = event(s, 3);
    assert.equal(waiting.status, 'info_pending');
    const provisional = obligationOfEvent(s, waiting.id);
    assert.deepEqual(plan(provisional), [3333, 6667]);
    new FinanceEventHandling(s).resolve(maker, waiting.id, {
      version: Number(waiting.version),
      requestId: 'resolve-untaxed',
      lines: [{ exact: '100', mode: '未税', rate: '13' }],
    });
    assert.equal(Number(obligationRow(s, provisional).amount_cents), 11300);
    assert.deepEqual(plan(provisional), [3766, 7534], '补税率后分期跟着改');
  } finally {
    s.close();
  }
});

test('开票确认收入部分开票：按单位多一项“已送货未开票”，往来减它等于总账应收', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const settings = new FinanceSettings(s);
    settings.update(maker, { version: 3, requestId: 'policy', revenueRecognition: 'invoice' });
    // 确认时间晚于切换口径的时间，这张送货单按开票确认收入
    physical(s, 1, 'delivery', '2026-02-05', deliveryDoc('1', { price: '100.0000', confirmedAt: '2999-01-01T00:00:00.000Z' }));
    new FinanceEvents(s).sync(maker);
    const key = obligationOfEvent(s, event(s, 1).id);
    const held = () => {
      const t = new FinanceDue(s).held(maker, { kind: 'receivable', date: '2026-02-28' }).totals;
      return { debts: t.held + t.due + t.no_terms, advance: t.advance, uninvoiced: t.uninvoiced, net: t.net };
    };
    // 还没开票：送货整笔先算进还欠，没有差额
    assert.deepEqual(held(), { debts: 10000, advance: 0, uninvoiced: 0, net: 10000 });
    // 开了 60 元：往来仍按送货全额 100，总账应收只记 60，差的 40 是已送货未开票
    const blue = confirmBlue(s, { direction: 'sale', number: 'P-BLUE', date: '2026-02-10' }, [{ obligationId: key, amount: 6000 }]);
    assert.deepEqual(held(), { debts: 10000, advance: 0, uninvoiced: 4000, net: 6000 });
    // 折让红票 10 元：往来和总账应收各减 10，没开票的还是 40
    confirmRed(s, { direction: 'sale', number: 'P-RED', date: '2026-02-12' }, blue.id, 1000, '5001');
    assert.equal(Number(obligationRow(s, key).amount_cents), 9000);
    assert.deepEqual(held(), { debts: 9000, advance: 0, uninvoiced: 4000, net: 5000 });
    const row = new FinanceDue(s).held(maker, { kind: 'receivable', date: '2026-02-28' }).rows[0];
    assert.equal(row.uninvoiced, 4000, '逐个单位也带这一项');
    // 应付没有这一项
    assert.equal(new FinanceDue(s).held(maker, { kind: 'payable', date: '2026-02-28' }).totals.uninvoiced, 0);
  } finally {
    s.close();
  }
});
