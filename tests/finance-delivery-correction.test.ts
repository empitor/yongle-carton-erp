// 更正送货单以后财务怎么接（server/flow/correction/correction.ts 写好 correctionOf、replacedBy、沿用 confirmedAt，财务代码不改）：
// 原单“已被更正替代”、替代单是一张更正单，红字冲销并重做；没入过账的原单直接已更正；已核销、已开票的照现有规则先处理。
// 走真实的单据流程和更正服务，内存库、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FinanceEventHandling } from '../server/finance/events/event-handling.js';
import { FinanceSettlements } from '../server/finance/cash/settlements.js';
import { FinanceCashAccounts } from '../server/finance/cash/cash-accounts.js';
import { maker, funds, confirmBlue, subledger, unbalancedVouchers } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

type Flow = Awaited<ReturnType<typeof flowFinance>>;
/** 红字冲销（并重做）这张单据名下“有差异”的那条，日期在开着的 10 月 */
const fix = (t: Flow, id: number) => {
  const e = t.current(id);
  return new FinanceEventHandling(t.f.store).correct(maker, Number(e.id), { version: Number(e.version), requestId: t.randomUUID(), date: '2026-10-28', reason: '虚构：更正送货单' });
};

test('已入账的送货单更正成 8 只：原单“已被更正替代”、替代单是更正单，各点一次以后账平、应收 8 元、结账放行；替代单再更正一次（三层链）照样', async () => {
  const t = await flowFinance();
  try {
    const d = t.deliver('10');
    t.sync();
    t.book(d.id, true);
    assert.equal(subledger(t.f.store, 'receivable'), 1000);
    const first = t.correct(d.id, { lines: [{ index: 0, quantity: '8' }] });
    assert.equal(first.confirmedAt, t.f.flow.get(d.id).confirmedAt, '替代单沿用原单的确认时间（收入确认口径）');
    t.sync();
    assert.equal(t.current(d.id).status, 'difference');
    assert.match(String(t.current(d.id).problem), /已被更正替代/);
    assert.equal(t.current(first.id).status, 'difference');
    assert.match(String(t.current(first.id).problem), /更正单/);
    assert.equal(t.closingOk(), false, '没处理完结账拦着（业务不受影响）');
    t.correctAll(d.id);
    t.correctAll(first.id);
    assert.deepEqual([t.current(d.id).status, t.current(first.id).status], ['corrected', 'generated']);
    assert.equal(subledger(t.f.store, 'receivable'), 800);
    assert.equal(unbalancedVouchers(t.f.store), 0);
    assert.equal(t.closingOk(), true);
    // 第三层：替代单再更正成 7 只
    const second = t.correct(first.id, { lines: [{ index: 0, quantity: '7' }] });
    t.sync();
    assert.match(String(t.current(first.id).problem), /已被更正替代/);
    t.correctAll(first.id);
    t.correctAll(second.id);
    assert.equal(t.current(second.id).status, 'generated');
    assert.equal(subledger(t.f.store, 'receivable'), 700);
    assert.equal(unbalancedVouchers(t.f.store), 0);
    assert.equal(t.closingOk(), true);
  } finally {
    t.f.store.close();
  }
});

test('还没入过账（订单没写税率，只挂着暂估）：原单直接已更正，替代单按新单挂暂估', async () => {
  const t = await flowFinance();
  try {
    const untaxed = t.f.order(100);
    const d = t.deliver('10', [untaxed]);
    t.sync();
    assert.equal(t.current(d.id).status, 'info_pending');
    const replacement = t.correct(d.id, { lines: [{ index: 0, quantity: '8' }] });
    t.sync();
    assert.equal(t.current(d.id).status, 'corrected');
    assert.equal(t.current(replacement.id).status, 'info_pending');
    assert.equal(t.differences(), 0);
  } finally {
    t.f.store.close();
  }
});

test('原单的应收已经收款核销、已经开了销项发票：业务更正照常（财务不卡业务），财务红冲时要先撤销核销、先红冲发票', async () => {
  for (const settled of ['核销', '发票'] as const) {
    const t = await flowFinance();
    try {
      const d = t.deliver('10');
      t.sync();
      t.book(d.id, true);
      const [owed] = t.active('delivery', d.id);
      if (settled === '核销') {
        new FinanceCashAccounts(t.f.store).saveAccount(maker, { kind: 'bank', name: '虚构资金账户', accountCode: '1002', lastFour: '0001', requestId: 'bank' });
        funds(t.f.store, new FinanceSettlements(t.f.store), { kind: 'receipt', date: '2026-10-28', amount: 1000 }, [{ obligationId: Number(owed.id), version: Number(owed.version), amount: 1000 }]);
      } else confirmBlue(t.f.store, { direction: 'sale', number: 'FICT-BLUE-CORRECTION', date: '2026-10-28' }, [{ obligationId: Number(owed.id), amount: 1000 }]);
      const replacement = t.correct(d.id, { lines: [{ index: 0, quantity: '8' }] });
      assert.equal(t.f.flow.get(replacement.id).status, 'confirmed', settled + '：业务更正照常');
      t.sync();
      assert.throws(() => fix(t, d.id), settled === '核销' ? /核销/ : /发票|红票/, settled);
    } finally {
      t.f.store.close();
    }
  }
});
