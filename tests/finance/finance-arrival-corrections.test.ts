// 到货更正、改订单拆单、替代单落在已结账月份（全部是虚构数据，只用内存库）
import { sales } from '../../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customerSchema } from '../../shared/core/domain.js';
import { one, rows } from '../../server/core/index.js';
import { FinanceClosing } from '../../server/finance/reports/closing.js';
import { FinanceMonthly } from '../../server/finance/reports/monthly.js';
import { maker, postDrafts, subledger } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

type Flow = Awaited<ReturnType<typeof flowFinance>>;

/** 到货单被更正后替代它的那张（没有就让测试失败） */
function replacementOf(t: Flow, id: number) {
  const row = one(
    t.f.store.db,
    rows.flow_documents.pick({ id: true }),
    "SELECT id FROM flow_documents WHERE kind='arrival' AND correction_of=?",
    id,
  );
  if (!row) throw new Error('测试数据：到货单 ' + id + ' 没有替代单');
  return row.id;
}

test('到货更正，原单还没入过账：原单直接已更正，替代单按新到货可记账、进应付，月度台账只算替代单一次', async () => {
  const t = await flowFinance();
  try {
    const a = t.receive('6000', '虚构供应商单号-乙');
    t.sync();
    assert.equal(t.current(a.id).status, 'ready');
    t.correctArrival(a.id, '5000');
    t.sync();
    const b = replacementOf(t, a.id);
    assert.equal(t.current(a.id).status, 'corrected', '原单不用处理');
    const replacement = t.current(b);
    assert.equal(replacement.status, 'ready', '替代单和直接登记一张一样，可记账');
    assert.equal(replacement.amount_cents, 500000, '5000 张 × 1 元');
    assert.equal(t.differences(), 0);
    const month = new FinanceMonthly(t.f.store).get(maker, { period: '2026-10' });
    assert.equal(month.theoreticalExpense, 500000, '月度台账只算替代单一次');
    assert.equal(t.book(b, true).status, 'generated');
    assert.equal(subledger(t.f.store, 'payable'), 500000, '应付等于替代单金额');
    assert.equal(t.closingOk(), true);
    assert.equal(t.sync(), 0, '重复同步没有新动静');
    // 原单已被替代，不许再改（要改的是现在有效的那张）：修改被拒，财务事件一个字都没动
    const before = { count: t.count(), original: t.current(a.id), replacement: t.current(b) };
    assert.throws(() => t.info(a.id, { notes: '管理员补备注' }), /已被更正替代，请改替代它的那张/);
    assert.equal(t.sync(), 0);
    assert.equal(t.count(), before.count, '不多出事件');
    assert.deepEqual(t.current(a.id), before.original, '原单的事件没动，仍是已更正');
    assert.deepEqual(t.current(b), before.replacement, '替代单的事件没动');
  } finally {
    t.f.store.close();
  }
});

test('到货更正，原单已生成凭证：原单、替代单照旧“有差异”，红冲重做后应付等于替代单金额', async () => {
  const t = await flowFinance();
  try {
    const a = t.receive('6000', '虚构供应商单号-丙');
    t.sync();
    t.book(a.id, true);
    t.correctArrival(a.id, '5000');
    t.sync();
    const b = replacementOf(t, a.id);
    assert.equal(t.current(a.id).status, 'difference');
    // 被更正替代的原单状态也是“已冲销”，说明按实际写“已被更正替代”，和确认窗、红冲后的结果说明一致
    assert.match(String(t.current(a.id).problem), /^单据已被更正替代/);
    assert.equal(t.current(b).status, 'difference', '原单入过账，替代单要等红冲重做');
    assert.equal(t.closingOk(), false);
    t.correctAll(a.id, 'arrival');
    t.correctAll(b, 'arrival');
    assert.equal(t.current(a.id).status, 'corrected');
    assert.equal(t.current(b).status, 'generated');
    postDrafts(t.f.store);
    assert.equal(subledger(t.f.store, 'payable'), 500000);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

test('到货连续更正两次、更正后又撤销替代单：入过账的那张红冲，应付只剩最后一张；都没入过账的不用处理', async () => {
  const t = await flowFinance();
  try {
    // 第一次更正时原单没入过账；替代单入账后又更正一次
    const a = t.receive('6000', '虚构供应商单号-丁');
    t.sync();
    t.correctArrival(a.id, '5000');
    t.sync();
    const b = replacementOf(t, a.id);
    t.book(b, true);
    t.correctArrival(b, '4000');
    t.sync();
    const c = replacementOf(t, b);
    assert.equal(t.current(a.id).status, 'corrected');
    assert.equal(t.current(b).status, 'difference', '入过账的替代单被替代，要红冲');
    assert.equal(t.current(c).status, 'difference');
    t.correctAll(c, 'arrival');
    t.correctAll(b, 'arrival');
    postDrafts(t.f.store);
    assert.equal(t.current(b).status, 'corrected');
    assert.equal(t.current(c).status, 'generated');
    assert.deepEqual(t.active('arrival', b), [], '第二张的应付红冲掉了');
    assert.equal(subledger(t.f.store, 'payable'), 400000, '应付只剩最后一张');
    // 最后一张也撤销：它入过账，照旧要红冲；红冲后应付清零
    t.reverse(c);
    t.sync();
    assert.equal(t.current(c).status, 'difference');
    t.correctAll(c, 'arrival');
    assert.equal(t.current(c).status, 'corrected');
    assert.equal(subledger(t.f.store, 'payable'), 0);
    assert.equal(t.closingOk(), true);
    // 另一张：更正两次、再撤销，全程没入过账，都不用处理
    const d = t.receive('3000', '虚构供应商单号-戊');
    t.sync();
    t.correctArrival(d.id, '2000');
    t.sync();
    const e = replacementOf(t, d.id);
    t.correctArrival(e, '1000');
    t.sync();
    const g = replacementOf(t, e);
    assert.equal(t.current(g).status, 'ready');
    t.reverse(g);
    t.sync();
    for (const id of [d.id, e, g]) assert.equal(t.current(id).status, 'corrected');
    for (const id of [d.id, e, g]) assert.deepEqual(t.active('arrival', id), []);
    assert.equal(t.differences(), 0);
    assert.equal(t.closingOk(), true);
    assert.equal(t.sync(), 0);
  } finally {
    t.f.store.close();
  }
});

test('改订单把已撤销的送货单拆开：原单的事件就地更新，拆出来的新单直接已更正，不卡结账', async () => {
  const { createBusinessService } = await import('../../server/orders/index.js');
  const t = await flowFinance();
  try {
    const second = t.f.order(100, { taxRate: 0, taxMode: '未税' });
    const d = t.deliver('10', [t.order, second]);
    t.sync();
    t.reverse(d.id);
    t.sync();
    const original = t.current(d.id);
    assert.equal(original.status, 'corrected');
    const other = sales(t.f.store).createCustomer(customerSchema.parse({ name: '虚构拆单客户' }));
    const current = sales(t.f.store).order(t.order.id);
    assert.ok(current, '订单还在');
    createBusinessService(t.f.store).execute(
      { entity: 'orders', action: 'update', id: current.id, input: { ...current, customerId: other.id } },
      { source: 'manual-ui', operatorId: t.admin.id, superAdminMode: true, actor: t.admin },
    );
    const deliveries = t.f.store.db
      .prepare("SELECT id,status FROM flow_documents WHERE kind='delivery' ORDER BY id")
      .all()
      .map((r) => ({ id: Number(r.id), status: String(r.status) }));
    assert.equal(deliveries.length, 2, '拆成了两张');
    assert.ok(deliveries.every((x) => x.status === 'reversed'));
    t.sync();
    assert.equal(Number(t.current(d.id).id), Number(original.id), '原单的事件就地更新');
    assert.equal(t.current(d.id).status, 'corrected');
    const split = deliveries.find((x) => x.id !== d.id);
    assert.ok(split, '拆出来的那张');
    assert.equal(t.current(split.id).status, 'corrected', '拆出来的新单直接已更正');
    assert.equal(t.listed(t.current(split.id).id).number, t.number(split.id));
    assert.equal(t.differences(), 0);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

test('到货更正的替代单日期落在已结账的月份：按新到货可记账，凭证记到最早没结账月份的 1 号，已结账月份不动', async () => {
  const t = await flowFinance();
  try {
    const a = t.receive('6000', '虚构供应商单号-己');
    t.sync();
    // 10 月已结账（只在内存库里直接标记）
    t.f.store.db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-10','closed') ON CONFLICT(period) DO UPDATE SET status='closed'").run();
    const octoberVouchers = () =>
      t.f.store.db.prepare("SELECT * FROM fin_vouchers WHERE period='2026-10' ORDER BY id").all().map((r) => ({ ...r }));
    const before = octoberVouchers();
    t.correctArrival(a.id, '5000');
    t.sync();
    const b = replacementOf(t, a.id);
    assert.equal(t.current(a.id).status, 'corrected', '原单没入过账，不用处理');
    assert.equal(t.current(b).status, 'ready', '替代单和一张新到货一样可记账');
    const done = t.book(b, true);
    const voucher = t.f.store.db.prepare('SELECT date,description FROM fin_vouchers WHERE id=?').get(Number(done.voucher_id));
    assert.equal(voucher?.date, '2026-11-01');
    assert.match(String(voucher?.description), /单据日期 2026-10-26/);
    assert.equal(subledger(t.f.store, 'payable'), 500000);
    assert.equal(
      new FinanceClosing(t.f.store).check(maker, { period: '2026-11' }).steps.find((x) => x.key === 'events')?.ok,
      true,
    );
    assert.deepEqual(octoberVouchers(), before, '已结账月份的凭证一张没动');
  } finally {
    t.f.store.close();
  }
});
