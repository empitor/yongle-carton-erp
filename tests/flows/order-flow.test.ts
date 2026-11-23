// 订单跟着单据走（shared/business/overview/order-next-step.ts、trackedOrder）：从采购到货到送货完成的一整条，撤回和编辑的限制，待发数的整数算法。
import { trackedOrder } from '../../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualWrite } from '../support/business-base-fixture.js';
import { changeLifecycle } from '../../server/lifecycle/index.js';
import { count } from '../../server/core/index.js';
import { orderNextSteps } from '../../shared/business/index.js';
import { flowFixture, clerk } from '../support/flow-fixture.js';
import { orderedPurchase } from '../support/receive-fixture.js';

test('一整条：采购分两批到货 → 领料退料、分批完工 → 分批送货 → 订单已发货，库存和订单明细跟着走', () => {
  const f = flowFixture();
  try {
    const order = f.order(100);
    const p = orderedPurchase(f, clerk, ['200']);
    p.receive('100', 'DH-001');
    assert.equal(f.flow.views.purchases(true, p.purchase.id)[0].status, '部分到货');
    p.receive('100', 'DH-002');
    assert.equal(f.flow.views.purchases(true, p.purchase.id)[0].status, '全部到货');
    const task = f.task({ productId: f.product.id, quantity: '100', unit: '只', orderIds: [order.id] });
    const production = (good: string, issued: string, returned: string) =>
      f.confirm('production', {
        taskId: task.id,
        productId: f.product.id,
        finishedStockId: f.finished.id,
        goodQuantity: good,
        scrapQuantity: '5',
        operator: '虚构机长',
        materials: [{ stockId: f.raw.id, issued, returned }],
      });
    const deliver = (quantity: string) =>
      f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity }] });
    production('60', '80', '10');
    assert.deepEqual([f.ops.balance(f.raw.id), f.ops.balance(f.finished.id)], [130000, 60000]);
    assert.deepEqual([f.flow.get(task.id, 'task').completed, f.flow.get(task.id, 'task').progress], ['60', 60]);
    deliver('40');
    let o = trackedOrder(f.store, order.id);
    assert.ok(o);
    assert.deepEqual([o.status, o.lines[0].shippedQuantity, o.lines[0].remainingQuantity], ['生产中', 40, 60]);
    production('40', '45', '5');
    assert.equal(f.flow.get(task.id, 'task').completed, '100');
    deliver('60');
    o = trackedOrder(f.store, order.id);
    assert.ok(o);
    assert.deepEqual([o.status, o.lines[0].remainingQuantity], ['已发货', 0]);
    assert.deepEqual([f.ops.balance(f.raw.id), f.ops.balance(f.finished.id)], [90000, 0]);
    assert.equal(count(f.store.db, "SELECT COUNT(*) FROM stock_movements WHERE source_kind='flow_production'"), 6);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('订单有了生产任务就不能撤回；改金额、备注时明细编号不变，有后续单据的明细数量不能改', () => {
  const f = flowFixture();
  try {
    const order = f.order(100);
    f.draft('task', { productId: f.product.id, quantity: '100', unit: '只', orderIds: [order.id] });
    const result = changeLifecycle(f.store, 'orders', { action: 'archive', acknowledged: true, items: [{ id: order.id, version: order.version }] }, clerk);
    assert.equal(result.results[0].success, false);
    const old = trackedOrder(f.store, order.id);
    assert.ok(old);
    const change = (input: unknown) => manualWrite(f.store, { entity: 'orders', action: 'update', id: old.id, input }, clerk);
    const changed = change({ ...old, notes: '改备注', lines: old.lines.map((l) => ({ ...l, unitPriceCents: 124 })) });
    assert.equal(changed.lines[0].id, old.lines[0].id);
    assert.throws(
      () => change({ ...changed, lines: changed.lines.map((l) => ({ ...l, quantity: 99 })) }),
      /不能改变/,
    );
  } finally {
    f.store.close();
  }
});

test('订单待发数按千分整数算：1 只发了 0.9 还剩 0.1，不会误判已全部发货；下一步也按整数', () => {
  const f = flowFixture();
  try {
    const order = f.order(1);
    f.stockIn('1');
    f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '0.9' }] });
    const read = trackedOrder(f.store, order.id);
    assert.ok(read);
    assert.deepEqual([read.lines[0].shippedQuantity, read.lines[0].remainingQuantity, read.lines[0].shippingStatus], [0.9, 0.1, '部分发货']);
    const next = orderNextSteps(read, { tasks: [], stocks: [], deliveries: [], purchases: [] });
    assert.equal(next.done, undefined);
    assert.equal(next.lines[0].remaining, '0.1');
  } finally {
    f.store.close();
  }
});
