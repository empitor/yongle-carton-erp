// 采购退货在财务里怎么记：未到票冲减暂估、撤销加回，已到票等红票（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bill as invoiceInput, maker, postDrafts, supervisor } from './finance-fixture.js';
import { returnFixture } from './finance-costing-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { adjacentPeriod } from '../server/finance/periods.js';
import { count } from '../server/core/index.js';

test('采购退货（未到票）：按退货后的数量到票，暂估自动全部转回，应付和成本以发票为准', () => {
  const f = returnFixture();
  try {
    f.returns.create(maker, { arrivalId: f.received.id, date: '2026-02-08', reason: '虚构质量问题', requestId: 'return-goods', lines: [{ lineIndex: 0, quantity: '3' }] });
    const bill = f.invoices.create(maker, invoiceInput('purchase', 'NET', { date: '2026-02-10', net: 7000, gross: 7000 }));
    f.invoices.link(maker, bill.id, { version: 1, requestId: 'link', links: [{ obligationId: f.payable, amount: 7000 }] });
    new FinanceInvoiceConfirm(f.s).confirm(maker, bill.id, { version: 2, requestId: 'confirm' });
    postDrafts(f.s);
    assert.equal(f.amount(), 7000, '应付 70');
    assert.equal(f.ledger('2202'), -7000, '总账应付 70');
    const c = f.costed();
    assert.deepEqual([Number(c.in_qty), Number(c.in_cents), Number(c.end_qty)], [7000, 7000, 7000], '入库 7 张、70 元');
    assert.equal(f.ledger('1403'), 7000, '总账原材料 70');
  } finally {
    f.s.close();
  }
});

test('采购退货（已到票）：不冲暂估，等供应商开红票，应付和成本只冲一次', () => {
  const f = returnFixture();
  try {
    const bill = f.invoices.create(maker, invoiceInput('purchase', 'FULL', { date: '2026-02-06' }));
    f.invoices.link(maker, bill.id, { version: 1, requestId: 'link', links: [{ obligationId: f.payable, amount: 10000 }] });
    new FinanceInvoiceConfirm(f.s).confirm(maker, bill.id, { version: 2, requestId: 'confirm' });
    postDrafts(f.s);
    f.returns.create(maker, { arrivalId: f.received.id, date: '2026-02-08', reason: '虚构质量问题', requestId: 'return-goods', lines: [{ lineIndex: 0, quantity: '3' }] });
    new FinanceEvents(f.s).sync(maker);
    assert.equal(count(f.s.db, "SELECT count(*) FROM fin_vouchers WHERE module_source='purchase_return'"), 0, '已到票的退货不冲暂估，等红票');
    const red = f.invoices.create(maker, invoiceInput('purchase', 'RED', { date: '2026-02-09', net: -3000, gross: -3000, originalId: bill.id }));
    new FinanceInvoiceConfirm(f.s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red', counterAccount: '1403' });
    postDrafts(f.s);
    assert.equal(f.amount(), 7000, '应付 70');
    const c = f.costed();
    assert.deepEqual([Number(c.in_qty), Number(c.in_cents), Number(c.end_qty)], [7000, 7000, 7000], '入库 7 张、70 元，没有重复扣');
    assert.equal(f.ledger('1403'), 7000, '总账原材料 70');
  } finally {
    f.s.close();
  }
});

/** 未到票退货测试共用：同步、按全部已记账凭证加总的总账余额、退货冲暂估凭证的先后（出 / 红） */
function returnBooks(f: ReturnType<typeof returnFixture>) {
  const sync = () => new FinanceEvents(f.s).sync(maker);
  const gl = (code: string) =>
    Number(
      f.s.db
        .prepare(
          `SELECT coalesce(sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)),0) AS n
          FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND e.account_code LIKE ?`,
        )
        .get(code + '%')?.n,
    );
  const estimates = () =>
    f.s.db
      .prepare("SELECT reversal_of FROM fin_vouchers WHERE module_source='purchase_return' ORDER BY id")
      .all()
      .map((v) => (v.reversal_of == null ? '出' : '红'));
  const giveBack = (requestId: string, date = '2026-02-08') =>
    f.returns.create(maker, { arrivalId: f.received.id, date, reason: '虚构质量问题', requestId, lines: [{ lineIndex: 0, quantity: '3' }] });
  return { sync, gl, estimates, giveBack };
}

test('未到票就退货：同步时按暂估单价冲减暂估（红冲原暂估、按剩下的另出一张）；到票只转回剩下的暂估', () => {
  const f = returnFixture();
  try {
    const { sync, gl, estimates, giveBack } = returnBooks(f);
    // 10 张、每张 10 元，退 3 张：冲减 30 元，剩下的暂估 70
    giveBack('return-1');
    sync();
    postDrafts(f.s);
    assert.deepEqual(estimates(), ['红', '出'], '红冲原暂估、另出一张剩下的');
    assert.equal(f.amount(), 7000);
    assert.deepEqual([gl('2202'), gl('1403')], [-7000, 7000], '总账应付、原材料都是 70');
    sync();
    assert.deepEqual(estimates(), ['红', '出'], '冲过的不再冲');
    // 按 70 到票：只转回剩下的 70，不另填对应暂估，没有调差
    const bill = f.invoices.create(maker, invoiceInput('purchase', 'NET-70', { date: '2026-02-10', net: 7000, gross: 7000 }));
    f.invoices.link(maker, bill.id, { version: 1, requestId: 'link', links: [{ obligationId: f.payable, amount: 7000 }] });
    new FinanceInvoiceConfirm(f.s).confirm(maker, bill.id, { version: 2, requestId: 'confirm' });
    postDrafts(f.s);
    assert.equal(f.amount(), 7000);
    assert.deepEqual([gl('2202'), gl('1403')], [-7000, 7000]);
    // 成本计算按退掉的暂估冲减入库成本：入库 7 张、70 元，和总账原材料一致
    const c = f.costed();
    assert.deepEqual([Number(c.in_qty), Number(c.in_cents), Number(c.end_qty)], [7000, 7000, 7000]);
  } finally {
    f.s.close();
  }
});

test('未到票的退货日期所在月份已结账：冲暂估的凭证记到最早没结账月份的 1 号', () => {
  const f = returnFixture();
  try {
    const { sync, estimates, giveBack } = returnBooks(f);
    giveBack('return-closed');
    // 2 月已结账（只在内存库里直接标记）
    f.s.db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-02','closed') ON CONFLICT(period) DO UPDATE SET status='closed'").run();
    sync();
    assert.deepEqual(estimates(), ['红', '出']);
    const dates = f.s.db.prepare("SELECT DISTINCT date FROM fin_vouchers WHERE module_source='purchase_return'").all().map((r) => r.date);
    assert.deepEqual(dates, ['2026-03-01']);
  } finally {
    f.s.close();
  }
});

test('未到票的退货撤销：剩下那张暂估红冲、按原数另出一张，冲减跟着回来', () => {
  const f = returnFixture();
  try {
    const { sync, gl, estimates, giveBack } = returnBooks(f);
    const back = giveBack('return-1');
    sync();
    postDrafts(f.s);
    const current = f.s.db.prepare('SELECT version FROM purchase_returns WHERE id=?').get(back.id);
    f.returns.reverse(supervisor, back.id, { version: Number(current?.version), reason: '虚构退错了' });
    // 撤销退货默认记在今天，挪到 3 月 5 日（虚构），只算 2、3 两个月，不随真实日期变
    businessChanges(f.s).moveMovements({ kind: 'purchase_return', id: back.id }, '2026-03-05', true);
    businessChanges(f.s).returnReversedAt(back.id, '2026-03-05T02:00:00.000Z');
    sync();
    postDrafts(f.s);
    assert.deepEqual(estimates(), ['红', '出', '红', '出']);
    assert.equal(f.amount(), 10000);
    assert.deepEqual([gl('2202'), gl('1403')], [-10000, 10000]);
    sync();
    assert.equal(estimates().length, 4, '恢复过的不再恢复');
    // 成本：退货那天按 30 元冲减，撤销那天加回，数量和金额一起回来
    const moves = f.s.db.prepare("SELECT date,delta_units FROM stock_movements WHERE source_kind='purchase_return'").all();
    assert.equal(moves.length, 2, '退货一条、撤销一条');
    const undone = moves.find((m) => Number(m.delta_units) > 0);
    assert.ok(undone, '有撤销那条流水');
    // 撤销记在 3 月 5 日，算 2、3 两个月
    const cost = new FinanceCosting(f.s);
    for (let period = '2026-02'; period <= String(undone.date).slice(0, 7); period = adjacentPeriod(period, 1)) {
      cost.run(maker, { period, requestId: 'cost-' + period });
      if (period === '2026-02') {
        const feb = f.s.db.prepare('SELECT in_qty,in_cents FROM fin_inventory_costs WHERE period=? AND stock_id=?').get(period, f.raw.id);
        assert.deepEqual([Number(feb?.in_qty), Number(feb?.in_cents)], [7000, 7000], '2 月：退货按 30 元冲减');
      }
    }
    const last = f.s.db.prepare('SELECT end_qty,end_cents FROM fin_inventory_costs WHERE stock_id=? ORDER BY period DESC LIMIT 1').get(f.raw.id);
    assert.deepEqual([Number(last?.end_qty), Number(last?.end_cents)], [10000, 10000], '撤销后 10 张、100 元');
  } finally {
    f.s.close();
  }
});

