// 只做合计的几处读法：订单明细已发（server/flow/shipped.ts）、生产任务的完工进度（server/flow/read.ts）。
// 守的是结果：送货单、完工单各种状态混在一起时，每条订单明细已发多少、每张任务完工到哪，一个数都不能变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderSchema } from '../shared/core/domain.js';
import { finishedStockOfProduct } from '../server/flow/stock-batches.js';
import { shippedByLine, shippedUnits } from '../server/flow/shipped.js';
import { businessFixture } from './flow-fixture.js';
import { saveDoc } from './receive-fixture.js';

type Fixture = ReturnType<typeof businessFixture>;

const firstLineId = (order: { lines: { id?: number }[] }) => {
  const id = order.lines[0]?.id;
  if (id === undefined) throw new Error('虚构订单没有明细编号');
  return id;
};

/** 纸板到货，取到货单那一行入的库存品（领料用） */
function rawStock(f: Fixture) {
  const id = f.arrival('1000').lines[0]?.stockId;
  if (id == null) throw new Error('虚构到货没有入库存品');
  return id;
}

function reverse(f: Fixture, id: number) {
  f.flow.reverse(id, { version: f.flow.get(id).version, reason: '虚构撤销', acknowledged: true }, f.actor);
}

/** 完工单：confirm 给 true 是核对入库的，不给是待入库的 */
function production(f: Fixture, raw: number, input: { taskId: number | null; good: string; date?: string }, confirm = true) {
  const doc = {
    date: input.date ?? '2026-10-27',
    taskId: input.taskId,
    productId: f.product.id,
    goodQuantity: input.good,
    operator: '虚构员工',
    materials: [{ stockId: raw, issued: '10', returned: '0' }],
  };
  return confirm ? f.confirm('production', doc) : saveDoc(f.flow, 'production', doc, f.actor);
}

test('订单明细已发：只算已出库的送货单；按订单圈出的送货单，里面别的订单的行也一起算', () => {
  const f = businessFixture();
  try {
    const raw = rawStock(f),
      task = f.task('200');
    production(f, raw, { taskId: task.id, good: '100' });
    const other = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: [{ productId: f.product.id, quantity: 300, unit: '只', unitPriceCents: 100 }],
      }),
    );
    const stockId = finishedStockOfProduct(f.store, f.product.id),
      lineA = firstLineId(f.order),
      lineB = firstLineId(other);
    const delivery = (lines: [number, number, string][]) => ({
      customerId: f.customer.id,
      lines: lines.map(([orderId, orderLineId, quantity]) => ({ orderId, orderLineId, stockId, quantity })),
    });
    const both = f.confirm('delivery', delivery([[f.order.id, lineA, '30'], [other.id, lineB, '20']]));
    f.confirm('delivery', delivery([[f.order.id, lineA, '12']]));
    saveDoc(f.flow, 'delivery', { date: '2026-10-27', ...delivery([[f.order.id, lineA, '25']]) }, f.actor);
    reverse(f, f.confirm('delivery', delivery([[other.id, lineB, '8']])).id);

    const db = f.store.db;
    assert.deepEqual(shippedByLine(db, undefined), new Map([[lineA, 42000], [lineB, 20000]]));
    // 第一张单同时发了两张订单：按订单 A 圈出它，B 的那一行也算在结果里
    assert.deepEqual(shippedByLine(db, [f.order.id]), new Map([[lineA, 42000], [lineB, 20000]]));
    assert.deepEqual(shippedByLine(db, [other.id]), new Map([[lineA, 30000], [lineB, 20000]]));
    assert.deepEqual(shippedByLine(db, []), new Map());
    assert.equal(shippedUnits(db, lineA), 42000);
    assert.equal(shippedUnits(db, lineA, both.id), 12000);
    assert.equal(shippedUnits(db, lineB), 20000);
    assert.equal(shippedUnits(db, undefined), 0);
    assert.equal(f.store.order(f.order.id)?.lines[0]?.shippedQuantity, 42);
  } finally {
    f.store.close();
  }
});

test('生产任务的完工进度：已入库、待入库、开工和完工日期，全部列表、按编号列表和单张读出来一样', () => {
  const f = businessFixture();
  try {
    const raw = rawStock(f);
    const partly = f.task('100'),
      done = f.task('50'),
      idle = f.task('10'),
      waiting = f.task('10');
    production(f, raw, { taskId: partly.id, good: '30', date: '2026-10-26' });
    production(f, raw, { taskId: partly.id, good: '20', date: '2026-10-28' });
    reverse(f, production(f, raw, { taskId: partly.id, good: '10', date: '2026-10-29' }).id);
    const pending = production(f, raw, { taskId: partly.id, good: '5' }, false);
    const archived = production(f, raw, { taskId: partly.id, good: '7' }, false);
    f.store.db
      .prepare("INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES('flow_production',?,?,?)")
      .run(archived.id, '2026-10-30T00:00:00.000Z', f.actor.id);
    production(f, raw, { taskId: done.id, good: '50', date: '2026-10-25' });
    production(f, raw, { taskId: waiting.id, good: '3' }, false);
    production(f, raw, { taskId: null, good: '9' });

    const facts = (id: number) => {
      const t = f.flow.get(id, 'task');
      return [t.completed, t.pendingCompleted, t.progress, t.hasProduction, t.actualStartDate, t.actualCompletionDate];
    };
    const expected = new Map([
      [partly.id, ['50', '5', 50, true, '2026-10-26', null]],
      [done.id, ['50', '0', 100, true, '2026-10-25', '2026-10-25']],
      [idle.id, ['0', '0', 0, false, null, null]],
      [waiting.id, ['0', '3', 0, true, null, null]],
    ]);
    for (const [id, want] of expected) assert.deepEqual(facts(id), want, '单张 ' + id);
    const ids = [...expected.keys()];
    for (const list of [f.flow.list('task'), f.flow.list('task', false, undefined, ids)])
      for (const t of list)
        assert.deepEqual(
          [t.completed, t.pendingCompleted, t.progress, t.hasProduction, t.actualStartDate, t.actualCompletionDate],
          expected.get(t.id),
          '列表 ' + t.id,
        );
    assert.deepEqual(f.flow.waitingGood(), new Map([[partly.id, 5000], [waiting.id, 3000]]));
    assert.deepEqual(f.flow.waitingGood([partly.id], pending.id), new Map());
    assert.deepEqual(f.flow.waitingGood([]), new Map());
  } finally {
    f.store.close();
  }
});
