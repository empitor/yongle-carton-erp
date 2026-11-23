// 排程：计划日期和实际日期分开，改计划不动库存；做完的、已出库的不能改计划；日期工具跨时区、闰年。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { today } from '../shared/core/domain.js';
import { planDate, shiftDate } from '../shared/business/schedule.js';
import { flowInput } from '../shared/business/physical-flow.js';
import { saveDoc } from './receive-fixture.js';
import { flowFixture, localAdmin, clerk, trackedOrderOf } from './flow-fixture.js';
import { fixture, owner } from './admin-edit-fixture.js';
import { actor } from './actor-fixture.js';

type ScheduleFixture = ReturnType<typeof fixture>;

function scheduleOrder(f: ScheduleFixture) {
  f.receive();
  const customer = f.base.customer({ name: '虚构排程客户' });
  const product = f.base.product({ name: '虚构排程纸箱' });
  const finished = f.base.finished(product, { name: '虚构排程成品' });
  const order = f.base.order(customer, [f.base.line(product, 100, { unitPriceCents: 200 })], { orderDate: '2026-10-29', deliveryDate: '2026-11-04' });
  const task = saveDoc(f.flow,
    'task',
    {
      date: '2026-10-29',
      plannedDate: '2026-11-02',
      productId: product.id,
      quantity: '100',
      unit: '只',
      orderIds: [order.id],
    },
    actor,
  );
  return { customer, product, finished, order, task };
}

function checkProductionSchedule(f: ScheduleFixture, { task, product, finished }: ReturnType<typeof scheduleOrder>) {
  const snapshot = f.moves();
  const change = {
    expectedVersion: task.version,
    plannedDate: '2026-11-03',
    requestId: randomUUID(),
  };
  const first = f.flow.schedule(task.id, change, actor);
  assert.equal(first.verified, true);
  assert.equal(f.flow.schedule(task.id, change, actor).document.version, first.document.version, '重发原样返回，不再改一次');
  assert.throws(
    () => f.flow.schedule(task.id, { ...change, plannedDate: '2026-11-04' }, actor),
    /不同内容/,
  );
  assert.throws(
    () => f.flow.schedule(task.id, { ...change, requestId: randomUUID() }, actor),
    /修改/,
  );
  assert.throws(
    () =>
      f.flow.schedule(
        task.id,
        { ...change, requestId: randomUUID() },
        { ...actor, permissions: [] },
      ),
    /权限/,
  );
  assert.deepEqual(f.moves(), snapshot);
  assert.equal(f.flow.get(task.id, 'task').actualCompletionDate, null);
  const production = (q: string, date: string) =>
    f.confirm(
      saveDoc(f.flow,
        'production',
        {
          date,
          taskId: task.id,
          productId: product.id,
          finishedStockId: finished.id,
          goodQuantity: q,
          operator: '虚构操作员',
          materials: [{ stockId: f.raw.id, issued: q }],
        },
        actor,
      ),
    );
  production('40', '2026-10-29');
  let t = f.flow.get(task.id, 'task');
  assert.equal(t.actualStartDate, '2026-10-29');
  assert.equal(t.actualCompletionDate, null);
  const beforeReschedule = f.moves();
  f.flow.schedule(
    task.id,
    { expectedVersion: t.version, plannedDate: '2026-11-05', requestId: randomUUID() },
    actor,
  );
  assert.deepEqual(f.moves(), beforeReschedule);
  production('60', '2026-10-30');
  t = f.flow.get(task.id, 'task');
  assert.equal(t.actualCompletionDate, '2026-10-30');
  assert.equal(t.plannedDate, '2026-11-05');
  assert.equal(t.date, '2026-10-29');
  assert.throws(
    () =>
      f.flow.schedule(
        t.id,
        { expectedVersion: t.version, plannedDate: '2026-11-06', requestId: randomUUID() },
        owner(),
      ),
    /未完成/,
  );
}

function shippedQuantity(f: ScheduleFixture, id: number) {
  return trackedOrderOf(f.store, id).lines[0].shippedQuantity;
}

test('生产与送货排程：未来计划独立于实际、部分生产可改期、完成拒绝改期、确认才产生实绩库存', () => {
  const f = fixture();
  try {
    const schedule = scheduleOrder(f);
    checkProductionSchedule(f, schedule);
    const { customer, order, finished } = schedule;
    const delivery = saveDoc(f.flow,
      'delivery',
      {
        date: '2026-10-31',
        plannedDate: '2026-11-06',
        customerId: customer.id,
        lines: [
          {
            orderId: order.id,
            orderLineId: order.lines[0].id,
            stockId: finished.id,
            quantity: '50',
          },
        ],
      },
      actor,
    );
    assert.equal(delivery.actualDate, null);
    assert.equal(shippedQuantity(f, order.id), 0);
    const beforeDelivery = f.moves();
    f.flow.schedule(
      delivery.id,
      { expectedVersion: delivery.version, plannedDate: '2026-11-07', requestId: randomUUID() },
      actor,
    );
    assert.deepEqual(f.moves(), beforeDelivery);
    assert.equal(shippedQuantity(f, order.id), 0);
    f.confirm(f.flow.get(delivery.id));
    const done = f.flow.get(delivery.id, 'delivery');
    assert.equal(done.plannedDate, '2026-11-07');
    assert.equal(done.actualDate, '2026-10-31');
    assert.equal(shippedQuantity(f, order.id), 50);
    assert.equal(f.ops.items().find((s) => s.id === finished.id)?.quantity, '50');
    assert.throws(
      () =>
        f.flow.schedule(
          done.id,
          { expectedVersion: done.version, plannedDate: '2026-11-08', requestId: randomUUID() },
          actor,
        ),
      /待送货/,
    );
    assert.throws(
      () => f.flow.save('delivery', { ...flowInput('delivery', done), plannedDate: '2026-11-08', version: done.version }, owner(), done.id),
      /只能修改还没核对的单据/,
    );
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('计划日期：时区跨日、闰年', () => {
  assert.equal(today(new Date('2026-10-28T16:30:00Z')), '2026-10-29');
  assert.equal(today(new Date('2026-10-29T15:59:59Z')), '2026-10-29');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDate('9999-12-31', 7), '9999-12-31');
  assert.equal(shiftDate('0000-01-01', -7), '0000-01-01');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(planDate({ date: '2020-01-01' }), '2020-01-01');
});

test('本机管理员改已出库、已撤销的送货单和已完工的生产任务的计划日期：按单据说清为什么不能改', async () => {
  const f = flowFixture(),
    who = localAdmin();
  try {
    const edit = (id: number, patch: { plannedDate: string }) => {
      const cur = f.flow.get(id);
      return f.flow.save(cur.kind, { ...flowInput(cur.kind, cur), ...patch, version: cur.version }, who, id);
    };
    f.stockIn('500');
    const order = f.order(100);
    const shipped = f.confirm('delivery', {
      customerId: f.customer.id,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '100' }],
    });
    // 已出库的送货单不是待核对的单据：改数量、出库日期用更正，只改说明用编辑
    assert.throws(() => edit(shipped.id, { plannedDate: '2026-11-01' }), /只能修改还没核对的单据；已生效的到货、送货、完工单改数量用.*更正送货单/);
    f.flow.reverse(shipped.id, { version: f.flow.get(shipped.id).version, reason: '虚构：发错', acknowledged: true }, clerk);
    assert.throws(() => edit(shipped.id, { plannedDate: '2026-11-01' }), /只能修改还没核对的单据/);

    // 生产任务：没做完的照常改计划日期，做完的不能改
    f.arrive('虚构送货单-排产', '1000');
    const task = f.task({ productId: f.product.id, quantity: '10', unit: '只', orderIds: [] });
    assert.equal(f.flow.get(edit(task.id, { plannedDate: '2026-11-02' }).id, 'task').plannedDate, '2026-11-02');
    f.confirm('production', {
      taskId: task.id,
      productId: f.product.id,
      finishedStockId: f.finished.id,
      goodQuantity: '10',
      operator: '虚构员工',
      materials: [{ stockId: f.raw.id, issued: '10', returned: '0' }],
    });
    assert.throws(() => edit(task.id, { plannedDate: '2026-11-03' }), /这张生产任务已完工，计划生产日期不能再改。/);
    assert.equal(f.flow.get(task.id, 'task').plannedDate, '2026-11-02');
  } finally {
    f.store.close();
  }
});
