import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Store } from '../server/db.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';
import { actor, superActor } from './assistant-fixture.js';
import { legacyReceiptFixture } from './legacy-receipt-fixture.js';

const date = '2026-10-25';
function setup() {
  const store = new Store(':memory:'), ops = new OperationsService(store), flow = new FlowService(store);
  const raw = ops.saveItem({ name: '虚构原料', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' }, actor);
  const move = (action: 'in' | 'out', quantity: string) => ops.move(raw.id, {
    action, quantity, date, notes: '虚构库存变动', acknowledged: true,
    expectedVersion: ops.repo.items(true, raw.id)[0].version, requestId: randomUUID(),
  }, actor);
  const snapshot = () => Object.fromEntries([
    'stock_items', 'stock_movements', 'flow_documents', 'flow_refs', 'purchases', 'purchase_lines',
    'purchase_receipts', 'operation_requests', 'business_audit', 'orders', 'order_lines',
  ].map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const confirm = (doc: { id: number }) => {
    const p = flow.preview(doc.id, actor, 'coverage-session');
    return flow.confirm(doc.id, { previewId: p.previewId, requestId: randomUUID(), acknowledged: true }, actor, 'coverage-session');
  };
  return { store, ops, flow, raw, move, snapshot, confirm };
}

test('生产冲销拒绝无权和旧版本请求，第二笔流水失败时回滚，重试仅冲销一次', () => {
  const f = setup();
  try {
    f.move('in', '40');
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构成品箱型' }));
    const finished = f.ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: product.id }, actor);
    const task = f.confirm(f.flow.save('task', { date, productId: product.id, quantity: '30', unit: '只', orderIds: [] }, actor));
    const doc = f.confirm(f.flow.save('production', {
      date, productId: product.id, taskId: task.id, finishedStockId: finished.id,
      goodQuantity: '10', scrapQuantity: '0', operator: '虚构操作员',
      materials: [{ stockId: f.raw.id, issued: '15', returned: '2' }],
    }, actor));
    const input = { version: doc.version, acknowledged: true, reason: '虚构反向登记' };
    const before = f.snapshot();
    assert.throws(() => f.flow.reverse(doc.id, input, actor), /超级管理员/);
    assert.throws(() => f.flow.reverse(doc.id, { ...input, version: doc.version - 1 }, superActor()), /单据已变更/);
    f.store.db.exec(`CREATE TRIGGER fail_second_reversal BEFORE INSERT ON stock_movements
      WHEN NEW.source_kind='flow_reversal' AND EXISTS (
        SELECT 1 FROM stock_movements WHERE source_kind='flow_reversal' AND source_id=NEW.source_id
      ) BEGIN SELECT RAISE(ABORT, 'fictional second reversal failed'); END;`);
    assert.throws(() => f.flow.reverse(doc.id, input, superActor()), /fictional second reversal failed/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.flow.get(task.id).completed, '10');
    f.store.db.exec('DROP TRIGGER fail_second_reversal');

    const reversed = f.flow.reverse(doc.id, input, superActor());
    assert.equal(reversed.status, 'reversed');
    assert.equal(f.flow.get(task.id).completed, '0');
    assert.equal(f.ops.repo.balance(f.raw.id), 40_000);
    assert.equal(f.ops.repo.balance(finished.id), 0);
    assert.equal(reversed.reversal.movements.length, 2);
    const after = f.snapshot();
    assert.deepEqual(f.flow.reverse(doc.id, input, superActor()), reversed);
    assert.deepEqual(f.snapshot(), after);
  } finally {
    f.store.close();
  }
});

test('送货改期使旧确认失效，库存耗用后禁止确认，补足后同一请求只出库一次', () => {
  const f = setup();
  try {
    const customer = f.store.saveCustomer(customerSchema.parse({ name: '虚构收货方' }));
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构送货产品' }));
    const order = f.store.saveOrder(orderSchema.parse({
      customerId: customer.id, orderDate: date, deliveryDate: '2026-10-30', status: '已确认',
      lines: [{ productId: product.id, productName: product.name, quantity: 10, unit: '只', unitPriceCents: 100 }],
    }));
    const stock = f.ops.saveItem({ name: '虚构送货库存', kind: 'finished', unit: '只', productId: product.id }, actor);
    const move = (action: 'in' | 'out', quantity: string) => f.ops.move(stock.id, {
      action, quantity, date, acknowledged: true, notes: '虚构库存变动',
      requestId: randomUUID(), expectedVersion: f.ops.repo.items(true, stock.id)[0].version,
    }, actor);
    move('in', '10');
    const doc = f.flow.save('delivery', {
      date, customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '10' }],
    }, actor);
    const binding = 'delivery-coverage', requestId = randomUUID();
    const preview = () => f.flow.preview(doc.id, actor, binding);
    const confirm = (previewId: string) => f.flow.confirm(doc.id, { previewId, requestId, acknowledged: true }, actor, binding);
    const original = preview();
    f.flow.schedule(doc.id, { expectedVersion: doc.version, requestId: randomUUID(), plannedDate: '2026-10-29' }, actor);
    const scheduled = f.snapshot();
    assert.throws(() => confirm(original.previewId), /已变化/);
    assert.deepEqual(f.snapshot(), scheduled);
    const stale = preview();
    move('out', '1');
    const insufficient = f.snapshot();
    assert.throws(() => confirm(stale.previewId), /已变化/);
    assert.throws(preview, /库存不足/);
    assert.deepEqual(f.snapshot(), insufficient);
    assert.equal(f.store.order(order.id)?.lines[0].shippedQuantity, 0);

    move('in', '1');
    const valid = preview();
    const saved = confirm(valid.previewId);
    assert.equal(saved.status, 'confirmed');
    assert.equal(f.store.order(order.id)?.lines[0].shippedQuantity, 10);
    assert.equal(f.ops.repo.balance(stock.id), 0);
    const after = f.snapshot();
    assert.deepEqual(confirm(valid.previewId), saved);
    assert.deepEqual(f.snapshot(), after);
  } finally {
    f.store.close();
  }
});

test('旧到货更正验证超收和库存版本，替代入库后冲销失败时整批回滚', () => {
  const f = setup();
  try {
    const supplier = f.ops.saveSupplier({ name: '虚构供货方' }, actor);
    const purchase = f.ops.savePurchase({ supplierId: supplier.id, orderDate: date, status: '已订货', lines: [
      { ...f.raw, stockItemId: f.raw.id, quantity: '20', unitPrice: '1', priceBasis: 'quantity' },
    ] }, actor);
    const lineId = purchase.lines[0].id;
    const { receiptId } = legacyReceiptFixture(f.ops, purchase.id, {
      date, reference: '虚构旧批次', requestId: randomUUID(), acknowledged: true,
      expectedVersion: purchase.version, items: [{ lineId, quantity: '12' }],
    }, actor);
    const current = () => f.ops.repo.purchases(true, purchase.id)[0];
    const input = {
      mode: 'business', expectedVersion: 1, expectedPurchaseVersion: current().version,
      reason: '虚构数量更正', items: [{ index: 0, lineId, quantity: '9' }],
    };
    const preview = () => f.ops.previewReceiptCorrection(purchase.id, receiptId, input, actor);
    const requestId = randomUUID();
    const correct = (previewDigest: string) => f.ops.correctReceipt(purchase.id, receiptId, { ...input, requestId, previewDigest }, actor);
    const start = f.snapshot();
    assert.throws(() => f.ops.previewReceiptCorrection(purchase.id, receiptId, {
      ...input, items: [{ index: 0, lineId, quantity: '21' }],
    }, actor), /超过采购订购数量/);
    assert.throws(() => f.ops.previewReceiptCorrection(purchase.id, receiptId, input, { ...actor, permissions: [] }), /权限/);
    assert.deepEqual(f.snapshot(), start);

    const stale = preview().previewDigest;
    f.move('out', '2');
    const before = f.snapshot();
    assert.throws(() => correct(stale), /已变化/);
    assert.deepEqual(f.snapshot(), before);
    const fresh = preview().previewDigest;
    f.store.db.exec(`CREATE TRIGGER fail_receipt_reversal BEFORE INSERT ON stock_movements
      WHEN NEW.source_kind='purchase_receipt_reversal'
      BEGIN SELECT RAISE(ABORT, 'fictional receipt reversal failed'); END;`);
    assert.throws(() => correct(fresh), /fictional receipt reversal failed/);
    assert.deepEqual(f.snapshot(), before);
    f.store.db.exec('DROP TRIGGER fail_receipt_reversal');

    const corrected = correct(fresh);
    assert.equal(corrected.verified, true);
    assert.equal(current().lines[0].receivedQuantity, '9');
    assert.equal(f.ops.repo.balance(f.raw.id), 7000);
    assert.equal(corrected.movements.replacement.length, 1);
    assert.equal(corrected.movements.reversal.length, 1);
    const after = f.snapshot();
    assert.deepEqual(correct(fresh), { ...corrected, replayed: true });
    assert.deepEqual(f.snapshot(), after);
  } finally {
    f.store.close();
  }
});
