// 来源凭证作废后重新生成、红字凭证和原凭证互指（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { bookingDate } from '../server/finance/periods.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, event, obligation, obligationRow, funds, ledgerBalance, subledger, reverseSource, eventsStep, unbalancedVouchers } from './finance-fixture.js';
import { FinanceDue } from '../server/finance/due.js';
import { count, one, rows } from '../server/core/index.js';

/** 1 月已结账（只在内存库里直接标记）以后补录一张 1 月 20 日的送货单，客户账期 30 天 */
function lateDelivery(doc: Record<string, unknown> = deliveryDoc('1')) {
  const s = new Store(':memory:');
  newSettings(s);
  new FinanceParties(s).saveTerms(maker, { kind: 'customer', partyId: 1, termDays: 30, requestId: 'terms' });
  s.db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-01','closed') ON CONFLICT(period) DO UPDATE SET status='closed'").run();
  physical(s, 1, 'delivery', '2026-01-20', doc);
  new FinanceEvents(s).sync(maker);
  return s;
}
const voucherOf = (s: Store, id: unknown) => {
  const row = one(
    s.db,
    rows.fin_vouchers.pick({ date: true, period: true, description: true }),
    'SELECT date,period,description FROM fin_vouchers WHERE id=?',
    Number(id),
  );
  if (!row) throw new Error('测试数据：没有凭证 ' + String(id));
  return row;
};

test('记账日：没有结账的月份原样用单据日期；结了账的记到最近一个已结账月份的下个月 1 号，跨年、月份不连续都一次算出', () => {
  const s = new Store(':memory:');
  try {
    const close = (period: string) =>
      s.db.prepare("INSERT INTO fin_periods(period,status) VALUES(?,'closed') ON CONFLICT(period) DO UPDATE SET status='closed'").run(period);
    assert.equal(bookingDate(s.db, '2026-01-20'), '2026-01-20', '一个月都没结账');
    close('2026-11');
    close('2026-12');
    assert.equal(bookingDate(s.db, '2026-12-31'), '2027-01-01', '跨年');
    assert.equal(bookingDate(s.db, '2026-03-05'), '2027-01-01', '早于已结账月份、中间没有记录的月份也记到最早没结账的月份');
    assert.equal(bookingDate(s.db, '2027-01-15'), '2027-01-15', '开着的月份原样');
    s.db.prepare("UPDATE fin_periods SET status='open' WHERE period='2026-12'").run();
    assert.equal(bookingDate(s.db, '2026-12-10'), '2026-12-10', '反结账后原样用单据日期');
  } finally {
    s.close();
  }
});

test('单据日期所在月份已结账：凭证记到最早没结账月份的 1 号，摘要注明单据日期，下个月结账放行', () => {
  const s = lateDelivery();
  try {
    const ev = event(s, 1);
    assert.equal(ev.status, 'ready');
    const done = new FinanceEventVouchers(s).generate(maker, ev.id, { version: Number(ev.version), requestId: 'g' });
    const voucher = voucherOf(s, done.voucher_id);
    assert.deepEqual([voucher.date, voucher.period], ['2026-02-01', '2026-02']);
    assert.match(String(voucher.description), /（单据日期 2026-01-20）$/);
    assert.equal(count(s.db, "SELECT count(*) FROM fin_vouchers WHERE period='2026-01'"), 0, '已结账月份不出凭证');
    postDrafts(s);
    assert.equal(eventsStep(s, '2026-02').ok, true);
  } finally {
    s.close();
  }
});

test('换了记账日的往来：记账日是凭证日期，到期日按单据日期加账期算', () => {
  const s = lateDelivery();
  try {
    const ev = event(s, 1);
    new FinanceEventVouchers(s).generate(maker, ev.id, { version: Number(ev.version), requestId: 'g' });
    const o = obligation(s, 1);
    assert.deepEqual([o.date, o.due_date], ['2026-02-01', '2026-02-19']);
  } finally {
    s.close();
  }
});

test('单据日期所在月份已结账时补税率：税率存下并生成凭证，不被“已结账”整笔拒绝', () => {
  const s = lateDelivery({ customerId: 1, customerName: '虚构客户', lines: [{ unit: '个', quantity: '1', unitPriceExact: '100.0000' }] });
  try {
    const ev = event(s, 1);
    assert.equal(ev.status, 'info_pending');
    const done = new FinanceEventHandling(s).resolve(maker, ev.id, {
      version: Number(ev.version),
      requestId: 'resolve',
      lines: [{ exact: '100.0000', mode: '未税', rate: '0' }],
    });
    assert.equal(done.status, 'generated');
    assert.equal(voucherOf(s, done.voucher_id).date, '2026-02-01');
  } finally {
    s.close();
  }
});

test('先挂暂估、补完税率再制单的往来：日期也换成记账日，已结账月末的往来和总账一致', () => {
  const s = lateDelivery(deliveryDoc('1', { taxed: false }));
  try {
    const ev = event(s, 1);
    new FinanceEventHandling(s).resolve(maker, ev.id, {
      version: Number(ev.version),
      requestId: 'resolve',
      lines: [{ exact: '100.0000', mode: '未税', rate: '0' }],
    });
    postDrafts(s);
    const o = obligation(s, 1);
    assert.deepEqual([o.date, o.due_date], ['2026-02-01', '2026-02-19']);
    const aging = (date: string) =>
      new FinanceParties(s).aging(maker, { kind: 'receivable', date }).rows.reduce((n, r) => n + Number(r.balance), 0);
    assert.deepEqual([aging('2026-01-31'), ledgerBalance(s, '1122', '2026-01')], [0, 0], '1 月往来和总账都没有它');
    assert.deepEqual([aging('2026-02-28'), ledgerBalance(s, '1122', '2026-02'), unbalancedVouchers(s)], [10000, 10000, 0]);
  } finally {
    s.close();
  }
});

test('补录单据生成凭证后按账期重算到期日：基准仍是单据日期，到期日不变', () => {
  const s = lateDelivery();
  try {
    const ev = event(s, 1);
    new FinanceEventVouchers(s).generate(maker, ev.id, { version: Number(ev.version), requestId: 'g' });
    assert.deepEqual(new FinanceDue(s).preview(maker, { kind: 'receivable', partyId: '1' }).rows, [], '没有要改的到期日');
  } finally {
    s.close();
  }
});

test('红字冲销并重做选的日期只定记账日：重做的往来到期日仍按单据日期加账期算', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    new FinanceParties(s).saveTerms(maker, { kind: 'customer', partyId: 1, termDays: 30, requestId: 'terms' });
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    const events = new FinanceEvents(s);
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'g' });
    postDrafts(s);
    // 改了数量，红冲重做选 1 月 25 日
    s.db.prepare("UPDATE flow_documents SET document=json_set(document,'$.lines[0].quantity','2'),version=version+1 WHERE id=1").run();
    events.sync(maker);
    const diff = event(s, 1);
    const redo = new FinanceEventHandling(s).correct(maker, diff.id, {
      version: Number(diff.version),
      requestId: 'redo',
      date: '2026-01-25',
      reason: '虚构改数量',
    });
    assert.equal(voucherOf(s, redo.voucher_id).date, '2026-01-25');
    const o = obligation(s, 1);
    assert.deepEqual([o.date, o.due_date], ['2026-01-25', '2026-02-19']);
  } finally {
    s.close();
  }
});

test('凭证页作废来源凭证后重新生成：接着用原来的往来，已核销的收款、余额都在，往来和总账一致', () => {
  const s = new Store(':memory:');
  try {
    const service = newSettings(s);
    const events = new FinanceEvents(s);
    // 送货缺税率，先挂暂估应收，收款核销到这笔暂估
    physical(s, 1, 'delivery', '2026-01-05', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ unit: '个', quantity: '1', unitPriceExact: '100.00' }],
    });
    events.sync(maker);
    const pending = obligation(s, 1);
    funds(s, service, { kind: 'receipt', date: '2026-01-06', amount: 10000 }, [
      { obligationId: Number(pending.id), version: Number(pending.version), amount: 10000 },
    ]);
    // 补税率，自动生成送货凭证
    let ev = event(s, 1);
    new FinanceEventHandling(s).resolve(maker, ev.id, {
      version: Number(ev.version),
      requestId: 'resolve',
      lines: [{ exact: '100', mode: '未税', rate: '0' }],
    });
    ev = event(s, 1);
    const ledger = new FinanceLedger(s);
    const voucher = ledger.get(maker, ev.voucher_id).header;
    ledger.transition(maker, voucher.id, 'void', { version: Number(voucher.version), requestId: 'void' });
    ev = event(s, 1);
    assert.equal(ev.status, 'ready', '单据回到可记账');
    assert.equal(obligationRow(s, pending.id).voucher_id, null, '往来跟着清掉凭证号');
    new FinanceEventVouchers(s).generate(maker, ev.id, { version: Number(ev.version), requestId: 'regenerate' });
    postDrafts(s);
    const rows = s.db.prepare('SELECT * FROM fin_obligations WHERE kind=?').all('receivable');
    assert.equal(rows.length, 1, '没有另起一条往来');
    assert.equal(Number(rows[0].id), Number(pending.id));
    const list = new FinanceParties(s).obligations(maker, { kind: 'receivable' }).rows;
    assert.deepEqual(
      list.map((r) => [Number(r.amount_cents), Number(r.allocated), Number(r.balance)]),
      [[10000, 10000, 0]],
      '核销还在，不再显示未收',
    );
    assert.equal(subledger(s, 'receivable'), ledgerBalance(s, '1122'), '往来和总账一致');
    assert.equal(ledgerBalance(s, '1122'), 0);
  } finally {
    s.close();
  }
});

test('凭证：被红字冲销的原凭证指向冲它的那张，红字凭证指回原凭证', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s),
      ledger = new FinanceLedger(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    events.sync(maker);
    const voucherId = Number(new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'g' }).voucher_id);
    postDrafts(s);
    assert.equal(ledger.get(maker, voucherId).reversedBy, null);
    reverseSource(s, 1, '2026-01-20');
    const red = one(s.db, rows.fin_vouchers, 'SELECT * FROM fin_vouchers WHERE reversal_of=?', voucherId);
    if (!red) throw new Error('测试数据：凭证 ' + voucherId + ' 没有红字凭证');
    const { reversedBy } = ledger.get(maker, voucherId);
    assert.ok(reversedBy, '原凭证带着冲它的那张');
    assert.deepEqual(
      [reversedBy.id, reversedBy.period, reversedBy.number, reversedBy.status],
      [Number(red.id), red.period, Number(red.number), 'draft'],
    );
    const back = ledger.get(maker, red.id);
    assert.equal(back.original?.id, voucherId);
  } finally {
    s.close();
  }
});
