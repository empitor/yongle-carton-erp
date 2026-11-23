// 本机管理员改订单删掉明细时连带改单据（server/orders/order-edit-cascade.ts）：只挂这一行的送货单删掉、合送的去掉这一行，
// 已出库那一行的出库留成“系统维护”的独立流水，已撤销的只改内容；流水和明细对不上的先拦下。
import { test } from 'node:test';
// 删除引擎要各模块登记的删除规则
import '../server/import/index.js';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { many, rows } from '../server/core/index.js';
import { orderSchema } from '../shared/core/domain.js';
import { splitDeliveryFixture } from './maintenance-fixture.js';
import { orderOf } from './flow-fixture.js';

test('管理员改订单去掉一行：只挂这一行的送货单删掉、几行合送的去掉这一行、这种产品的生产任务不再关联它；别的订单的单据不动', () => {
  const f = splitDeliveryFixture();
  try {
    const second = f.base.product({ name: '虚构纸箱二' }),
      finished2 = f.base.finished(second, { name: '虚构成品二' });
    const order = f.base.order(f.customer, [
      { productId: f.product.id, quantity: 100, unitPriceCents: 100 },
      { productId: second.id, quantity: 200, unitPriceCents: 100 },
    ], { deliveryDate: '2026-10-30' });
    const [keep, drop] = order.lines;
    const line = (o: { id: number }, l: { id: number }, stockId: number) => ({ orderId: o.id, orderLineId: l.id, stockId, quantity: '10' });
    const deliver = (lines: ReturnType<typeof line>[]) => f.flow.save('delivery', { date: '2026-10-27', customerId: f.customer.id, lines }, f.who);
    const onlyDropped = deliver([line(order, drop, finished2.id)]),
      shared = deliver([line(order, keep, f.finished.id), line(order, drop, finished2.id)]),
      another = f.order([100]),
      otherOrder = deliver([line(another, another.lines[0], f.finished.id)]);
    // 另一张也订了第二种产品的订单：生产任务同时关联两张
    const sameProduct = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: [{ productId: second.id, quantity: 50, unitPriceCents: 100 }],
      }),
    );
    const task = f.flow.save('task', { date: '2026-10-27', productId: second.id, quantity: '250', unit: '只', orderIds: [order.id, sameProduct.id] }, f.who);
    f.editOrder(order.id, { lines: [orderOf(f.store, order.id).lines[0]] });
    assert.equal(f.store.db.prepare('SELECT 1 FROM flow_documents WHERE id=?').get(onlyDropped.id), undefined, '只挂这一行的送货单删掉');
    assert.deepEqual(f.flow.get(shared.id, 'delivery').lines.map((l) => l.orderLineId), [keep.id], '合送的只留下还在的那一行');
    assert.deepEqual(f.flow.get(otherOrder.id, 'delivery').lines, otherOrder.lines, '别的订单的送货单不动');
    assert.deepEqual(f.flow.get(task.id, 'task').orderIds, [sameProduct.id], '这种产品不在订单里了，生产任务不再关联它，另一张照旧');
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('改订单删掉明细：已撤销的送货单只改内容不动流水，之后删掉它库存不变；已出库的送货单把删掉那行的出库留成独立流水', () => {
  // 已撤销
  {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100, 60]);
      const d = f.ship([{ order: a, line: 0 }, { order: a, line: 1, quantity: '60' }]);
      f.undo(d.id);
      const before = f.moves();
      f.editOrder(a.id, { lines: [orderOf(f.store, a.id).lines[0]] });
      const doc = f.flow.get(d.id, 'delivery');
      assert.equal(doc.status, 'reversed');
      assert.deepEqual(doc.lines.map((l) => [l.orderLineId, l.quantity]), [[a.lines[0].id, '100']]);
      assert.deepEqual(f.moves(), before, '已撤销的送货单：流水一笔没动');
      assert.equal(f.revisions(), 0);
      assert.deepEqual(f.own(d.id), { out: -160000, back: 160000 });
      f.remove(d.id);
      assert.equal(f.balance(), 860000, '删掉这张已撤销的送货单（库存一起改回），库存不变');
      assert.equal(f.moves().filter((m) => m.source_kind !== 'flow_arrival' && m.source_kind !== 'flow_production').length, 0);
      assert.deepEqual(f.foreignKeys(), []);
    } finally {
      f.store.close();
    }
  }
  // 已出库：货已经出去了，删掉那行的出库不退回，留成独立流水
  {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100, 60]);
      const d = f.ship([{ order: a, line: 0 }, { order: a, line: 1, quantity: '60' }]);
      f.editOrder(a.id, { lines: [orderOf(f.store, a.id).lines[0]] });
      const doc = f.flow.get(d.id);
      assert.equal(doc.status, 'confirmed');
      assert.deepEqual(f.own(d.id), { out: -100000, back: 0 }, '留下的那一行还记在这张单上');
      const detached = f.moves().filter((m) => m.source_kind === 'database-maintenance');
      assert.deepEqual(detached.map((m) => [Number(m.delta_units), m.source_id]), [[-60000, null]]);
      assert.deepEqual(
        doc.movements,
        f
          .moves()
          .filter((m) => m.source_kind === 'flow_delivery' && m.source_id === String(d.id))
          .map((m) => String(m.id)),
      );
      assert.ok(f.revisions() > 0);
      assert.equal(f.balance(), 700000, '库存不变');
      assert.deepEqual(f.foreignKeys(), []);
    } finally {
      f.store.close();
    }
  }
});

test('改订单删掉明细：整张送货单都是被删的行，和只删其中几行，库存结果一样——数量不动，那一行的出库还是原来那笔、留成独立流水并记着原来的订单', () => {
  // 被删的那一行在每种情况下都是“订单第二行、60 只”
  const run = (wholeDocument: boolean) => {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100, 60]);
      const d = f.ship(wholeDocument ? [{ order: a, line: 1, quantity: '60' }] : [{ order: a, line: 0 }, { order: a, line: 1, quantity: '60' }]);
      const shipped = wholeDocument ? 60000 : 160000;
      const before = f.moves().find((m) => m.source_id === String(d.id) && Number(m.delta_units) === -60000);
      assert.ok(before);
      const maxSeq = Math.max(...f.moves().map((m) => Number(m.seq)));
      f.editOrder(a.id, { lines: [orderOf(f.store, a.id).lines[0]] });

      assert.equal(f.balance(), 860000 - shipped, '删订单明细不退库存：货已经出去了');
      const after = f.moves().find((m) => m.id === before.id);
      assert.ok(after);
      // 比的是一份拷贝：deepEqual 是类型断言，直接传 after 会把它的类型收窄成只剩这两个字段
      assert.deepEqual(
        { ...after },
        { ...before, source_kind: 'database-maintenance', source_id: null },
        '那一行的出库还是原来那笔：流水号、顺序号、数量、关联订单都不变，只是不再挂在送货单上',
      );
      assert.equal(Number(after.customer_order_id), a.id, '独立流水还记着它原来的订单');
      assert.equal(Math.max(...f.moves().map((m) => Number(m.seq))), maxSeq, '没有新记流水');
      const revisionRow = rows.stock_movement_revisions.pick({ movement_id: true, after_document: true });
      const revisionDocument = z.looseObject({ source_kind: z.string(), source_id: z.string().nullable() });
      const revisions = many(f.store.db, revisionRow, 'SELECT movement_id,after_document FROM stock_movement_revisions ORDER BY id').map((r) => {
        assert.ok(r.after_document);
        const document = revisionDocument.parse(JSON.parse(r.after_document));
        return [r.movement_id, document.source_kind, document.source_id];
      });
      assert.deepEqual(revisions, [[String(before.id), 'database-maintenance', null]], '只改写了这一笔流水，留了一条修订记录');
      if (wholeDocument) assert.equal(f.deliveries().length, 0, '整张都是被删的行：送货单删掉');
      else {
        assert.deepEqual(f.own(d.id), { out: -100000, back: 0 }, '留下的那一行还记在这张单上');
        assert.deepEqual(f.flow.get(d.id, 'delivery').lines.map((l) => l.quantity), ['100']);
      }
      const order = orderOf(f.store, a.id);
      assert.deepEqual(
        [order.lines.length, order.lines[0].shippedQuantity, order.status],
        wholeDocument ? [1, 0, '已确认'] : [1, 100, '已发货'],
        '订单的已发数量和状态按留下的送货单算',
      );
      assert.deepEqual(f.foreignKeys(), []);
      return { balanceChange: f.balance() - (860000 - shipped), delta: Number(after.delta_units), source: after.source_kind };
    } finally {
      f.store.close();
    }
  };
  assert.deepEqual(run(true), run(false), '两种情况的库存结果一样');

  // 整张都是被删行的已撤销送货单：出库和冲销两笔都留成独立流水，合计还是 0
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100, 60]);
    const d = f.ship([{ order: a, line: 1, quantity: '60' }]);
    f.undo(d.id);
    f.editOrder(a.id, { lines: [orderOf(f.store, a.id).lines[0]] });
    assert.equal(f.deliveries().length, 0);
    assert.equal(f.balance(), 860000);
    assert.deepEqual(
      f
        .moves()
        .filter((m) => m.source_kind === 'database-maintenance')
        .map((m) => Number(m.delta_units)),
      [-60000, 60000],
    );
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('拆、减送货单行之前先核对流水和明细：流水被合并过、合计对不上的都不猜，订单不改并说清怎么办；按提示先撤销这张送货单再改订单就行', () => {
  const mismatch = (number: string) =>
    new RegExp('送货单 ' + number + ' 名下的出库流水和它的明细对不上（流水被改动过），这次没有改订单。请先撤销这张送货单再改订单');
  // 同一张订单两行（100、60）记成了一笔 160 的出库：要拿走 60 那一行时不是一行一笔，拒绝，不另记新流水
  {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100, 60]);
      const d = f.ship([{ order: a, line: 0 }, { order: a, line: 1, quantity: '60' }]);
      const [first, second] = f.moves().filter((m) => m.source_id === String(d.id));
      f.store.db.prepare('DELETE FROM stock_movements WHERE id=?').run(second.id);
      f.store.db.prepare('UPDATE stock_movements SET delta_units=-160000 WHERE id=?').run(first.id);
      const snapshot = () => ({
        moves: f.moves(),
        lines: f.flow.get(d.id, 'delivery').lines.map((l) => [l.orderLineId, l.quantity]),
        order: orderOf(f.store, a.id).lines.length,
        revisions: f.revisions(),
      });
      const before = snapshot();
      const removeSecondLine = () => f.editOrder(a.id, { lines: [orderOf(f.store, a.id).lines[0]] });
      assert.throws(removeSecondLine, mismatch(d.number));
      assert.deepEqual(snapshot(), before, '被拦下后订单、送货单、流水都没变，也没有多出新流水');

      // 按提示先撤销这张送货单（按库存品合计冲回，不管流水怎么记的），再改订单就成功了：撤销了的送货单只改内容，流水不动
      f.flow.reverse(d.id, { version: f.flow.get(d.id).version, reason: '虚构：流水对不上，先撤销', acknowledged: true }, f.who);
      assert.equal(f.balance(), 860000);
      removeSecondLine();
      assert.equal(orderOf(f.store, a.id).lines.length, 1);
      assert.deepEqual(f.flow.get(d.id, 'delivery').lines.map((l) => l.orderLineId), [orderOf(f.store, a.id).lines[0].id]);
      assert.equal(f.balance(), 860000);
      assert.deepEqual(f.foreignKeys(), []);
    } finally {
      f.store.close();
    }
  }
  // 流水合计和明细对不上（100 的那一行只记了 90）：删明细、换客户都不动手，订单、送货单、流水保持原样
  {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100, 60]),
        b = f.order([100]);
      const d = f.ship([{ order: a, line: 0 }, { order: a, line: 1, quantity: '60' }, { order: b }]);
      const first = f.moves().find((m) => m.source_id === String(d.id));
      assert.ok(first);
      f.store.db.prepare('UPDATE stock_movements SET delta_units=-90000 WHERE id=?').run(first.id);
      const snapshot = () => ({
        moves: f.moves(),
        lines: f.flow.get(d.id, 'delivery').lines.map((l) => [l.orderLineId, l.quantity]),
        order: [orderOf(f.store, a.id).customerId, orderOf(f.store, a.id).lines.length],
        deliveries: f.deliveries().length,
        revisions: f.revisions(),
      });
      const before = snapshot();
      assert.throws(() => f.editOrder(a.id, { lines: [orderOf(f.store, a.id).lines[0]] }), mismatch(d.number));
      const other = f.base.customer({ name: '虚构对不上客户' });
      assert.throws(() => f.editOrder(a.id, { customerId: other.id }), mismatch(d.number));
      assert.deepEqual(snapshot(), before, '被拦下后什么都没变');
    } finally {
      f.store.close();
    }
  }
});
