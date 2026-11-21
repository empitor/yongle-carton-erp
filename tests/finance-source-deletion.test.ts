// 业务单据、库存流水被物理删除后财务事件怎么记，结账卡不卡（全部是虚构数据，只用内存库）
// 加载单据流转模块：建库存品要用它登记的读法
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { one, rows } from '../server/core/index.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/index.js';
import { FinanceAllocations } from '../server/finance/allocations.js';
import { FinanceMargin } from '../server/finance/margin.js';
import { maker, newSettings, physical, deliveryDoc, postDrafts, reverseSource, eventsStep, ledgerBalance, subledger, obligation, funds, confirmBlue, confirmRed, unbalancedVouchers } from './finance-fixture.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { businessChanges } from './business-changes-fixture.js';

/** 财务从 2026-01 启用；删掉单据后同步一次，返回这张单据最后那条事件 */
function books() {
  const s = new Store(':memory:');
  const cash = newSettings(s);
  const events = new FinanceEvents(s);
  const sync = () => events.sync(maker);
  const latest = (sourceId: unknown) => {
    const row = one(s.db, rows.fin_events, 'SELECT * FROM fin_events WHERE source_id=? ORDER BY id DESC LIMIT 1', String(sourceId));
    if (!row) throw new Error('测试数据：来源 ' + String(sourceId) + ' 没有财务事件');
    return row;
  };
  const remove = (id: number) => {
    businessChanges(s).remove(id);
    sync();
    return latest(id);
  };
  const book = (id: number) => {
    const e = latest(id);
    new FinanceEventVouchers(s).generate(maker, e.id, { version: Number(e.version), requestId: randomUUID() });
    postDrafts(s);
  };
  /** 资料待补（没写税率）的送货单：同步后挂着暂估应收，返回那笔往来 */
  const provisional = (id: number) => {
    physical(s, id, 'delivery', '2026-01-20', deliveryDoc('1', { taxed: false }));
    sync();
    return obligation(s, id);
  };
  return { s, cash, sync, latest, remove, book, provisional };
}

test('处理完的送货单被删除：事件仍是已更正，不卡结账，重复同步没有新动静', () => {
  const t = books();
  try {
    physical(t.s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    t.sync();
    t.book(1);
    reverseSource(t.s, 1, '2026-01-25');
    postDrafts(t.s);
    const e = t.remove(1);
    assert.equal(e.status, 'corrected');
    assert.equal(eventsStep(t.s).ok, true);
    assert.equal(eventsStep(t.s, '2026-02').ok, true);
    assert.equal(t.sync().processed, 0, '删除只处理一次');
  } finally {
    t.s.close();
  }
});

test('还没入过账的送货单被删除：系统挂的暂估往来作废，直接已更正，不卡结账', () => {
  const t = books();
  try {
    physical(t.s, 1, 'delivery', '2026-01-20', { customerId: 1, customerName: '虚构客户', lines: [{ unit: '个', quantity: '1', unitPriceExact: '100.0000' }] });
    t.sync();
    assert.equal(t.latest(1).status, 'info_pending');
    assert.equal(subledger(t.s, 'receivable'), 10000, '资料待补先挂暂估应收');
    const e = t.remove(1);
    assert.equal(e.status, 'corrected');
    assert.match(String(e.problem), /还没入过账/);
    assert.equal(subledger(t.s, 'receivable'), 0);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});

test('已记账的送货单被删除：记“来源已删除”卡结账，红字冲销后应收往来和总账都是 0、放行', () => {
  const t = books();
  try {
    physical(t.s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    t.sync();
    t.book(1);
    const e = t.remove(1);
    assert.equal(e.status, 'source_deleted');
    assert.equal(eventsStep(t.s).ok, false);
    const done = new FinanceEventHandling(t.s).correct(maker, e.id, {
      version: Number(e.version),
      requestId: randomUUID(),
      date: '2026-01-31',
      reason: '虚构：单据录错已删',
    });
    postDrafts(t.s);
    assert.equal(done.status, 'corrected');
    assert.equal(subledger(t.s, 'receivable'), 0);
    assert.equal(ledgerBalance(t.s, '1122'), 0);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});

test('已记账的送货单被删除后核对无误、保留凭证：凭证和应收不动，不卡结账', () => {
  const t = books();
  try {
    physical(t.s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    t.sync();
    t.book(1);
    const voucherId = Number(t.latest(1).voucher_id);
    const voucher = () => {
      const { header, entries } = new FinanceLedger(t.s).get(maker, voucherId);
      return { header, entries };
    };
    const original = voucher();
    const e = t.remove(1);
    const kept = new FinanceEventHandling(t.s).acknowledgeStatisticalCorrection(maker, e.id, {
      version: Number(e.version),
      requestId: randomUUID(),
      reason: '虚构：货确实发了，删单时保留了库存流水',
    });
    assert.equal(kept.status, 'corrected');
    assert.deepEqual(voucher(), original, '原凭证一个字没动');
    assert.equal(subledger(t.s, 'receivable'), ledgerBalance(t.s, '1122'));
    assert.equal(ledgerBalance(t.s, '1122'), 10000);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});

test('盘点流水被删除：核对前、核对后都直接已更正，不卡结账', () => {
  const t = books();
  try {
    const ops = new OperationsService(t.s),
      flow = new FlowService(t.s);
    const item = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, maker);
    const move = (action: 'in' | 'adjust', quantity: string) =>
      flow.stock.move(
        item.id,
        {
          action,
          quantity,
          date: '2026-01-20',
          notes: '虚构盘点',
          expectedVersion: Number(t.s.db.prepare('SELECT version FROM stock_items WHERE id=?').get(item.id)?.version),
          acknowledged: true,
          requestId: randomUUID(),
        },
        maker,
      ).movementId;
    move('in', '10');
    const pending = move('adjust', '7');
    const checked = move('adjust', '6');
    t.sync();
    const e = t.latest(checked);
    new FinanceEventHandling(t.s).acknowledgeStatisticalCorrection(maker, e.id, {
      version: Number(e.version),
      requestId: randomUUID(),
      reason: '虚构：核对过',
    });
    businessChanges(t.s, maker).removeMovements([pending, checked]);
    t.sync();
    for (const id of [pending, checked]) assert.equal(t.latest(id).status, 'corrected');
    assert.match(String(t.latest(pending).problem), /月末成本计算/);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});

/** 撤销这笔往来上唯一的那条收款核销，并把撤销凭证记账 */
function revokeAllocation(t: ReturnType<typeof books>, cashId: number) {
  const a = t.s.db.prepare('SELECT id,version FROM fin_allocations WHERE cash_id=?').get(cashId);
  new FinanceAllocations(t.s).revoke(maker, Number(a?.id), {
    version: Number(a?.version),
    requestId: randomUUID(),
    date: '2026-01-25',
    reason: '虚构：核销错了',
  });
  postDrafts(t.s);
}

test('暂估应收被收款核销后删单：没有凭证可保留，“保留凭证”被拒；撤销核销后红字冲销，往来、总账都是 0', () => {
  const t = books();
  try {
    const o = t.provisional(1);
    const cashId = funds(t.s, t.cash, { kind: 'receipt', date: '2026-01-22', amount: 10000 }, [
      { obligationId: Number(o.id), version: Number(o.version), amount: 10000 },
    ]);
    const e = t.remove(1);
    assert.equal(e.status, 'source_deleted');
    assert.match(String(e.problem), /先撤销核销或红冲发票/);
    const handling = new FinanceEventHandling(t.s);
    assert.throws(
      () => handling.acknowledgeStatisticalCorrection(maker, e.id, { version: Number(e.version), requestId: randomUUID(), reason: '虚构' }),
      /没有还算数的凭证可保留/,
    );
    revokeAllocation(t, cashId);
    const current = t.latest(1);
    handling.correct(maker, current.id, { version: Number(current.version), requestId: randomUUID(), date: '2026-01-31', reason: '虚构：删错' });
    postDrafts(t.s);
    assert.equal(t.latest(1).status, 'corrected');
    assert.deepEqual([subledger(t.s, 'receivable'), ledgerBalance(t.s, '1122'), unbalancedVouchers(t.s)], [0, 0, 0]);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});

test('暂估应收关联了已确认的发票后删单：没有凭证可保留，“保留凭证”被拒', () => {
  const t = books();
  try {
    const o = t.provisional(1);
    confirmBlue(t.s, { direction: 'sale', number: 'XS-1', date: '2026-01-21' }, [{ obligationId: Number(o.id), amount: 10000 }]);
    const e = t.remove(1);
    assert.equal(e.status, 'source_deleted');
    assert.throws(
      () =>
        new FinanceEventHandling(t.s).acknowledgeStatisticalCorrection(maker, e.id, {
          version: Number(e.version),
          requestId: randomUUID(),
          reason: '虚构',
        }),
      /没有还算数的凭证可保留/,
    );
  } finally {
    t.s.close();
  }
});

test('收款核销撤销并记账以后才删单：名下已经没钱，直接已更正，不卡结账', () => {
  const t = books();
  try {
    const o = t.provisional(1);
    const cashId = funds(t.s, t.cash, { kind: 'receipt', date: '2026-01-22', amount: 10000 }, [
      { obligationId: Number(o.id), version: Number(o.version), amount: 10000 },
    ]);
    revokeAllocation(t, cashId);
    const e = t.remove(1);
    assert.equal(e.status, 'corrected');
    assert.deepEqual([subledger(t.s, 'receivable'), ledgerBalance(t.s, '1122'), unbalancedVouchers(t.s)], [0, 0, 0]);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});

test('已记账的送货单删了、核对后保留凭证：毛利照样算这张的收入，和总账收入一致', () => {
  const t = books();
  try {
    physical(t.s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    t.sync();
    t.book(1);
    const e = t.remove(1);
    new FinanceEventHandling(t.s).acknowledgeStatisticalCorrection(maker, e.id, {
      version: Number(e.version),
      requestId: randomUUID(),
      reason: '虚构：货确实发了',
    });
    const margin = new FinanceMargin(t.s).get(maker, { period: '2026-01', group: 'customer' }).rows;
    assert.equal(margin.reduce((n, r) => n + Number(r.revenue), 0), 10000);
    assert.equal(-ledgerBalance(t.s, '5001'), 10000, '主营业务收入');
  } finally {
    t.s.close();
  }
});

test('开票确认收入、整张红票冲平后删单：没有还算数的凭证可保留，毛利不算它，红字冲销后放行', () => {
  const t = books();
  try {
    new FinanceSettings(t.s).update(maker, { version: 3, requestId: 'invoice-policy', revenueRecognition: 'invoice' });
    // 口径改动的时间写定在单据确认之前（虚构），送货按开票确认收入
    t.s.db.prepare("UPDATE fin_settings_history SET changed_at='2026-01-01T00:00:00.000Z'").run();
    physical(t.s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    t.sync();
    const o = obligation(t.s, 1);
    const blue = confirmBlue(t.s, { direction: 'sale', number: 'XS-1', date: '2026-01-21' }, [{ obligationId: Number(o.id), amount: 10000 }]);
    confirmRed(t.s, { direction: 'sale', number: 'XS-1-RED', date: '2026-01-22' }, blue.id, 10000);
    const e = t.remove(1);
    assert.equal(e.status, 'source_deleted');
    const handling = new FinanceEventHandling(t.s);
    assert.throws(
      () => handling.acknowledgeStatisticalCorrection(maker, e.id, { version: Number(e.version), requestId: randomUUID(), reason: '虚构' }),
      /没有还算数的凭证可保留/,
    );
    const margin = new FinanceMargin(t.s).get(maker, { period: '2026-01', group: 'customer' }).rows;
    assert.equal(margin.reduce((n, r) => n + Number(r.revenue), 0), 0);
    handling.correct(maker, e.id, { version: Number(e.version), requestId: randomUUID(), date: '2026-01-31', reason: '虚构：删错' });
    postDrafts(t.s);
    assert.deepEqual([subledger(t.s, 'receivable'), ledgerBalance(t.s, '1122'), ledgerBalance(t.s, '5001'), unbalancedVouchers(t.s)], [0, 0, 0, 0]);
    assert.equal(eventsStep(t.s).ok, true);
  } finally {
    t.s.close();
  }
});
