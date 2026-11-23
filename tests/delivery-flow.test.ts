// 送货单（server/flow/）：预览和会话、版本绑定，超订单数量，多订单送货，改期，管理员改已出库的送货单。内存库、虚构数据。
import { sales } from '../server/sales/index.js';
import { trackedOrder } from '../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderSchema, today } from '../shared/core/domain.js';
import { selectedStockUnits } from '../shared/business/warehouse-delivery.js';
import { flowStatusLabel } from '../shared/business/physical-flow.js';
import { Store, one as oneRow, parseStoredJson, rows } from '../server/core/index.js';
import { businessBase } from './business-base-fixture.js';
import { flowFixture, clerk, clerk as actor, localAdmin } from './flow-fixture.js';
import { updateDocumentInfo } from '../server/flow/index.js';
import { viewAs } from './read-result.js';
import { flowDocumentSchema } from '../shared/business/index.js';

/** 从库里重读订单：读不到就判失败 */
function orderOf(store: Store, id: number) {
  const order = trackedOrder(store, id);
  assert.ok(order, '订单还在');
  return order;
}

/** flowFixture 加：成品期初 n 只；delivery(订单, 数量, 别的字段) 存一张待送货的送货单 */
function fixture(stock = '0') {
  const f = flowFixture();
  if (stock !== '0') f.stockIn(stock);
  const delivery = (order: { id: number; lines: { id: number }[] }, quantity: string, extra: Record<string, unknown> = {}, who = clerk) =>
    f.flow.save(
      'delivery',
      { date: '2026-10-22', customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity }], ...extra },
      who,
    );
  const snapshot = () =>
    Object.fromEntries(
      ['stock_movements', 'flow_documents', 'flow_refs', 'operation_requests', 'business_audit', 'order_lines'].map((t) => [
        t,
        f.store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all(),
      ]),
    );
  return { ...f, delivery, snapshot };
}

test('送货预览不绑会话、不过期：预览以后数据没变就照常确认；超出订单数量要超级管理员批准', () => {
  const f = fixture('120');
  try {
    const order = f.order(100);
    const admin = localAdmin();
    const d = f.delivery(order, '110', { allowOverdelivery: true, overdeliveryReason: '客户确认追加' }, admin);
    assert.throws(() => f.flow.preview(d.id, clerk), /超级管理员/);
    const p = f.flow.preview(d.id, admin);
    f.flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, admin);
    assert.equal(orderOf(f.store, order.id).lines[0].shippedQuantity, 110);
  } finally {
    f.store.close();
  }
});

test('送货改期让旧确认失效；库存被用掉后预览就拦下；补足后同一请求只出库一次', () => {
  const f = fixture('10');
  try {
    const order = f.order(10);
    const doc = f.delivery(order, '10');
    const requestId = randomUUID();
    const preview = () => f.flow.preview(doc.id, clerk);
    const confirm = (previewDigest: string) => f.flow.confirm(doc.id, { previewDigest, requestId, acknowledged: true }, clerk);
    const move = (action: 'in' | 'out', quantity: string) =>
      f.flow.stock.move(
        f.finished.id,
        { action, quantity, date: '2026-10-22', acknowledged: true, notes: '虚构库存变动', requestId: randomUUID(), expectedVersion: f.ops.items(true, f.finished.id)[0].version },
        clerk,
      );
    const original = preview();
    f.flow.schedule(doc.id, { expectedVersion: doc.version, requestId: randomUUID(), plannedDate: '2026-10-29' }, clerk);
    const scheduled = f.snapshot();
    assert.throws(() => confirm(original.previewDigest), /已变化/);
    assert.deepEqual(f.snapshot(), scheduled);
    const stale = preview();
    move('out', '1');
    const insufficient = f.snapshot();
    assert.throws(() => confirm(stale.previewDigest), /已变化/);
    assert.throws(preview, /库存不足/);
    assert.deepEqual(f.snapshot(), insufficient);
    assert.equal(orderOf(f.store, order.id).lines[0].shippedQuantity, 0);
    move('in', '1');
    const valid = preview();
    const saved = confirm(valid.previewDigest);
    assert.equal(saved.status, 'confirmed');
    assert.equal(orderOf(f.store, order.id).lines[0].shippedQuantity, 10);
    assert.equal(f.ops.balance(f.finished.id), 0);
    const after = f.snapshot();
    assert.deepEqual(confirm(valid.previewDigest), saved);
    assert.deepEqual(f.snapshot(), after);
  } finally {
    f.store.close();
  }
});

test('一张任务排两张订单、不挂任务的完工也入库；一张送货单送两张订单，两张都算已发货', () => {
  const f = fixture();
  try {
    f.arrive('虚构备料', '100');
    const first = f.order(100),
      second = f.order(50);
    const task = f.task({ productId: f.product.id, quantity: '150', unit: '只', orderIds: [first.id, second.id] });
    assert.equal(task.orderIds.length, 2);
    f.confirm('production', { taskId: null, productId: f.product.id, finishedStockId: f.finished.id, goodQuantity: '150', operator: '虚构员工', materials: [{ stockId: f.raw.id, issued: '90', returned: '0' }] });
    f.confirm('delivery', {
      customerId: f.customer.id,
      lines: [
        { orderId: first.id, orderLineId: first.lines[0].id, stockId: f.finished.id, quantity: '100' },
        { orderId: second.id, orderLineId: second.lines[0].id, stockId: f.finished.id, quantity: '50' },
      ],
    });
    assert.deepEqual([orderOf(f.store, first.id).status, orderOf(f.store, second.id).status], ['已发货', '已发货']);
    assert.equal(f.ops.balance(f.finished.id), 0);
  } finally {
    f.store.close();
  }
});

test('改已送达的送货单的说明（编辑只改备注）：出库、送达记录和原来安排的日期都保留', () => {
  const f = fixture('10');
  try {
    const order = f.order(10);
    const shipped = viewAs(f.confirmId(f.delivery(order, '10', { plannedDate: '2026-10-25' }).id), 'delivery');
    assert.equal(shipped.plannedDate, '2026-10-25');
    const done = f.flow.markDelivered(shipped.id, { version: shipped.version }, clerk);
    const edited = viewAs(updateDocumentInfo(f.store, shipped.id, { notes: '虚构备注', expectedVersion: done.version }, clerk), 'delivery');
    assert.deepEqual([edited.notes, edited.plannedDate], ['虚构备注', '2026-10-25']);
    for (const k of ['shippedAt', 'shippedBy', 'deliveredAt', 'deliveredBy'] as const) assert.equal(edited[k], done[k], k);
    assert.equal(flowStatusLabel(edited), '已送达');
    const stored = oneRow(f.store.db, rows.flow_documents.pick({ planned_date: true, document: true }), 'SELECT planned_date,document FROM flow_documents WHERE id=?', shipped.id);
    assert.ok(stored, '送货单在库里');
    assert.equal(stored.planned_date, '2026-10-25');
    assert.equal(parseStoredJson(flowDocumentSchema('delivery'), stored.document, 'flow_documents.document').plannedDate, '2026-10-25');
  } finally {
    f.store.close();
  }
});

/** 两个客户、两种产品（各有成品 50 只），每个客户一张两行的订单 */
function deliveryFixture() {
  const base = businessBase(actor),
    { store, flow, ops } = base;
  const customer = base.customer({ name: '送货甲客户' }),
    other = base.customer({ name: '送货乙客户' });
  const products = ['成品一', '成品二'].map((name) => base.product({ name }));
  const stocks = products.map((p) => base.finished(p, { name: p.name }, { quantity: '50', date: today() }));
  const createOrder = (c: { id: number }) =>
    base.order(c, products.map((p, i) => base.line(p, (i + 1) * 10)), { orderDate: today(), deliveryDate: today() });
  return { store, flow, ops, check: base.check, customer, other, products, stocks, order: createOrder(customer), otherOrder: createOrder(other) };
}

test('多种产品的送货单：待送货不扣库存；保存、确认同一请求不重复；分两批送完订单才算已发货；别的客户的订单、没挂订单的行都拒', () => {
  const f = deliveryFixture();
  try {
    const input = {
      customerId: f.customer.id,
      date: today(),
      address: '虚构地址',
      requestId: randomUUID(),
      lines: f.order.lines.map((l, i) => ({
        orderId: f.order.id,
        orderLineId: l.id,
        stockId: f.stocks[i].id,
        quantity: String((i + 1) * 4),
      })),
    };
    const doc = f.flow.save('delivery', input, actor);
    assert.equal(f.ops.balance(f.stocks[0].id), 50000);
    assert.equal(f.flow.save('delivery', input, actor).id, doc.id);
    assert.equal(f.flow.list('delivery').length, 1);
    assert.throws(
      () => f.flow.save('delivery', { ...input, address: '改变内容' }, actor),
      /同一请求/,
    );
    const preview = f.flow.preview(doc.id, actor),
      confirm = { previewDigest: preview.previewDigest, requestId: randomUUID(), acknowledged: true };
    const saved = f.flow.confirm(doc.id, confirm, actor);
    assert.equal(saved.status, 'confirmed');
    f.flow.confirm(doc.id, confirm, actor);
    assert.equal(f.ops.balance(f.stocks[0].id), 46000);
    assert.equal(f.ops.balance(f.stocks[1].id), 42000);
    assert.equal(orderOf(f.store, f.order.id).status, '待发货');
    assert.equal(orderOf(f.store, f.order.id).lines[0].remainingQuantity, 6);
    const second = f.flow.save(
      'delivery',
      {
        ...input,
        requestId: randomUUID(),
        lines: f.order.lines.map((l, i) => ({
          orderId: f.order.id,
          orderLineId: l.id,
          stockId: f.stocks[i].id,
          quantity: String((i + 1) * 6),
        })),
      },
      actor,
    );
    f.check(second);
    assert.equal(orderOf(f.store, f.order.id).status, '已发货');
    assert.equal(orderOf(f.store, f.order.id).lines[1].remainingQuantity, 0);
    assert.equal(orderOf(f.store, f.otherOrder.id).lines[0].shippedQuantity, 0);
    assert.throws(
      () =>
        f.flow.save(
          'delivery',
          { ...input, requestId: randomUUID(), customerId: f.other.id },
          actor,
        ),
      /同一客户/,
    );
    assert.throws(() =>
      f.flow.save(
        'delivery',
        {
          ...input,
          requestId: randomUUID(),
          lines: [{ ...input.lines[0], orderId: null, orderLineId: null }],
        },
        actor,
      ),
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('库存不够、同一种成品几张订单合计超过库存时预览就拦下，单据留在待送货，库存不动', () => {
  const f = deliveryFixture();
  try {
    const otherSameCustomer = sales(f.store).saveOrder(
      orderSchema.parse({
        ...f.order,
        lines: f.order.lines.map((l) => ({ ...l, id: undefined, quantity: 100 })),
      }),
    );
    const doc = f.flow.save(
      'delivery',
      {
        customerId: f.customer.id,
        date: today(),
        lines: [
          {
            orderId: otherSameCustomer.id,
            orderLineId: otherSameCustomer.lines[0].id,
            stockId: f.stocks[0].id,
            quantity: '51',
          },
        ],
      },
      actor,
    );
    assert.throws(() => f.flow.preview(doc.id, actor), /库存不足/);
    assert.equal(f.flow.get(doc.id).status, 'draft');
    assert.equal(f.ops.balance(f.stocks[0].id), 50000);
    const split = f.flow.save(
      'delivery',
      {
        customerId: f.customer.id,
        date: today(),
        lines: [
          {
            orderId: otherSameCustomer.id,
            orderLineId: otherSameCustomer.lines[0].id,
            stockId: f.stocks[0].id,
            quantity: '45',
          },
          {
            orderId: f.order.id,
            orderLineId: f.order.lines[0].id,
            stockId: f.stocks[0].id,
            quantity: '6',
          },
        ],
      },
      actor,
    );
    assert.throws(() => f.flow.preview(split.id, actor), /库存不足/);
    assert.equal(f.flow.get(split.id).status, 'draft');
    assert.equal(f.ops.balance(f.stocks[0].id), 50000);
  } finally {
    f.store.close();
  }
});

test('送货单里选的同一个库存品按数量合计；数量写错的算不出', () => {
  assert.equal(selectedStockUnits([{ stockId: 1, quantity: '1.5' }, { stockId: 1, quantity: '2' }], 1), 3500);
  assert.equal(selectedStockUnits([{ stockId: 1, quantity: 'abc' }], 1), null);
});
