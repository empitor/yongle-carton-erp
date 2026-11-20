// 业务单据同步进财务：幂等、待补资料、收入确认口径、来源删除（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents, unseenSources } from '../server/finance/events.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceEventViews } from '../server/finance/event-views.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { maker, newSettings, physical, deliveryDoc, arrivalDoc, event } from './finance-fixture.js';
import { readSnapshot } from '../server/finance/source-snapshot.js';

test('同步幂等，缺价缺税待补，补齐后制单，来源删除保留历史', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store);
    const events = new FinanceEvents(store),
      ledger = new FinanceLedger(store);
    const line = { quantity: '1', unit: '个', unitPriceExact: '0.0150', taxMode: '未税', taxRate: '0%' };
    const doc = (lines: Record<string, unknown>[]) => ({ customerId: 1, customerName: '虚构客户', lines });
    physical(store, 1, 'delivery', '2026-01-20', doc([line, line, line]));
    physical(store, 2, 'delivery', '2026-01-20', doc([{ ...line, unitPriceExact: undefined }]));
    physical(store, 3, 'delivery', '2026-01-20', doc([{ ...line, taxMode: '未明确', taxRate: '' }]));
    physical(store, 4, 'arrival', '2026-01-20', {
      supplierId: 1,
      supplierName: '虚构供应商',
      lines: [{ item: { name: '虚构纸板', unit: '张' }, quantity: '1', unitPrice: '10', priceBasis: 'quantity' }],
    });
    assert.deepEqual(events.sync(maker, { requestId: 'first' }), { processed: 4, remaining: false });
    assert.deepEqual(events.sync(maker, { requestId: 'second' }), { processed: 0, remaining: false });
    const rows = new FinanceEventViews(store).list(maker, {}).rows;
    const bySource = (id: string) => {
      const row = rows.find((r) => r.source_id === id);
      assert.ok(row, '单据 ' + id + ' 有财务事件');
      return row;
    };
    assert.equal(bySource('1').amount_cents, 5);
    assert.match(String(bySource('2').problem), /缺少送货价格/);
    assert.equal(bySource('3').status, 'info_pending');
    assert.equal(bySource('4').status, 'info_pending');
    assert.equal(bySource('3').amount_cents, 2);
    assert.equal(
      new FinanceParties(store).obligations(maker, { kind: 'receivable' }).rows[0].tax_status,
      'pending',
    );
    assert.throws(
      () => new FinanceEventVouchers(store).generate(maker, bySource('2').id, { version: 1, requestId: 'blocked' }),
      /不能制单/,
    );
    assert.equal(ledger.list(maker, {}).filteredRecords, 0);
    const ready = new FinanceEventHandling(store).resolve(maker, bySource('3').id, {
      version: 1,
      requestId: 'resolve',
      evidence: '虚构合同明确税率',
      lines: [{ exact: '1.5000', mode: '未税', rate: '13%' }],
    });
    assert.equal(ready.amount_cents, 170);
    const parties = new FinanceParties(store);
    parties.saveTerms(maker, { kind: 'customer', partyId: 1, termDays: 30, requestId: 'terms' });
    const generated = new FinanceEventVouchers(store).generate(maker, bySource('1').id, {
      version: 1,
      requestId: 'generate',
    });
    const voucherId = generated.voucher_id;
    assert.ok(voucherId);
    assert.equal(
      parties
        .obligations(maker, { kind: 'receivable' })
        .rows.find((o) => o.event_id === bySource('1').id)?.due_date,
      '2026-02-19',
    );
    ledger.transition(maker, voucherId, 'submit', { version: 1, requestId: 'submit' });
    const approver = { ...maker, id: 'approver' };
    ledger.transition(approver, voucherId, 'approve', { version: 2, requestId: 'approve' });
    ledger.transition(approver, voucherId, 'post', { version: 3, requestId: 'post' });
    const original = ledger.get(maker, voucherId);
    store.db.prepare("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1").run();
    store.db.prepare("UPDATE flow_documents SET status='reversed',version=2 WHERE id=4").run();
    assert.equal(events.sync(maker, { requestId: 'reversal' }).processed, 2);
    assert.deepEqual(
      new Set(new FinanceEventViews(store).list(maker, { status: 'difference' }).rows.map((row) => row.event_type)),
      new Set(['delivery.reversed']),
    );
    store.db.prepare('DELETE FROM flow_documents WHERE id=1').run();
    assert.equal(events.sync(maker, { requestId: 'delete' }).processed, 1);
    assert.equal(new FinanceEventViews(store).list(maker, { status: 'source_deleted' }).rows[0].source_id, '1');
    assert.deepEqual(ledger.get(maker, voucherId), original);
  } finally {
    store.close();
  }
});

test('正式报表的资料检查和结账同一个口径：还没同步进财务的单据（新确认的、已撤销的）一样拦，同步后放行', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store);
    const events = new FinanceEvents(store),
      reports = new FinanceReports(store);
    const readiness = () => reports.readiness(maker, { period: '2026-01' });
    physical(store, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    assert.deepEqual([readiness().ready, readiness().unsynced], [false, 1], '资料齐全、还没同步的也拦');
    events.sync(maker, { requestId: 'scan' });
    assert.deepEqual([readiness().ready, readiness().unsynced], [true, 0]);
    store.db.prepare("UPDATE flow_documents SET version=version+1,status='reversed' WHERE id=1").run();
    assert.deepEqual([readiness().ready, readiness().unsynced], [false, unseenSources(store.db, '2026-01-31')], '撤销了还没同步');
    assert.throws(() => reports.assertReady(maker, '2026-01'), /还没同步进财务/);
  } finally {
    store.close();
  }
});

test('结账检查：只是有单据还没同步时，只有“业务单据”一步拦着，“资产负债表平衡”照常算', () => {
  const store = new Store(':memory:');
  try {
    newSettings(store);
    physical(store, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    const steps = new FinanceClosing(store).check(maker, { period: '2026-01' }).steps;
    const step = (key: string) => steps.find((s) => s.key === key)?.ok;
    assert.deepEqual([step('events'), step('balance')], [false, true]);
  } finally {
    store.close();
  }
});

test('收入确认口径按财务设置的变更历史判，不读审计：审计清空后判断不变，口径改来改去各按确认当时的算', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const settings = new FinanceSettings(s),
      events = new FinanceEvents(s);
    settings.update(maker, { version: 3, requestId: 'to-invoice', revenueRecognition: 'invoice' });
    settings.update(maker, { version: 4, requestId: 'to-delivery', revenueRecognition: 'delivery' });
    // 把变更时间写定（虚构）：1 月 15 日改成开票确认，1 月 20 日改回送货确认；之前的两次保存都在 1 月 1 日
    const history = s.db.prepare('SELECT id,revenue_recognition FROM fin_settings_history ORDER BY id').all();
    assert.deepEqual(
      history.map((r) => r.revenue_recognition),
      ['delivery', 'delivery', 'invoice', 'delivery'],
    );
    const at = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2026-01-15T00:00:00.000Z', '2026-01-20T00:00:00.000Z'];
    history.forEach((r, i) => s.db.prepare('UPDATE fin_settings_history SET changed_at=? WHERE id=?').run(at[i], r.id));
    // 审计全部清空（只在测试里这样做）：口径判断不能受影响
    s.db.exec('DELETE FROM business_audit');
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('1'));
    physical(s, 2, 'delivery', '2026-01-16', deliveryDoc('1'));
    physical(s, 3, 'delivery', '2026-01-21', deliveryDoc('1'));
    assert.deepEqual(
      new FinanceEventViews(s).unsynced(maker, '2026-01').map((r) => [r.source_id, r.status]),
      [['1', 'ready'], ['2', 'waiting_invoice'], ['3', 'ready']],
      '还没同步的单据也按确认当时的口径估',
    );
    events.sync(maker, { requestId: 'scan' });
    assert.deepEqual(
      [1, 2, 3].map((id) => [event(s, id).revenue_recognition, event(s, id).status]),
      [['delivery', 'ready'], ['invoice', 'waiting_invoice'], ['delivery', 'ready']],
    );
    // 历史一行都没有的库（从没改过设置）按送货确认
    s.db.exec('DELETE FROM fin_settings_history');
    physical(s, 4, 'delivery', '2026-01-17', deliveryDoc('1'));
    events.sync(maker, { requestId: 'rescan' });
    assert.equal(event(s, 4).status, 'ready');
  } finally {
    s.close();
  }
});

test('到货行没记入库数量：转资料待补，不拿实收数量顶替', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    const doc = arrivalDoc('10');
    delete (doc.lines[0] as { stockedQuantity?: string }).stockedQuantity;
    physical(s, 1, 'arrival', '2026-01-07', doc);
    events.sync(maker, { requestId: 'scan' });
    const pending = event(s, 1);
    assert.equal(pending.status, 'info_pending');
    assert.match(String(pending.problem), /入库数量/);
    assert.deepEqual(readSnapshot(pending).missing, ['quantity']);
    assert.equal(pending.amount_cents, null, '没有金额，不进账');
  } finally {
    s.close();
  }
});
