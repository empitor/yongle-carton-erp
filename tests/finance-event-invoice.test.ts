// 已开票的送货、到货被冲销或更正时的发票和往来（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceEventViews } from '../server/finance/event-views.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceAllocations } from '../server/finance/allocations.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, arrivalDoc, event, obligation, obligationRow, funds, bill, ledgerBalance, subledger, eventsStep, setDoc } from './finance-fixture.js';
import { count } from '../server/core/index.js';

test('已开票送货被冲销，整张红票后可以更正，结账的事件步骤放行', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const o = obligation(s, 1);
    const blue = invoices.create(maker, bill('sale', 'SALE-BLUE'));
    invoices.link(maker, blue.id, {
      version: 1,
      requestId: 'link',
      links: [{ obligationId: o.id, amount: 10000 }],
    });
    new FinanceInvoiceConfirm(s).confirm(maker, blue.id, { version: 2, requestId: 'confirm-blue' });
    postDrafts(s);
    s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
    events.sync(maker);
    const diff = new FinanceEventViews(s).list(maker, { status: 'difference' }).rows[0];
    assert.equal(diff.event_type, 'delivery.reversed');
    const correct = (requestId: string) =>
      new FinanceEventHandling(s).correct(maker, diff.id, {
        version: Number(diff.version),
        date: '2026-01-20',
        requestId,
        reason: '虚构冲销送货',
      });
    assert.throws(() => correct('too-early'), /关联发票/, '还有有效发票时不能更正');
    assert.equal(eventsStep(s).ok, false);
    const red = invoices.create(
      maker,
      bill('sale', 'SALE-RED', { date: '2026-01-16', net: -10000, gross: -10000, originalId: blue.id }),
    );
    new FinanceInvoiceConfirm(s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red' });
    postDrafts(s);
    assert.equal(correct('after-red').status, 'corrected');
    postDrafts(s);
    assert.equal(ledgerBalance(s, '1122'), 0, '送货凭证已红冲，总账应收为 0');
    assert.equal(subledger(s, 'receivable'), 0, '往来明细和总账一致');
    assert.equal(eventsStep(s).ok, true, '结账检查不再被这张事件卡住');
  } finally {
    s.close();
  }
});

test('作废的发票草稿还挂着关联，不妨碍更正', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const o = obligation(s, 1);
    const draft = invoices.create(maker, bill('sale', 'SALE-DRAFT'));
    invoices.link(maker, draft.id, {
      version: 1,
      requestId: 'link',
      links: [{ obligationId: o.id, amount: 10000 }],
    });
    invoices.status(maker, draft.id, {
      version: 2,
      requestId: 'void-draft',
      status: 'void',
      date: '2026-01-12',
      reason: '虚构开错作废',
    });
    assert.ok(s.db.prepare('SELECT 1 FROM fin_invoice_links WHERE obligation_id=?').get(o.id));
    s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
    events.sync(maker);
    const diff = new FinanceEventViews(s).list(maker, { status: 'difference' }).rows[0];
    const result = new FinanceEventHandling(s).correct(maker, diff.id, {
      version: Number(diff.version),
      date: '2026-01-20',
      requestId: 'correct',
      reason: '虚构冲销送货',
    });
    assert.equal(result.status, 'corrected');
    postDrafts(s);
    assert.equal(ledgerBalance(s, '1122'), 0);
    assert.equal(subledger(s, 'receivable'), 0);
    assert.equal(eventsStep(s).ok, true);
  } finally {
    s.close();
  }
});

test('开票确认收入，开票后送货单原地修改走差异，不多出一笔待开票应收', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    new FinanceSettings(s).update(maker, {
      version: 3,
      requestId: 'invoice-policy',
      revenueRecognition: 'invoice',
    });
    const events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s);
    // 口径改动的时间写定在单据确认之前（虚构），送货按开票确认收入
    s.db.prepare("UPDATE fin_settings_history SET changed_at='2026-01-01T00:00:00.000Z'").run();
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    events.sync(maker);
    assert.equal(event(s, 1).status, 'waiting_invoice');
    const o = obligation(s, 1);
    assert.equal(o.voucher_id, null);
    const blue = invoices.create(maker, bill('sale', 'SALE-1'));
    invoices.link(maker, blue.id, {
      version: 1,
      requestId: 'link',
      links: [{ obligationId: o.id, amount: 10000 }],
    });
    new FinanceInvoiceConfirm(s).confirm(maker, blue.id, { version: 2, requestId: 'confirm' });
    postDrafts(s);
    const invoicedEvent = event(s, 1);
    assert.equal(invoicedEvent.status, 'generated');
    assert.equal(invoicedEvent.voucher_id, null, '凭证挂在往来上，事件本身没有凭证号');
    // 送货数量改成 2（版本 1 → 2）
    setDoc(s, 1, '$.lines[0].quantity', '2');
    events.sync(maker);
    const changed = event(s, 1);
    assert.notEqual(changed.id, invoicedEvent.id);
    assert.equal(changed.status, 'difference', '已开票的送货单改了要人工核对');
    const active = () =>
      s.db
        .prepare(
          "SELECT * FROM fin_obligations WHERE kind='receivable' AND tax_status<>'superseded' AND reversal_of IS NULL ORDER BY id",
        )
        .all();
    assert.deepEqual(
      active().map((r) => [Number(r.id), Number(r.amount_cents)]),
      [[Number(o.id), 10000]],
      '没有再生成一笔 200 元的待开票应收',
    );
    const correct = (requestId: string) =>
      new FinanceEventHandling(s).correct(maker, changed.id, {
        version: Number(changed.version),
        date: '2026-01-20',
        requestId,
        reason: '虚构改数量',
      });
    assert.throws(() => correct('early'), /关联发票/);
    const red = invoices.create(
      maker,
      bill('sale', 'SALE-1-RED', { date: '2026-01-18', net: -10000, gross: -10000, originalId: blue.id }),
    );
    new FinanceInvoiceConfirm(s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red' });
    postDrafts(s);
    const after = correct('after-red');
    assert.equal(after.status, 'waiting_invoice');
    assert.equal(obligationRow(s, o.id).tax_status, 'superseded', '原往来被替代，不再冲一次凭证');
    assert.deepEqual(
      active().map((r) => Number(r.amount_cents)),
      [20000],
      '只剩按新数量待开票的 200 元',
    );
    assert.equal(ledgerBalance(s, '1122'), 0, '原发票凭证被红票冲平，没有重复红冲');
    assert.equal(ledgerBalance(s, '5001'), 0);
  } finally {
    s.close();
  }
});

test('原应付已整张红冲且付过款，来源更正先拦下；处理后原往来被替代，不能再关联新票', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s);
    physical(s, 1, 'arrival', '2026-01-10', arrivalDoc('10'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    const payable = Number(obligation(s, 1).id);
    const blue = invoices.create(maker, bill('purchase', 'BLUE'));
    invoices.link(maker, blue.id, {
      version: 1,
      requestId: 'link',
      links: [{ obligationId: payable, amount: 10000 }],
    });
    new FinanceInvoiceConfirm(s).confirm(maker, blue.id, { version: 2, requestId: 'confirm-blue' });
    postDrafts(s);
    funds(s, cash, { kind: 'payment', date: '2026-01-16', amount: 10000 }, [
      { obligationId: payable, version: Number(obligationRow(s, payable).version), amount: 10000 },
    ]);
    const red = invoices.create(
      maker,
      bill('purchase', 'RED', { date: '2026-01-17', net: -10000, gross: -10000, originalId: blue.id }),
    );
    new FinanceInvoiceConfirm(s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red' });
    postDrafts(s);
    assert.equal(Number(obligationRow(s, payable).amount_cents), 0, '整张红冲后应付为 0，已付 100 显示多付');
    // 超级管理员冲销原到货，按 8 张更正
    s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
    physical(s, 2, 'arrival', '2026-01-18', arrivalDoc('8', { correctionOf: 1 }));
    events.sync(maker);
    const replacement = event(s, 2),
      reversed = event(s, 1);
    assert.equal(replacement.status, 'difference');
    assert.equal(reversed.status, 'difference');
    const correct = (e: { id: number }, requestId: string) =>
      new FinanceEventHandling(s).correct(maker, e.id, {
        version: Number(event(s, Number(e.id) === Number(replacement.id) ? 2 : 1).version),
        date: '2026-01-20',
        requestId,
        reason: '虚构到货更正',
      });
    for (const e of [replacement, reversed])
      assert.throws(() => correct(e, 'blocked-' + e.id), /全额红冲且仍有付款核销/);
    assert.equal(count(s.db, "SELECT count(*) FROM fin_obligations WHERE kind='payable'"), 1, '被拦下时没有悄悄新建应付');
    const allocation = s.db.prepare('SELECT * FROM fin_allocations WHERE obligation_id=? AND reversal_of IS NULL').get(payable);
    new FinanceAllocations(s).revoke(maker, allocation?.id, {
      version: Number(allocation?.version),
      requestId: 'revoke',
      date: '2026-01-19',
      reason: '虚构付款转预付',
    });
    postDrafts(s);
    const rebuilt = correct(replacement, 'correct-replacement');
    assert.equal(rebuilt.status, 'generated');
    assert.equal(correct(reversed, 'correct-reversed').status, 'corrected');
    postDrafts(s);
    assert.equal(obligationRow(s, payable).tax_status, 'superseded', '原往来被替代，重开额度随之作废');
    assert.equal(Number(obligation(s, 2).amount_cents), 8000);
    const extra = invoices.create(maker, bill('purchase', 'EXTRA', { date: '2026-01-21', net: 8000, gross: 8000 }));
    assert.throws(
      () =>
        invoices.link(maker, extra.id, {
          version: 1,
          requestId: 'link-extra',
          links: [{ obligationId: payable, amount: 8000 }],
        }),
      /更正|不符/,
      '新蓝票不能再挂到被替代的原往来上',
    );
    assert.equal(subledger(s, 'payable'), 8000);
    assert.equal(-ledgerBalance(s, '2202'), 8000, '总账应付只有更正后的 80 元暂估');
    assert.equal(ledgerBalance(s, '1403'), 8000, '原材料也只有 80 元');
    assert.equal(eventsStep(s).ok, true);
  } finally {
    s.close();
  }
});
