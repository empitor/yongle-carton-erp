// 红票：冲减往来、整张红冲后重开、折让不释放额度（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store, one, rows } from '../../server/core/index.js';
import { FinanceSettings } from '../../server/finance/base/settings.js';
import { FinanceParties } from '../../server/finance/parties/parties.js';
import { FinanceEvents } from '../../server/finance/events/events.js';
import { FinanceInvoices } from '../../server/finance/cash/invoices.js';
import { FinanceInvoiceMatching } from '../../server/finance/cash/invoice-matching.js';
import { FinanceEventVouchers } from '../../server/finance/events/event-voucher.js';
import { FinanceInvoiceConfirm } from '../../server/finance/cash/invoice-confirm.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, event, obligationRow, ledgerBalance, bill, arrived, confirmBlue, confirmRed, rawObligation, funds } from './finance-fixture.js';
import { returnFixture } from './finance-costing-fixture.js';
import { assertInvoiceableObligation, reissueCapacity } from '../../server/finance/cash/invoice-rules.js';

/** 单据当前财务事件名下那笔往来的编号（这些测试里每张单据只有一笔） */
function obligationOf(s: Store, source: number) {
  const row = one(s.db, rows.fin_obligations.pick({ id: true }), 'SELECT id FROM fin_obligations WHERE event_id=?', event(s, source).id);
  if (!row) throw new Error('测试数据：单据 ' + source + ' 的财务事件名下没有往来');
  return row.id;
}

/**
 * 发票匹配页应付一行的三单匹配里取已开票。服务的返回类型把应付那种（多带 matching）并进了应收那种，
 * 类型上看不到 matching，只好按结构认这一项。
 */
const matchingInvoiced = z.object({ invoiced: z.number().nullable() });

test('销售折让红票冲减应收往来，往来金额和总账应收一致；不记账的红票不动往来', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const events = new FinanceEvents(s),
      parties = new FinanceParties(s);
    physical(s, 1, 'delivery', '2026-02-05', deliveryDoc('1', { price: '100.0000' }));
    physical(s, 2, 'delivery', '2026-02-06', deliveryDoc('1', { price: '50.0000' }));
    events.sync(maker);
    for (const source of [1, 2])
      new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
    postDrafts(s);
    const first = obligationOf(s, 1),
      second = obligationOf(s, 2);
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 15000);
    const blue = confirmBlue(s, { direction: 'sale', number: 'S-BLUE', date: '2026-02-10' }, [{ obligationId: first, amount: 10000 }]);
    confirmRed(s, { direction: 'sale', number: 'S-RED', date: '2026-02-12' }, blue.id, 2000, '5001');
    assert.equal(Number(obligationRow(s, first).amount_cents), 8000, '应收从 100 元冲减到 80 元');
    const row = parties.obligations(maker, { kind: 'receivable' }).rows.find((r) => r.id === first);
    assert.ok(row, '逐笔里有这笔应收');
    assert.equal(Number(row.balance), 8000);
    assert.equal(Number(row.invoiced), 8000);
    // 按送货确认收入时蓝票本身不记账；不填对方科目的整张红票也不记账，往来和总账都不动。
    const other = confirmBlue(s, { direction: 'sale', number: 'S-OTHER', date: '2026-02-10' }, [{ obligationId: second, amount: 5000 }]);
    const unbooked = confirmRed(s, { direction: 'sale', number: 'S-OTHER-RED', date: '2026-02-13' }, other.id, 5000);
    const unbookedRow = s.db.prepare('SELECT voucher_id FROM fin_invoices WHERE id=?').get(unbooked.id);
    assert.ok(unbookedRow, '红票在库里');
    assert.equal(unbookedRow.voucher_id, null);
    assert.equal(Number(obligationRow(s, second).amount_cents), 5000);
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 8000 + 5000, '总账应收 = 往来合计');
  } finally {
    s.close();
  }
});

test('开票确认收入：整张红冲后应收为 0，重开蓝票恢复应收，额度用完再开被拦', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const settings = new FinanceSettings(s);
    settings.update(maker, { version: 3, requestId: 'policy', revenueRecognition: 'invoice' });
    const events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s);
    // 确认时间晚于切换口径的时间，这张送货单按开票确认收入
    physical(s, 1, 'delivery', '2026-02-05', deliveryDoc('1', { price: '100.0000', confirmedAt: '2999-01-01T00:00:00.000Z' }));
    events.sync(maker);
    assert.equal(event(s, 1).status, 'waiting_invoice');
    const key = obligationOf(s, 1);
    const blue = confirmBlue(s, { direction: 'sale', number: 'I-BLUE', date: '2026-02-10' }, [{ obligationId: key, amount: 10000 }]);
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 10000);
    confirmRed(s, { direction: 'sale', number: 'I-RED', date: '2026-02-11' }, blue.id, 10000);
    assert.equal(Number(obligationRow(s, key).amount_cents), 0, '整张红冲后应收为 0');
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 0);
    assert.ok(
      new FinanceInvoiceMatching(s).list(maker, { kind: 'receivable' }).rows.some((r) => r.id === key),
      '关联列表里还能选到这张送货单',
    );
    const again = confirmBlue(s, { direction: 'sale', number: 'I-AGAIN', date: '2026-02-12' }, [{ obligationId: key, amount: 10000 }]);
    assert.equal(Number(obligationRow(s, key).amount_cents), 10000, '重开后应收恢复');
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 10000);
    const againLink = s.db.prepare('SELECT estimate_cents FROM fin_invoice_links WHERE invoice_id=?').get(again.id);
    assert.ok(againLink, '重开的蓝票有关联');
    assert.equal(againLink.estimate_cents, 0, '重开的关联记 0 以示区分');
    const extra = invoices.create(maker, bill('sale', 'I-EXTRA', { date: '2026-02-13', gross: 100 }));
    invoices.link(maker, extra.id, {
      version: 1,
      requestId: 'link-extra',
      links: [{ obligationId: key, amount: 100 }],
    });
    assert.throws(
      () => new FinanceInvoiceConfirm(s).confirm(maker, extra.id, { version: 2, requestId: 'confirm-extra' }),
      /累计开票超过送货价税金额/,
    );
  } finally {
    s.close();
  }
});

test('开票确认收入：折让红票冲减应收后，不能再开蓝票把折让抵消', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const settings = new FinanceSettings(s);
    settings.update(maker, { version: 3, requestId: 'policy', revenueRecognition: 'invoice' });
    const events = new FinanceEvents(s),
      invoices = new FinanceInvoices(s);
    physical(s, 1, 'delivery', '2026-02-05', deliveryDoc('1', { price: '100.0000', confirmedAt: '2999-01-01T00:00:00.000Z' }));
    events.sync(maker);
    const key = obligationOf(s, 1);
    const blue = confirmBlue(s, { direction: 'sale', number: 'D-BLUE', date: '2026-02-10' }, [{ obligationId: key, amount: 10000 }]);
    confirmRed(s, { direction: 'sale', number: 'D-RED', date: '2026-02-11' }, blue.id, 2000, '5001');
    assert.equal(Number(obligationRow(s, key).amount_cents), 8000);
    assert.equal(ledgerBalance(s, '1122', '2026-02'), 8000);
    const extra = invoices.create(maker, bill('sale', 'D-EXTRA', { date: '2026-02-12', gross: 2000 }));
    invoices.link(maker, extra.id, {
      version: 1,
      requestId: 'link-extra',
      links: [{ obligationId: key, amount: 2000 }],
    });
    assert.throws(
      () => new FinanceInvoiceConfirm(s).confirm(maker, extra.id, { version: 2, requestId: 'confirm-extra' }),
      /累计开票超过送货价税金额/,
    );
    assert.equal(Number(obligationRow(s, key).amount_cents), 8000);
  } finally {
    s.close();
  }
});

test('采购发票开错整张红冲后重开：应付恢复、额度用完再开被拦；发票比对和往来页的已开票都扣掉红票；入库成本和总账对得上', () => {
  const f = returnFixture();
  try {
    const link = [{ obligationId: f.payable, amount: 10000 }];
    const wrong = confirmBlue(f.s, { direction: 'purchase', number: 'WRONG', date: '2026-02-10' }, link);
    confirmRed(f.s, { direction: 'purchase', number: 'RED', date: '2026-02-11' }, wrong.id, 10000);
    assert.equal(f.amount(), 0, '整张红冲后应付为 0');
    const matched = () =>
      new FinanceInvoiceMatching(f.s).list(maker, { kind: 'payable' }).rows.find((r) => r.id === f.payable);
    assert.ok(matched(), '关联列表里还能选到这批到货');
    confirmBlue(f.s, { direction: 'purchase', number: 'RIGHT', date: '2026-02-12' }, link);
    assert.equal(f.amount(), 10000, '重开后应付恢复成发票金额');
    const row = matched();
    assert.ok(row && 'matching' in row, '应付一侧带三单匹配');
    const matching = matchingInvoiced.parse(row.matching);
    assert.deepEqual([Number(row.invoiced), Number(matching.invoiced)], [10000, 10000], '已开票 = 两张蓝票 200 元 - 红票 100 元');
    const party = new FinanceParties(f.s).obligations(maker, { kind: 'payable' }).rows.find((r) => r.id === f.payable);
    assert.ok(party, '往来页里有这笔应付');
    assert.equal(Number(party.invoiced), 10000, '和往来页口径一致');
    const extra = f.invoices.create(maker, bill('purchase', 'EXTRA', { date: '2026-02-13' }));
    f.invoices.link(maker, extra.id, { version: 1, requestId: 'link-extra', links: link });
    assert.throws(
      () => new FinanceInvoiceConfirm(f.s).confirm(maker, extra.id, { version: 2, requestId: 'confirm-extra' }),
      /暂估已全部转回/,
      '额度用完了不能再开',
    );
    assert.equal(Number(f.costed().in_cents), 10000, '入库成本 100');
    assert.deepEqual([f.ledger('1403'), f.ledger('2202')], [10000, -10000], '总账原材料 100、应付 100（贷方）');
  } finally {
    f.s.close();
  }
});

test('采购红票冲减已付清的应付：冲减后显示多付，总账和往来明细一致', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s);
    const key = arrived(s, '2026-01-15');
    const blue = confirmBlue(
      s,
      { direction: 'purchase', number: 'BLUE', date: '2026-01-20', gross: 11300, extra: { net: 10000, tax: 1300, rate: '13' } },
      [{ obligationId: key, amount: 11300 }],
    );
    funds(s, cash, { kind: 'payment', date: '2026-01-25', amount: 11300 }, [
      { obligationId: key, version: obligationRow(s, key).version, amount: 11300 },
    ]);
    // 供应商给了 20 元不含税的折让，开红票
    const invoices = new FinanceInvoices(s);
    const red = invoices.create(
      maker,
      bill('purchase', 'RED', { date: '2026-01-28', net: -2000, tax: -260, gross: -2260, rate: '13', originalId: blue.id }),
    );
    new FinanceInvoiceConfirm(s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red', counterAccount: '1403' });
    postDrafts(s);
    const row = new FinanceParties(s).obligations(maker, { kind: 'payable' }).rows.find((r) => r.id === key);
    assert.ok(row, '往来页里有这笔应付');
    assert.equal(Number(row.amount_cents), 9040, '应付从 113 元冲减到 90.4 元');
    assert.equal(Number(row.balance), -2260, '已经付了 113 元，多付 22.6 元，供应商欠我们');
    assert.equal(Number(row.invoiced), 9040, '已开票也扣掉了红票');
    assert.equal(ledgerBalance(s, '2202'), -Number(row.balance), '总账应付借方 22.6 元，和往来明细的多付一致');
  } finally {
    s.close();
  }
});

test('折让红票不释放重开额度：再开一张蓝票被拦下，折让不会被抵消', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const invoices = new FinanceInvoices(s);
    const key = arrived(s);
    const blue = confirmBlue(s, { direction: 'purchase', number: 'B', date: '2026-02-10' }, [{ obligationId: key, amount: 10000 }]);
    confirmRed(s, { direction: 'purchase', number: 'B-DISCOUNT', date: '2026-02-11' }, blue.id, 2000, '1403');
    assert.equal(Number(obligationRow(s, key).amount_cents), 8000);
    const extra = invoices.create(maker, bill('purchase', 'DUP', { date: '2026-02-12', gross: 2000 }));
    invoices.link(maker, extra.id, {
      version: 1,
      requestId: 'link-dup',
      links: [{ obligationId: key, amount: 2000 }],
    });
    assert.throws(
      () => new FinanceInvoiceConfirm(s).confirm(maker, extra.id, { version: 2, requestId: 'confirm-dup' }),
      /暂估已全部转回.*折让红票不释放额度/,
    );
    assert.equal(Number(obligationRow(s, key).amount_cents), 8000, '折让还在');
  } finally {
    s.close();
  }
});

test('先折让再把剩下的整张红冲：只释放剩下的额度，重开只能开到折让后的金额', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-02');
    const invoices = new FinanceInvoices(s);
    const key = arrived(s);
    const blue = confirmBlue(s, { direction: 'purchase', number: 'B', date: '2026-02-10' }, [{ obligationId: key, amount: 10000 }]);
    confirmRed(s, { direction: 'purchase', number: 'B-DISCOUNT', date: '2026-02-11' }, blue.id, 2000, '1403');
    confirmRed(s, { direction: 'purchase', number: 'B-REST', date: '2026-02-12' }, blue.id, 8000, '1403');
    assert.equal(Number(obligationRow(s, key).amount_cents), 0);
    const tooMuch = invoices.create(maker, bill('purchase', 'TOO-MUCH', { date: '2026-02-13', gross: 10000 }));
    invoices.link(maker, tooMuch.id, {
      version: 1,
      requestId: 'link-too-much',
      links: [{ obligationId: key, amount: 10000 }],
    });
    assert.throws(
      () => new FinanceInvoiceConfirm(s).confirm(maker, tooMuch.id, { version: 2, requestId: 'confirm-too-much' }),
      /重开的发票超过整张红冲释放的额度/,
    );
    confirmBlue(s, { direction: 'purchase', number: 'RIGHT', date: '2026-02-14' }, [{ obligationId: key, amount: 8000 }]);
    assert.equal(Number(obligationRow(s, key).amount_cents), 8000, '重开后应付是折让后的 80 元');
  } finally {
    s.close();
  }
});

test('部分红票按累计分摊释放额度，合计正好等于红票额', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store, '2026-02');
    const small = rawObligation(store, 1),
      large = rawObligation(store, 99);
    const invoices = new FinanceInvoices(store);
    const bill = (extra: Record<string, unknown>) => ({ direction: 'sale', type: '虚构数电票', partyId: 1, rate: '0', tax: 0, ...extra });
    const blue = invoices.create(
      maker,
      bill({ requestId: 'b', number: 'B-1', date: '2026-02-10', net: 100, gross: 100 }),
    );
    invoices.link(maker, blue.id, {
      version: 1,
      requestId: 'l',
      links: [
        { obligationId: small, amount: 1 },
        { obligationId: large, amount: 99 },
      ],
    });
    new FinanceInvoiceConfirm(store).confirm(maker, blue.id, { version: 2, requestId: 'bc' });
    const red = invoices.create(
      maker,
      bill({ requestId: 'r', number: 'R-1', date: '2026-02-11', net: -1, gross: -1, originalId: blue.id }),
    );
    new FinanceInvoiceConfirm(store).confirm(maker, red.id, { version: 1, requestId: 'rc' });
    const listed = new FinanceInvoiceMatching(store).list(maker, { kind: 'receivable' }).rows;
    const total = listed
      .filter((r) => [small, large].includes(r.id))
      .reduce((n, r) => n + Number(r.invoiced || 0), 0);
    assert.equal(total, 99, '开了 100，红冲 1，还占 99');
  } finally {
    store.close();
  }
});

test('发票关联的判定直接调：没有的往来报不存在，没有整张红冲就没有重开额度', () => {
  const s = new Store(':memory:');
  try {
    assert.throws(() => assertInvoiceableObligation(s.db, 99, (arrival) => arrival), /往来单不存在/);
    assert.equal(reissueCapacity(s.db, 99, 1), 0);
  } finally {
    s.close();
  }
});
