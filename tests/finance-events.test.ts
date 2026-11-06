import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/db.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { deliveryLineExact, documentMoney } from '../server/finance/amounts.js';
import { financePermissions } from '../shared/finance.js';

const maker = { id: 'maker', name: '虚构财务', permissions: [...financePermissions] };
const date = '2026-01-20',
  at = date + 'T08:00:00.000Z';
const line = {
  quantity: '1',
  unit: '个',
  unitPriceExact: '0.0150',
  taxMode: '未税',
  taxRate: '0%',
};

test('四位小数单价先整单取整，用最大余数分配，税额与价税合计相等', () => {
  const exact = deliveryLineExact('1.500', '0.0150');
  assert.equal(exact, '0.0225000');
  const money = documentMoney(Array(3).fill({ exact: '0.0150', mode: '未税', rate: '0%' }));
  assert.equal(money.gross, 5);
  assert.deepEqual(
    money.lines.map((entry) => entry.gross),
    [2, 2, 1],
  );
  const included = documentMoney([{ exact: '113.0000', mode: '含税', rate: '13%' }]);
  assert.deepEqual([included.net, included.tax, included.gross], [10000, 1300, 11300]);
  assert.throws(() => documentMoney([{ exact: '100.00', mode: '含税', rate: '' }]), /缺少税率/);
});

test('同步幂等，缺价缺税待补，补齐后制单，到货统计更正及来源删除保留历史', () => {
  const store = new Store(':memory:');
  try {
    const events = new FinanceEvents(store),
      ledger = new FinanceLedger(store);
    new FinanceSettings(store).enable(maker, {
      requestId: 'enable',
      version: 1,
      period: '2026-01',
      taxpayer: 'general',
      rows: [],
    });
    store.db
      .prepare(
        `INSERT INTO customers(id,name,contact,phone,address,notes,created_at)
      VALUES(1,'虚构客户','','','','',?)`,
      )
      .run(at);
    const add = store.db.prepare(`INSERT INTO flow_documents
      (id,kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES(?,?,?,?,'confirmed',?,?,?,?,?)`);
    const doc = {
      customerId: 1,
      customerName: '虚构客户',
      confirmedAt: at,
      lines: [line, line, line],
    };
    add.run(1, 'delivery', 'DEL-1', date, JSON.stringify(doc), maker.id, maker.name, at, at);
    add.run(
      2,
      'delivery',
      'DEL-2',
      date,
      JSON.stringify({ ...doc, lines: [{ ...line, unitPriceExact: undefined }] }),
      maker.id,
      maker.name,
      at,
      at,
    );
    add.run(
      3,
      'delivery',
      'DEL-3',
      date,
      JSON.stringify({ ...doc, lines: [{ ...line, taxMode: '未明确', taxRate: '' }] }),
      maker.id,
      maker.name,
      at,
      at,
    );
    add.run(
      4,
      'arrival',
      'ARR-4',
      date,
      JSON.stringify({
        supplierId: 1,
        supplierName: '虚构供应商',
        lines: [{ item: { unit: '张' }, quantity: '1', unitPrice: '10', priceBasis: 'quantity' }],
      }),
      maker.id,
      maker.name,
      at,
      at,
    );
    assert.deepEqual(events.sync(maker, { requestId: 'first' }), {
      processed: 4,
      remaining: false,
    });
    assert.deepEqual(events.sync(maker, { requestId: 'second' }), {
      processed: 0,
      remaining: false,
    });
    const rows = events.list(maker, {}).rows,
      bySource = (id: string) => rows.find((row) => row.source_id === id)!;
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
      () => events.generate(maker, bySource('2').id, { version: 1, requestId: 'blocked' }),
      /不能制单/,
    );
    assert.equal(ledger.list(maker, {}).filteredRecords, 0);
    const ready = events.resolve(maker, bySource('3').id, {
      version: 1,
      requestId: 'resolve',
      evidence: '虚构合同明确税率',
      lines: [{ exact: '1.5000', mode: '未税', rate: '13%' }],
    });
    assert.equal(ready.amount_cents, 170);
    const parties = new FinanceParties(store);
    parties.saveTerms(maker, { kind: 'customer', partyId: 1, termDays: 30, requestId: 'terms' });
    const generated = events.generate(maker, bySource('1').id, {
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
    store.db
      .prepare(
        `INSERT INTO business_audit(at,actor_id,actor_name,source,action,entity,record_id,document)
      VALUES(?,?,?,'administrator-data-edit','receipt-data-edit','purchases',1,?)`,
      )
      .run(
        at,
        maker.id,
        maker.name,
        JSON.stringify({ receiptId: 'flow-4', before: [], after: [] }),
      );
    assert.equal(events.sync(maker, { requestId: 'reversal' }).processed, 3);
    assert.deepEqual(
      new Set(events.list(maker, { status: 'difference' }).rows.map((row) => row.event_type)),
      new Set(['arrival.corrected', 'delivery.reversed']),
    );
    store.db.prepare('DELETE FROM flow_documents WHERE id=1').run();
    assert.equal(events.sync(maker, { requestId: 'delete' }).processed, 1);
    assert.equal(events.list(maker, { status: 'source_deleted' }).rows[0].source_id, '1');
    assert.deepEqual(ledger.get(maker, voucherId), original);
  } finally {
    store.close();
  }
});
