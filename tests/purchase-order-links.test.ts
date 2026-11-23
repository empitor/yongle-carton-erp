import { sales } from '../server/sales/index.js';
import { trackedOrder, trackOrders } from '../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OrderBatchService, purchaseOrderLinks, stockLedger } from '../server/operations/index.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { relatedBusiness } from '../server/overview/related-business.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
// 删订单要识别导入配合（给导入记录打标记），加载时登记
import '../server/import/index.js';
import { registerArrival } from '../server/flow/index.js';
import { one, parseStoredJson, rows } from '../server/core/index.js';
import { purchaseLineDocumentSchema } from '../shared/business/index.js';
import { actor, superActor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';

/** 两张虚构订单、一种纸板；采购单不挂单头订单，两行各给一张订单订料。 */
function setup() {
  const base = businessBase(actor),
    { store, ops, flow } = base;
  const customer = base.customer({ name: '虚构东海电器有限公司' });
  const product = base.product({ name: '虚构电饭煲外箱', material: 'K=A', flute: 'BC' });
  const order = (deliveryDate: string) =>
    base.order(customer, [base.line(product, 500, { productName: product.name, notes: '' })], {
      orderDate: '2026-11-01',
      deliveryDate,
      notes: '',
      costs: null,
    });
  const a = order('2026-11-20'),
    b = order('2026-11-25');
  const supplier = base.supplier({ name: '虚构春芳纸板厂', contact: '', phone: '', address: '' });
  const item = base.raw({ name: '虚构纸板A', length: 1000, width: 800, dimensionUnit: 'mm', material: 'K=A', flute: 'BC' });
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: null,
      orderDate: '2026-11-02',
      expectedDate: null,
      status: '待订货',
      notes: '',
      lines: [
        { ...item, stockItemId: item.id, customerOrderId: a.id, quantity: '300', unitPrice: '1.2', priceBasis: 'quantity' },
        { ...item, stockItemId: item.id, customerOrderId: b.id, quantity: '200', unitPrice: '1.2', priceBasis: 'quantity' },
      ],
    },
    actor,
  );
  return { store, ops, flow, a, b, supplier, item, purchase };
}

/** 库里存的样子：每行的订单外键列，和 JSON 里有没有 customerOrderId 这个键（应该一直没有） */
const storedLinks = (store: Store, purchaseId: number) =>
  store.db
    .prepare("SELECT customer_order_id AS orderId,json_type(document,'$.customerOrderId') AS inJson FROM purchase_lines WHERE purchase_id=? ORDER BY id")
    .all(purchaseId)
    .map((r) => [r.orderId === null ? null : Number(r.orderId), r.inJson]);

test('一张采购单可以给几张订单订料：明细各自关联订单，两张订单都看得到这张采购', () => {
  const f = setup();
  assert.deepEqual(f.purchase.orderIds.sort(), [f.a.id, f.b.id].sort());
  assert.deepEqual(
    f.purchase.customerOrders.map((o) => o.number).sort(),
    [f.a.number, f.b.number].sort(),
  );
  assert.deepEqual(
    f.purchase.lines.map((l) => l.customerOrderNumber),
    [f.a.number, f.b.number],
  );
  for (const order of [f.a, f.b]) {
    assert.equal(trackedOrder(f.store, order.id, true)?.materialProgress, 'pending', '订料进度按每行关联的订单算');
    const related = relatedBusiness(f.store, 'orders', order.id);
    assert.deepEqual(related?.purchases.map((p) => p.id), [f.purchase.id]);
  }
  const fromPurchase = relatedBusiness(f.store, 'purchases', f.purchase.id);
  assert.deepEqual(fromPurchase?.orders.map((o) => o.id).sort(), [f.a.id, f.b.id].sort());
  // 关联的订单只存在 customer_order_id 列里，JSON 里不重复存；读出来的对象形状不变
  assert.deepEqual(storedLinks(f.store, f.purchase.id), [[f.a.id, null], [f.b.id, null]]);
  assert.deepEqual(f.purchase.lines.map((l) => l.customerOrderId), [f.a.id, f.b.id]);
  // 订料进度：按一张订单、按几张订单、全部订单三种读法结果一样
  assert.deepEqual(trackOrders(f.store, sales(f.store).ordersByIds([f.a.id, f.b.id], true)).map((o) => o.materialProgress), ['pending', 'pending']);
  assert.deepEqual(trackOrders(f.store, sales(f.store).orders(true)).map((o) => o.materialProgress), ['pending', 'pending']);
});

test('采购明细关联的订单是真外键列：JSON 里再存一份、指向不存在的订单都被数据库拒绝；按订单找采购用得上索引', () => {
  const f = setup();
  const db = f.store.db,
    line = f.purchase.lines[0];
  assert.throws(
    () => db.prepare("UPDATE purchase_lines SET document=json_set(document,'$.customerOrderId',?) WHERE id=?").run(f.b.id, line.id),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("UPDATE purchase_lines SET document=json_set(document,'$.customerOrderId',json('null')) WHERE id=?").run(line.id),
    /CHECK constraint failed/,
    'JSON 里写成 null 也不行',
  );
  assert.throws(() => db.prepare("UPDATE purchase_lines SET document='[]' WHERE id=?").run(line.id), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE purchase_lines SET customer_order_id=? WHERE id=?').run(999, line.id), /FOREIGN KEY constraint failed/);
  // 库存品改了规格去对齐明细内容时，传进来的对象带着 customerOrderId 也不会写进 JSON，列不动
  const stored = one(db, rows.purchase_lines.pick({ document: true }), 'SELECT document FROM purchase_lines WHERE id=?', line.id);
  assert.ok(stored, '采购明细在库里');
  const document = parseStoredJson(purchaseLineDocumentSchema, stored.document, 'purchase_lines.document 第 ' + line.id + ' 行');
  stockLedger.updatePurchaseLineDocument(f.store, line.id, { ...document, customerOrderId: f.b.id, notes: '虚构对齐' });
  assert.deepEqual(storedLinks(f.store, f.purchase.id), [[f.a.id, null], [f.b.id, null]]);
  assert.equal(f.flow.views.purchases(true, f.purchase.id)[0].lines[0].notes, '虚构对齐');
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT purchase_id FROM (' + purchaseOrderLinks + ') WHERE order_id=?')
    .all(f.a.id)
    .map((r) => String(r.detail))
    .join(' | ');
  assert.match(plan, /purchase_lines_customer_order/, plan);
  assert.doesNotMatch(plan, /SCAN purchase_lines/, plan);
});

test('不在本机的超级管理员模式删订单：采购明细按行的关联解除并列进影响清单，采购单和明细留着、版本加一', () => {
  const f = setup();
  const service = new DatabaseMaintenanceService(f.store),
    who = superActor(),
    before = f.flow.views.purchases(true, f.purchase.id)[0],
    selection = { module: 'orders', items: [{ id: f.a.id, version: f.a.version }] },
    plan = service.preview(selection, who);
  assert.ok(
    plan.impact.some((r) => r.table === 'purchase_lines' && r.action === 'detach' && r.fields?.includes('customer_order_id') === true),
    '影响清单列出解除关联的采购明细',
  );
  service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, who, 'session');
  assert.equal(sales(f.store).order(f.a.id, true), undefined, '订单删了');
  assert.deepEqual(storedLinks(f.store, f.purchase.id), [[null, null], [f.b.id, null]]);
  const after = f.flow.views.purchases(true, f.purchase.id)[0];
  assert.deepEqual(after.lines.map((l) => l.quantity), before.lines.map((l) => l.quantity), '采购明细留着');
  assert.ok(after.version > before.version, '采购单版本加一，删除前打开的编辑窗保存时提示刷新');
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('本机管理员改采购单（明细编号保留）：换关联的订单、清空、加一行，列跟着变', () => {
  const f = setup();
  const admin = localAdministratorActor({ ...actor, role: 'super_admin', superAdminMode: true, superAdminUntil: Date.now() + 3600000 });
  const current = f.flow.views.purchases(true, f.purchase.id)[0];
  const { id: _itemId, ...spec } = f.item;
  const saved = f.flow.stock.savePurchase(
    {
      ...current,
      status: current.baseStatus,
      lines: [
        { ...current.lines[0], customerOrderId: f.b.id },
        { ...current.lines[1], customerOrderId: null },
        { ...spec, stockItemId: f.item.id, customerOrderId: f.a.id, quantity: '50', unitPrice: '1.2', priceBasis: 'quantity' },
      ],
    },
    admin,
    f.purchase.id,
  );
  assert.deepEqual(saved.lines.slice(0, 2).map((l) => l.id), current.lines.map((l) => l.id), '原有两行的编号不变');
  assert.deepEqual(saved.lines.map((l) => l.customerOrderId), [f.b.id, null, f.a.id]);
  assert.deepEqual(storedLinks(f.store, f.purchase.id), [[f.b.id, null], [null, null], [f.a.id, null]]);
  assert.deepEqual(saved.orderIds.sort(), [f.a.id, f.b.id].sort());
});

test('明细关联的订单不存在就拒绝保存', () => {
  const f = setup();
  const current = f.flow.views.purchases(true, f.purchase.id)[0];
  assert.throws(
    () =>
      f.flow.stock.savePurchase(
        {
          ...current,
          status: current.baseStatus,
          lines: current.lines.map((l, i) => (i === 0 ? { ...l, customerOrderId: 999 } : l)),
        },
        actor,
        f.purchase.id,
      ),
    /明细关联的客户订单不存在/,
  );
});

test('合并导出订货单时同种纸板合成一行；到货入库流水记在每行自己的订单上', () => {
  const f = setup();
  const current = f.flow.views.purchases(true, f.purchase.id)[0];
  f.flow.stock.savePurchase({ ...current, status: '已订货' }, actor, f.purchase.id);
  const batches = new OrderBatchService(f.store);
  const batchId = batches.batchIdOf(f.purchase.id) ?? assert.fail('改成已订货后应该有订货单');
  const batch = batches.view(batchId);
  assert.equal(batch.rows.length, 1, '系统里按订单分两行，订货单上合成一行');
  assert.equal(batch.rows[0].orderedUnits, 500_000);
  registerArrival(batches.store, 
    { batchId },
    {
      expectedVersion: batch.version,
      requestId: randomUUID(),
      date: '2026-11-05',
      reference: '虚构送货单-001',
      rows: [{ key: batch.rows[0].key, quantity: '500' }],
    },
    actor,
  );
  const movements = f.store.db
    .prepare("SELECT customer_order_id AS orderId,delta_units AS delta FROM stock_movements WHERE item_id=? AND action='purchase' ORDER BY id")
    .all(f.item.id)
    .map((m) => [Number(m.orderId), Number(m.delta)]);
  assert.deepEqual(movements.sort((x, y) => x[0] - y[0]), [
    [f.a.id, 300_000],
    [f.b.id, 200_000],
  ].sort((x, y) => x[0] - y[0]));
  for (const order of [f.a, f.b]) assert.equal(trackedOrder(f.store, order.id, true)?.materialProgress, 'done');
});

test('已有到货后仍可改每行关联的订单，其他内容不动', () => {
  const f = setup();
  let current = f.flow.views.purchases(true, f.purchase.id)[0];
  f.flow.stock.savePurchase({ ...current, status: '已订货' }, actor, f.purchase.id);
  const batches = new OrderBatchService(f.store);
  const batchId = batches.batchIdOf(f.purchase.id) ?? assert.fail('改成已订货后应该有订货单');
  const batch = batches.view(batchId);
  registerArrival(batches.store, 
    { batchId },
    { expectedVersion: batch.version, requestId: randomUUID(), date: '2026-11-05', reference: '虚构送货单-002', rows: [{ key: batch.rows[0].key, quantity: '100' }] },
    actor,
  );
  current = f.flow.views.purchases(true, f.purchase.id)[0];
  const saved = f.flow.stock.savePurchase(
    {
      ...current,
      status: current.baseStatus,
      lines: current.lines.map((l) => ({ ...l, customerOrderId: f.a.id })),
    },
    { ...actor, localAdministrator: false },
    f.purchase.id,
  );
  assert.deepEqual(saved.orderIds, [f.a.id]);
  assert.deepEqual(saved.lines.map((l) => l.quantity), ['300', '200']);
  assert.deepEqual(storedLinks(f.store, f.purchase.id), [[f.a.id, null], [f.a.id, null]]);
});
