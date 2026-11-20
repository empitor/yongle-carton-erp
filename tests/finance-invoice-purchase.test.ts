// 采购到票：部分到票、更正后再查往来、退货例外、月度台账（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { count, one } from '../server/core/index.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceInvoiceMatching } from '../server/finance/invoice-matching.js';
import { FinanceEventViews } from '../server/finance/event-views.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, arrivalDoc, event, obligationRow, ledgerBalance, bill, arrived, confirmBlue, confirmRed } from './finance-fixture.js';

/** 1 号单据的日期（送货单还有计划日）：直接改写单据内容时照原样带上 */
function documentDates(s: Store) {
  const current = s.db.prepare('SELECT kind,date FROM flow_documents WHERE id=1').get();
  assert.ok(current);
  return current.kind === 'delivery' ? { date: current.date, plannedDate: current.date } : { date: current.date };
}

/** 这一方向还算数（没被替代）的往来金额合计（分） */
function total(s: Store, kind: string) {
  const row = one(
    s.db,
    z.object({ n: z.number() }),
    "SELECT coalesce(sum(amount_cents),0) AS n FROM fin_obligations WHERE kind=? AND tax_status<>'superseded'",
    kind,
  );
  if (!row) throw new Error('测试数据：读不到往来合计');
  return row.n;
}

test('13% 税率下开到九成货款，须填对应暂估金额，剩下的再开票照常转回', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const invoices = new FinanceInvoices(s);
    const key = arrived(s);
    const estimate = Number(obligationRow(s, key).voucher_id);
    // 到货暂估 100 元（不含税）；发票不含税 90 元、税 11.7 元、价税合计 101.7 元
    const first = invoices.create(
      maker,
      bill('purchase', 'P-90', { date: '2026-02-10', gross: 10170, net: 9000, tax: 1170, rate: '13' }),
    );
    invoices.link(maker, first.id, {
      version: 1,
      requestId: 'link-90',
      links: [{ obligationId: key, amount: 10170 }],
    });
    assert.throws(
      () => new FinanceInvoiceConfirm(s).confirm(maker, first.id, { version: 2, requestId: 'confirm-90' }),
      /部分到票须填写本次对应的原暂估金额/,
    );
    invoices.link(maker, first.id, {
      version: 2,
      requestId: 'relink-90',
      links: [{ obligationId: key, amount: 10170, estimateAmount: 9000 }],
    });
    new FinanceInvoiceConfirm(s).confirm(maker, first.id, { version: 3, requestId: 'confirm-90' });
    postDrafts(s);
    assert.equal(Number(obligationRow(s, key).estimate_remaining), 1000, '还留 10 元暂估');
    assert.equal(
      count(s.db, 'SELECT count(*) FROM fin_vouchers WHERE reversal_of=?', estimate),
      1,
      '原暂估凭证全额红冲一张，余量另出暂估；往来还是原来那一条（key 没变）',
    );
    confirmBlue(
      s,
      { direction: 'purchase', number: 'P-10', date: '2026-02-11', gross: 1130, extra: { net: 1000, tax: 130, rate: '13' } },
      [{ obligationId: key, amount: 1130 }],
    );
    const after = obligationRow(s, key);
    assert.equal(Number(after.estimate_remaining), 0);
    assert.equal(Number(after.amount_cents), 10170 + 1130, '应付等于两张发票价税合计');
    assert.equal(ledgerBalance(s, '2202', '2026-02'), -(10170 + 1130));
    assert.equal(ledgerBalance(s, '1403', '2026-02'), 10000, '暂估全部转回，原材料按发票不含税额');
  } finally {
    s.close();
  }
});

test('整张红冲后月度台账仍按原往来显示已付：往来金额为 0，已付的 100 元不丢', () => {
  const s = new Store(':memory:');
  try {
    const funds = newSettings(s, '2026-02');
    const monthly = new FinanceMonthly(s);
    const key = arrived(s);
    const blue = confirmBlue(s, { direction: 'purchase', number: 'B', date: '2026-02-10' }, [{ obligationId: key, amount: 10000 }]);
    const cash = funds.saveCash(maker, {
      requestId: 'pay',
      kind: 'payment',
      accountId: 1,
      partyId: 1,
      date: '2026-02-11',
      amount: 10000,
      method: '银行',
      description: '虚构付款',
    });
    funds.confirm(maker, cash.id, {
      version: 1,
      requestId: 'confirm-pay',
      allocations: [{ obligationId: key, version: obligationRow(s, key).version, amount: 10000 }],
    });
    postDrafts(s);
    confirmRed(s, { direction: 'purchase', number: 'B-RED', date: '2026-02-12' }, blue.id, 10000);
    assert.equal(Number(obligationRow(s, key).amount_cents), 0);
    const line = monthly.detail(maker, { period: '2026-02', metric: 'theoreticalExpense' }).rows.find(
      (r) => r.id === event(s, 1).id,
    );
    assert.ok(line);
    assert.equal(Number(line.paid), 10000, '已付 100 元不因往来金额为 0 而丢失');
  } finally {
    s.close();
  }
});

test('被更正冲销的往来不能再关联发票：旧往来和冲销行都拒绝，台账按更正后的往来', () => {
  const t = new Store(':memory:');
  try {
    newSettings(t, '2026-02');
    const tEvents = new FinanceEvents(t),
      tInvoices = new FinanceInvoices(t);
    const original = arrived(t);
    const doc = arrivalDoc('12', { price: '10.00', taxed: false });
    t.db
      .prepare('UPDATE flow_documents SET document=?,version=2 WHERE id=1')
      .run(JSON.stringify({ ...doc, date: '2026-02-05', confirmedAt: '2026-02-05T09:00:00.000Z' }));
    tEvents.sync(maker, { requestId: 're-scan' });
    const diff = new FinanceEventViews(t).list(maker, { status: 'difference' }).rows[0];
    new FinanceEventHandling(t).correct(maker, diff.id, {
      version: Number(diff.version),
      date: '2026-02-06',
      requestId: 'correct',
      reason: '虚构改数量',
    });
    postDrafts(t);
    const reversal = Number(
      t.db.prepare('SELECT id FROM fin_obligations WHERE reversal_of=?').get(original)?.id,
    );
    const replacement = Number(
      t.db
        .prepare(
          'SELECT id FROM fin_obligations WHERE reversal_of IS NULL AND id<>? AND amount_cents>0 ORDER BY id DESC',
        )
        .get(original)?.id,
    );
    assert.equal(Number(obligationRow(t, replacement).amount_cents), 12000);
    const draft = tInvoices.create(maker, bill('purchase', 'C', { date: '2026-02-10', gross: 10000 }));
    for (const old of [original, reversal])
      assert.throws(
        () =>
          tInvoices.link(maker, draft.id, {
            version: 1,
            requestId: 'link-old-' + old,
            links: [{ obligationId: old, amount: 10000 }],
          }),
        /已被更正或冲销/,
      );
    const listed: { id: number }[] = new FinanceInvoiceMatching(t).list(maker, { kind: 'payable' }).rows;
    assert.ok(!listed.some((r) => [original, reversal].includes(r.id)), '关联列表里不再出现被冲销的旧往来');
    tInvoices.link(maker, draft.id, {
      version: 1,
      requestId: 'link-new',
      links: [{ obligationId: replacement, amount: 10000 }],
    });
    const line2 = new FinanceMonthly(t)
      .detail(maker, { period: '2026-02', metric: 'theoreticalExpense' })
      .rows.find((r) => r.id === event(t, 1).id);
    assert.ok(line2);
    assert.equal(line2.due_date, obligationRow(t, replacement).due_date, '台账按更正后的往来');
  } finally {
    t.close();
  }
});

test('确认发票时再查往来：草稿关联后来源单被更正，旧往来已冲销或被替代，确认被拦下', () => {
  const correct = (s: Store, doc: Record<string, unknown>, at: string) => {
    const events = new FinanceEvents(s);
    s.db
      .prepare('UPDATE flow_documents SET document=?,version=2 WHERE id=1')
      .run(JSON.stringify({ ...doc, ...documentDates(s), confirmedAt: at }));
    events.sync(maker, { requestId: 're-scan' });
    const diff = new FinanceEventViews(s).list(maker, { status: 'difference' }).rows[0];
    assert.ok(diff, '有草稿关联时改了来源单，要走差异更正');
    new FinanceEventHandling(s).correct(maker, diff.id, {
      version: Number(diff.version),
      date: '2026-02-06',
      requestId: 'correct',
      reason: '虚构改数量',
    });
    postDrafts(s);
  };

  // 采购：到货暂估已记账，更正后旧往来被冲销行冲掉
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const invoices = new FinanceInvoices(s);
    const original = arrived(s);
    const draft = invoices.create(maker, bill('purchase', 'P-DRAFT', { date: '2026-02-10', gross: 10000 }));
    invoices.link(maker, draft.id, {
      version: 1,
      requestId: 'link-draft',
      links: [{ obligationId: original, amount: 10000 }],
    });
    correct(s, arrivalDoc('12', { price: '10.00', taxed: false }), '2026-02-05T09:00:00.000Z');
    assert.ok(s.db.prepare('SELECT 1 FROM fin_obligations WHERE reversal_of=?').get(original));
    const before = total(s, 'payable');
    assert.equal(before, 12000, '旧 100 元被冲销，新往来 120 元');
    assert.throws(
      () => new FinanceInvoiceConfirm(s).confirm(maker, draft.id, { version: 2, requestId: 'confirm-draft' }),
      /该往来单已被更正或冲销，请关联更正后的往来单/,
    );
    assert.equal(total(s, 'payable'), before, '应付没有被重复记');
  } finally {
    s.close();
  }

  // 销售（开票确认收入）：待开票的往来没有凭证，更正后直接被替代
  const t = new Store(':memory:');
  try {
    newSettings(t, '2026-02');
    const settings = new FinanceSettings(t);
    settings.update(maker, { version: 3, requestId: 'policy', revenueRecognition: 'invoice' });
    const events = new FinanceEvents(t),
      invoices = new FinanceInvoices(t);
    const at = '2999-01-01T00:00:00.000Z';
    physical(t, 1, 'delivery', '2026-02-05', deliveryDoc('1', { price: '100.0000', confirmedAt: at }));
    events.sync(maker, { requestId: 'scan' });
    const original = Number(
      t.db.prepare('SELECT id FROM fin_obligations WHERE event_id=?').get(event(t, 1).id)?.id,
    );
    const draft = invoices.create(maker, bill('sale', 'S-DRAFT', { date: '2026-02-10', gross: 10000 }));
    invoices.link(maker, draft.id, {
      version: 1,
      requestId: 'link-draft',
      links: [{ obligationId: original, amount: 10000 }],
    });
    correct(t, deliveryDoc('2', { price: '100.0000' }), at);
    assert.equal(obligationRow(t, original).tax_status, 'superseded');
    const before = total(t, 'receivable');
    assert.throws(
      () => new FinanceInvoiceConfirm(t).confirm(maker, draft.id, { version: 2, requestId: 'confirm-draft' }),
      /该往来单已被更正或冲销，请关联更正后的往来单/,
    );
    assert.equal(obligationRow(t, original).tax_status, 'superseded', '旧往来没有被救活');
    assert.equal(total(t, 'receivable'), before);
  } finally {
    t.close();
  }
});

test('部分到票的退货例外：到货退过货，按退后剩下的数量到票不用填对应暂估，整批暂估转回', () => {
  // 已撤销、被更正替代的到货不能再关联发票（finance-costing-cross-month-invoices.test.ts），这条例外只会碰到有效的到货
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const invoices = new FinanceInvoices(s);
    const key = arrived(s);
    // 虚构一张已确认的退货，直接写库模拟这个状态
    s.db
      .prepare(
        `INSERT INTO purchase_returns(number,arrival_id,date,status,document,actor_id,actor_name,created_at,updated_at)
        VALUES('FICT-R1',1,'2026-02-06','confirmed',?,?,?,?,?)`,
      )
      .run(
        JSON.stringify({ lines: [{ lineIndex: 0, quantity: '4' }] }),
        maker.id,
        maker.name,
        '2026-02-06T09:00:00.000Z',
        '2026-02-06T09:00:00.000Z',
      );
    const partial = invoices.create(maker, bill('purchase', 'P-1', { date: '2026-02-10', gross: 6000 }));
    invoices.link(maker, partial.id, { version: 1, requestId: 'link-1', links: [{ obligationId: key, amount: 6000 }] });
    new FinanceInvoiceConfirm(s).confirm(maker, partial.id, { version: 2, requestId: 'confirm-1' });
    postDrafts(s);
    assert.equal(Number(obligationRow(s, key).estimate_remaining), 0, '退后按剩下的数量到票，整批暂估转回');
  } finally {
    s.close();
  }
});
