import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { recordContext } from '../server/business/record-context.js';
import { receiptEvents } from '../server/operations/fulfillment.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { legacyRecordContext } from './record-context-reference.js';
import { actor } from './assistant-fixture.js';

function fixture() {
  const store = new Store(':memory:'), ops = new OperationsService(store), flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构关联客户' }));
  const product = store.saveProduct(productSchema.parse({ name: '虚构关联产品' }));
  const supplier = ops.saveSupplier({ name: '虚构供应商甲' }, actor);
  const otherSupplier = ops.saveSupplier({ name: '虚构供应商乙' }, actor);
  const raw = ops.saveItem({ name: '虚构原料', kind: 'raw', unit: '张' }, actor);
  const finished = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: product.id }, actor);
  const orders = [1, 2].map((n) => store.saveOrder(orderSchema.parse({ number: '虚构关联单' + n,
    customerId: customer.id, orderDate: '2026-11-01', deliveryDate: '2026-11-30', status: '已确认',
    lines: [{ productId: product.id, quantity: 100, unit: '只', unitPriceCents: 100 }],
  })));
  const purchase = (supplierId: number, customerOrderId: number | null) => ops.savePurchase({
    supplierId, customerOrderId, orderDate: '2026-11-01', status: '已订货',
    lines: [{ stockItemId: raw.id, name: raw.name, unit: '张', quantity: '100', unitPrice: '1', priceBasis: 'quantity' }],
  }, actor);
  const purchases = [purchase(supplier.id, orders[0].id), purchase(supplier.id, null), purchase(otherSupplier.id, null)];
  const confirm = (kind: any, input: any) => {
    const d = flow.save(kind, { date: '2026-11-07', ...input }, actor);
    return flow.confirm(d.id, { previewId: flow.preview(d.id, actor, 's').previewId,
      requestId: randomUUID(), acknowledged: true }, actor, 's');
  };
  const arrival = confirm('arrival', { supplierId: supplier.id, reference: '虚构到货',
    lines: purchases.slice(0, 2).map((p) => ({ stockId: raw.id, purchaseLineId: p.lines[0].id,
      item: { name: raw.name, unit: '张' }, quantity: '10', unitPrice: '1', priceBasis: 'quantity' })),
  });
  const task = confirm('task', { productId: product.id, quantity: '100', unit: '只', orderIds: orders.map((o) => o.id) });
  const production = confirm('production', { taskId: task.id, productId: product.id,
    finishedStockId: finished.id, goodQuantity: '100', operator: '虚构员工', materials: [{ stockId: raw.id, issued: '1', returned: '0' }] });
  const delivery = confirm('delivery', { customerId: customer.id,
    lines: orders.map((o) => ({ orderId: o.id, orderLineId: o.lines[0].id, stockId: finished.id, quantity: '10' })) });
  return { store, ops, flow, customer, product, supplier, raw, finished, orders, purchases, arrival, task, production, delivery };
}

test('关联上下文：六类业务及四类实物单据与改造前完全一致，保留共享订单和顺序', () => {
  const f = fixture();
  try {
    const cases: [string, number][] = [
      ['customers', f.customer.id], ['products', f.product.id], ['orders', f.orders[0].id],
      ['purchases', f.purchases[0].id], ['suppliers', f.supplier.id], ['stock_items', f.raw.id],
      ['arrival', f.arrival.id], ['task', f.task.id], ['production', f.production.id], ['delivery', f.delivery.id],
    ];
    for (const [module, id] of cases) assert.deepEqual(recordContext(f.store, module, id, actor), legacyRecordContext(f.store, module, id, actor), module);
    f.store.db.prepare('INSERT INTO record_lifecycle VALUES(?,?,?,?)').run('flow_delivery', f.delivery.id, '虚构归档', actor.id);
    for (const [module, id] of cases) assert.deepEqual(recordContext(f.store, module, id, actor), legacyRecordContext(f.store, module, id, actor), '含归档：' + module);
  } finally { f.store.close(); }
});

test('关联上下文不调用全表视图；单条采购与供应商明细不解析其他采购', (t) => {
  const f = fixture();
  try {
    const expected = legacyRecordContext(f.store, 'orders', f.orders[0].id, actor);
    for (const method of ['orders', 'purchases', 'stock_items'] as const)
      t.mock.method(f.store, method, () => assert.fail('不应装配全表：' + method));
    assert.deepEqual(recordContext(f.store, 'orders', f.orders[0].id, actor), expected);
    const repo = new OperationsRepository(f.store);
    const purchase = repo.purchases(true, f.purchases[0].id)[0];
    const supplier = repo.suppliers(true, f.supplier.id)[0];
    // 模拟与本次读取无关的坏明细：定向读取不得解析它。
    f.store.db.prepare('UPDATE purchase_lines SET document=? WHERE purchase_id=?').run('not-json', f.purchases[2].id);
    assert.deepEqual(repo.purchases(true, f.purchases[0].id), [purchase]);
    assert.deepEqual(repo.suppliers(true, f.supplier.id), [supplier]);
    assert.deepEqual(repo.purchases(true, []), []);
    assert.deepEqual(repo.suppliers(true, []), []);
  } finally { f.store.close(); }
});

test('采购范围内到货仍保留跨采购单整单的 correctionLines', () => {
  const f = fixture();
  try {
    const all = receiptEvents(f.store);
    const scoped = receiptEvents(f.store, [f.purchases[0].id]);
    assert.deepEqual(scoped, all.filter((e) => e.purchaseId === f.purchases[0].id || e.lines.some((l) => l.purchaseId === f.purchases[0].id)));
    assert.equal(scoped[0].lines.length, 2);
    assert.equal(f.ops.repo.purchases(true, f.purchases[0].id)[0].receipts[0].correctionLines.length, 2);
  } finally { f.store.close(); }
});
