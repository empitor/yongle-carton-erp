// 送货、盘点单据被撤销或改动后财务事件怎么记（全部是虚构数据，只用内存库）
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { businessBase } from './business-base-fixture.js';
import { Store } from '../server/core/db.js';
import { one, rows } from '../server/core/index.js';
import { readSnapshot } from '../server/finance/events/source-snapshot.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { FinanceSettlements } from '../server/finance/cash/settlements.js';
import { FinanceEventViews } from '../server/finance/events/event-views.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { FinanceAllocations } from '../server/finance/cash/allocations.js';
import { FinanceCashAccounts } from '../server/finance/cash/cash-accounts.js';
import { maker, newSettings, postDrafts, funds, ledgerBalance, subledger } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

test('财务事件的单号以单据表的单号为准：到货更正的替代单、改过说明的单据也显示单据号，不退成供应商送货单号或空', async () => {
  const t = await flowFinance();
  try {
    const arrival = t.receive('6000', '虚构供应商单号-甲');
    const shipped = t.deliver('40');
    t.sync();
    t.correctArrival(arrival.id, '5000');
    t.info(shipped.id, { notes: '管理员补备注' });
    t.sync();
    const replacement = one(
      t.f.store.db,
      rows.flow_documents.pick({ id: true }),
      "SELECT id FROM flow_documents WHERE kind='arrival' AND correction_of=?",
      arrival.id,
    );
    assert.ok(replacement, '到货更正有替代单');
    for (const id of [arrival.id, replacement.id, shipped.id]) {
      const e = t.current(id);
      assert.equal(readSnapshot(e).doc?.number, t.number(id), '快照里的单号是单据号');
      assert.equal(t.listed(e.id).number, t.number(id), '事件列表的单号是单据号');
    }
    // 补单号不改来源指纹：再同步没有新动静；改过的送货单照常生成凭证，凭证摘要带单据号
    assert.equal(t.sync(), 0, '再同步没有新动静');
    const ready = t.current(shipped.id);
    assert.equal(ready.status, 'ready');
    const done = new FinanceEventVouchers(t.f.store).generate(maker, Number(ready.id), { version: Number(ready.version), requestId: 'gen' });
    assert.equal(done.status, 'generated');
    assert.ok(
      String(new FinanceLedger(t.f.store).get(maker, Number(done.voucher_id)).header.description).includes(
        t.number(shipped.id),
      ),
      '凭证摘要带单据号',
    );
  } finally {
    t.f.store.close();
  }
});

test('盘点调整的事件单号显示库存品名、规格和调整量，不显示流水的内部编号；来源指纹不变', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const base = businessBase(maker, s),
      { flow } = base,
      events = new FinanceEvents(s);
    const item = base.raw({ name: '虚构盘点纸板', specification: '1000*800' });
    const move = (action: 'in' | 'adjust', quantity: string, date: string) =>
      flow.stock.move(
        item.id,
        {
          action,
          quantity,
          date,
          notes: '虚构盘点',
          expectedVersion: Number(s.db.prepare('SELECT version FROM stock_items WHERE id=?').get(item.id)?.version),
          acknowledged: true,
          requestId: randomUUID(),
        },
        maker,
      ).movementId;
    move('in', '10', '2026-01-05');
    const counted = move('adjust', '7', '2026-01-20');
    events.sync(maker);
    const e = one(
      s.db,
      rows.fin_events,
      `SELECT e.* FROM fin_events e JOIN fin_source_observations x ON x.event_id=e.id
        WHERE x.source_kind='stock' AND x.source_id=?`,
      counted,
    );
    assert.ok(e, '盘点调整有财务事件');
    const label = '虚构盘点纸板 1000*800 -3 张';
    assert.equal(readSnapshot(e).doc?.number, label);
    const listed = new FinanceEventViews(s).list(maker, { pageSize: 200 }).rows.find((r) => r.id === e.id);
    assert.ok(listed, '事件列表里有这条');
    assert.equal(listed.number, label, '事件列表的单号');
    assert.notEqual(listed.number, counted, '不是流水的内部编号');
    const movement = s.db
      .prepare(
        `SELECT json_object('createdAt',created_at,'deltaUnits',delta_units,'stockId',item_id) AS d
        FROM stock_movements WHERE id=?`,
      )
      .get(counted);
    const doc: unknown = JSON.parse(String(movement?.d));
    assert.equal(
      e.source_hash,
      createHash('sha256')
        .update(JSON.stringify({ status: 'confirmed', date: '2026-01-20', doc }))
        .digest('hex'),
      '来源指纹按流水内容算（键按名字排好，不含流水备注），不含显示用的单号',
    );
    assert.equal(events.sync(maker).processed, 0, '再同步没有新动静');
  } finally {
    s.close();
  }
});

test('还没入过账的送货单被撤销：可记账、资料待补的都直接已更正，不进“有差异”、不卡结账，系统挂的暂估往来作废；重复同步没有新动静', async () => {
  const t = await flowFinance();
  try {
    const untaxed = t.f.order(100);
    const ready = t.deliver('10');
    const pending = t.deliver('10', [untaxed]);
    t.sync();
    assert.equal(t.current(ready.id).status, 'ready');
    assert.equal(t.current(pending.id).status, 'info_pending');
    assert.equal(t.active('delivery', pending.id).length, 1, '资料待补先挂着暂估应收');
    assert.equal(
      t.active('delivery', pending.id)[0].description,
      '送货确认 ' + t.number(pending.id),
      '暂估往来的摘要用单据号，不用内部编号',
    );
    t.reverse(ready.id);
    t.reverse(pending.id);
    t.sync();
    for (const id of [ready.id, pending.id]) {
      const e = t.current(id);
      assert.equal(e.status, 'corrected', '撤销后直接已更正');
      assert.match(String(e.problem), /还没入过账/);
      assert.deepEqual(t.active('delivery', id), [], '没有留着的往来');
    }
    assert.equal(t.differences(), 0, '不进“有差异”');
    assert.equal(subledger(t.f.store, 'receivable'), 0);
    assert.equal(t.closingOk(), true, '结账的事件步骤放行');
    assert.equal(t.sync(), 0, '重复同步没有新动静');
  } finally {
    t.f.store.close();
  }
});

test('生成过凭证的送货单被撤销：草稿凭证、已记账凭证都照旧“有差异”，红冲重做后凭证和往来对得上', async () => {
  const t = await flowFinance();
  try {
    const draft = t.deliver('10');
    const posted = t.deliver('20');
    t.sync();
    t.book(posted.id, true);
    t.book(draft.id);
    const draftVoucher = Number(t.current(draft.id).voucher_id);
    const postedVoucher = Number(t.current(posted.id).voucher_id);
    t.reverse(draft.id);
    t.reverse(posted.id);
    t.sync();
    assert.equal(t.current(draft.id).status, 'difference', '草稿凭证也要人处理');
    assert.equal(t.current(posted.id).status, 'difference');
    assert.equal(t.closingOk(), false);
    t.correctAll(draft.id);
    t.correctAll(posted.id);
    assert.equal(t.current(draft.id).status, 'corrected');
    assert.equal(t.current(posted.id).status, 'corrected');
    const voucher = (id: number) => one(t.f.store.db, rows.fin_vouchers, 'SELECT * FROM fin_vouchers WHERE id=?', id);
    assert.equal(voucher(draftVoucher)?.status, 'void', '没记账的凭证作废');
    assert.equal(voucher(postedVoucher)?.status, 'posted', '已记账的原凭证不动');
    assert.ok(
      t.f.store.db.prepare("SELECT 1 FROM fin_vouchers WHERE reversal_of=? AND status='posted'").get(postedVoucher),
      '已记账的用红字凭证冲销',
    );
    assert.deepEqual(t.active('delivery', draft.id), []);
    assert.deepEqual(t.active('delivery', posted.id), []);
    // 处理完的说明写清做了什么，不再挂着“有差异”的那句
    assert.equal(t.current(draft.id).problem, '已作废没记账的原凭证，单据已撤销，不再重做。');
    assert.equal(t.current(posted.id).problem, '已红字冲销原凭证，单据已撤销，不再重做。');
    // 凭证的来源带单据号；红冲凭证指回原来那张单据
    const ledger = new FinanceLedger(t.f.store);
    const source = ledger.get(maker, postedVoucher).source;
    assert.ok(source && 'source_kind' in source, '原凭证的来源是业务单据');
    assert.deepEqual([source.source_kind, source.number], ['delivery', t.number(posted.id)]);
    const red = one(t.f.store.db, rows.fin_vouchers.pick({ id: true }), 'SELECT id FROM fin_vouchers WHERE reversal_of=?', postedVoucher);
    assert.ok(red, '有红字凭证');
    const redSource = ledger.get(maker, red.id).source;
    assert.ok(redSource && 'module' in redSource, '红字凭证的来源是财务功能');
    assert.equal(redSource.module, 'event_reversal');
    assert.equal(redSource.event?.number, t.number(posted.id));
    assert.equal(subledger(t.f.store, 'receivable'), 0);
    assert.equal(ledgerBalance(t.f.store, '1122', '2026-10'), 0, '应收总账也是 0');
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

test('暂估往来已被核销的送货单被撤销后，订单又换了客户（单据跟着改）：仍是同一条“待撤销核销”，撤销核销记账后自动已更正、放行', async () => {
  const { createBusinessService } = await import('../server/orders/index.js');
  const t = await flowFinance();
  try {
    const service = new FinanceSettlements(t.f.store);
    new FinanceCashAccounts(t.f.store).saveAccount(maker, { kind: 'bank', name: '虚构资金账户', accountCode: '1002', lastFour: '0001', requestId: 'bank' });
    const untaxed = t.f.order(100);
    const d = t.deliver('10', [untaxed]);
    t.sync();
    const [provisional] = t.active('delivery', d.id);
    const amount = Number(provisional.amount_cents);
    // 部分收款核销到这笔暂估应收
    const cashId = funds(t.f.store, service, { kind: 'receipt', date: '2026-10-28', amount: amount - 100 }, [
      { obligationId: Number(provisional.id), version: Number(provisional.version), amount: amount - 100 },
    ]);
    t.reverse(d.id);
    t.sync();
    const waiting = t.current(d.id);
    assert.equal(waiting.status, 'awaiting_allocation_reversal', '先撤销核销');
    assert.equal(t.closingOk(), false);
    // 本机管理员改订单换客户，已撤销的送货单跟着换（财务看的内容变了）：就地刷新那一条，不新建、不变成要人红冲的“有差异”
    const before = t.count();
    const other = businessBase(maker, t.f.store).customer({ name: '虚构换后客户' });
    const order = sales(t.f.store).order(untaxed.id);
    assert.ok(order, '订单还在');
    createBusinessService(t.f.store).execute(
      { entity: 'orders', action: 'update', id: order.id, input: { ...order, customerId: other.id } },
      { source: 'manual-ui', operatorId: t.admin.id, superAdminMode: true, actor: t.admin },
    );
    t.sync();
    const refreshed = t.current(d.id);
    assert.equal(t.count(), before, '没有多出事件');
    assert.equal(refreshed.id, waiting.id);
    assert.equal(refreshed.status, 'awaiting_allocation_reversal');
    assert.equal(readSnapshot(refreshed).doc?.customerId, other.id, '快照换成了新内容');
    assert.equal(t.closingOk(), false);
    // 撤销收款核销、红冲凭证记账：自动已更正，不用再点红字冲销
    const allocation = one(
      t.f.store.db,
      rows.fin_allocations.pick({ id: true, version: true }),
      'SELECT id,version FROM fin_allocations WHERE cash_id=?',
      cashId,
    );
    assert.ok(allocation, '收款核销到了这笔暂估');
    new FinanceAllocations(t.f.store).revoke(maker, allocation.id, {
      version: allocation.version,
      requestId: t.randomUUID(),
      date: '2026-10-28',
      reason: '虚构：核销错了',
    });
    postDrafts(t.f.store);
    assert.equal(t.current(d.id).status, 'corrected');
    assert.deepEqual(t.active('delivery', d.id), []);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});
