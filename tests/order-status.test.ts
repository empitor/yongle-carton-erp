// 订单状态由有效单据派生（server/flow/rules/order-progress.ts、server/orders/service.ts）：生产中、待发货、已发货跟着任务、完工、
// 送货走，分批做分批发、一张任务挂多张单、撤销和删除单据后回退；人工只定待确认、已确认、已取消。下一步见 order-next-step.test.ts。
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { createBusinessService } from '../server/orders/index.js';
import { localAdministratorActor, count, type Actor } from '../server/core/index.js';
import { closedOrder, deliverableOrder, effectiveOrder, orderDisplayStatus, productSchema, statuses, uncountedOrderStatuses } from '../shared/core/domain.js';
import { buildToday } from '../server/overview/workbench.js';
import { orderNextSteps } from '../shared/business/order-next-step.js';
import { materialByOrder } from '../server/operations/index.js';
import { businessFixture, flowFixture, clerk, localAdmin, orderOf, trackedOrderOf } from './flow-fixture.js';
import { rawInput, stackActor as actor, stackFixture } from './stack-fixture.js';
import { correctDocument, orderEditGuard, planCorrection } from '../server/flow/index.js';
import { superActor } from './actor-fixture.js';

/** flowFixture 加纸板 100 张；make(订单, 数量) 安排一张任务并全部完工入库 */
function madeFixture() {
  const f = flowFixture();
  f.arrive('虚构备料', '100');
  const make = (orderIds: number[], quantity: string) => {
    const task = f.task({ productId: f.product.id, quantity, unit: '只', orderIds, plannedDate: '2026-10-27' });
    f.confirm('production', {
      taskId: task.id,
      productId: f.product.id,
      finishedStockId: f.finished.id,
      goodQuantity: quantity,
      operator: '虚构员工',
      materials: [{ stockId: f.raw.id, issued: '1', returned: '0' }],
    });
    return task;
  };
  const twoLines = (quantities: number[]) =>
    f.order(0, { lines: quantities.map((quantity) => ({ productId: f.product.id, quantity, unit: '只', unitPriceCents: 100 })) });
  const unscheduled = (id: number) => buildToday(f.store, '2026-10-27').unscheduled.some((o) => o.id === id);
  return { ...f, make, twoLines, unscheduled };
}

test('分批做分批发：今天做一半发一半是部分发货，明天做完发完才是已发货', () => {
  const f = businessFixture();
  const date = '2026-10-27';
  try {
    const order = () => trackedOrderOf(f.store, f.order.id);
    const shown = () => orderDisplayStatus(order());
    const today = () => buildToday(f.store, date);
    const has = (rows: readonly { id: number }[]) => rows.some((o) => o.id === f.order.id);
    const steps = () => orderNextSteps(order(), { tasks: f.flow.list('task'), stocks: f.flow.views.items(), deliveries: [], purchases: [] }).steps;
    const ship = (quantity: string) =>
      f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.finished.id, quantity }] });
    f.arrival('100');
    const first = f.task('500');
    f.production(first.id, '500');
    assert.equal(shown(), '生产中', '订单要 1000，只做了 500');
    assert.ok(has(today().ready), '做好一批就能发，不用等全部做完');
    assert.ok(has(today().unscheduled), '还差 500 没排');

    ship('500');
    assert.equal(order().shippingProgress, '部分发货');
    assert.equal(shown(), '部分发货');
    assert.equal(has(today().ready), false, '货发完了，没有可发的');
    assert.ok(has(today().unscheduled), '发了一半，剩下的还没排');
    assert.equal(steps().find((s) => s.kind === 'schedule')?.params?.quantity, '500', '预填还差的数量');

    const second = f.task('500');
    assert.equal(has(today().unscheduled), false, '排上了就不再提醒');
    assert.equal(steps().some((s) => s.kind === 'schedule'), false);
    assert.equal(shown(), '部分发货', '第二批在做，仍然是发了一半');

    f.production(second.id, '500');
    assert.equal(order().status, '待发货');
    assert.equal(shown(), '部分发货');
    assert.ok(has(today().ready));

    ship('500');
    assert.equal(order().status, '已发货');
    assert.equal(shown(), '已发货');
  } finally {
    f.store.close();
  }
});

test('订单逐行算未发、部分发货、已发完：待送货、取消、撤销的送货单不算；没有送货单的订单已发就是 0', () => {
  const f = flowFixture();
  try {
    const products = ['甲', '乙', '丙'].map((name) => sales(f.store).createProduct(productSchema.parse({ name: '虚构纸箱' + name })));
    const stocks = products.map((p) => {
      const s = f.ops.saveItem({ name: p.name, kind: 'finished', unit: '只', productId: p.id }, clerk);
      f.stockIn('3000', s.id);
      return s;
    });
    const order = f.order(0, { lines: products.map((p, i) => ({ productId: p.id, quantity: [1000, 2000, 500][i], unit: '只', unitPriceCents: 100 })) });
    const current = () => trackedOrderOf(f.store, order.id);
    const delivery = (entries: [number, string][]) =>
      f.draft('delivery', {
        customerId: f.customer.id,
        lines: entries.map(([i, quantity]) => ({ orderId: order.id, orderLineId: order.lines[i].id, stockId: stocks[i].id, quantity })),
      });
    assert.equal(current().shippingProgress, '未发货');
    const draft = delivery([[0, '100']]);
    assert.equal(current().lines[0].shippedQuantity, 0, '待送货不算');
    f.flow.cancel(draft.id, { version: draft.version, reason: '取消', acknowledged: true }, clerk);
    const done = f.confirmId(
      delivery([
        [0, '1000'],
        [1, '500'],
      ]).id,
    );
    assert.deepEqual(current().lines.map((l) => l.shippingStatus), ['已发完', '部分发货', '未发货']);
    assert.deepEqual(current().lines.map((l) => l.remainingQuantity), [0, 1500, 500]);
    assert.deepEqual([current().shippingSummary?.completedLines, current().shippingProgress, current().status], [1, '部分发货', '待发货']);
    f.confirmId(
      delivery([
        [1, '1500'],
        [2, '500'],
      ]).id,
    );
    assert.deepEqual([current().shippingProgress, current().shippingSummary?.completedLines], ['已发完', 3]);
    f.flow.reverse(done.id, { version: done.version, reason: '撤销发货', acknowledged: true }, clerk);
    assert.deepEqual(current().lines.map((l) => l.shippedQuantity), [0, 1500, 500], '撤销的不算');
    const plain = trackedOrderOf(f.store, f.order(100).id);
    assert.deepEqual([plain.lines[0].shippedQuantity, plain.shippingProgress], [0, '未发货']);
  } finally {
    f.store.close();
  }
});

test('同产品两行各 100，只做了 100：不算做完，要提醒再排 100', () => {
  const f = madeFixture();
  try {
    const o = f.twoLines([100, 100]);
    f.make([o.id], '100');
    assert.equal(orderOf(f.store, o.id).status, '生产中');
    assert.ok(f.unscheduled(o.id));
    const related = { tasks: f.flow.list('task'), stocks: f.flow.views.items(), deliveries: [], purchases: [] };
    const current = trackedOrderOf(f.store, o.id);
    assert.ok(current);
    const schedule = orderNextSteps(current, related).steps.filter((s) => s.kind === 'schedule');
    assert.equal(schedule.length, 1, '同一产品只提醒一次');
    assert.equal(schedule[0].params?.quantity, '100');
  } finally {
    f.store.close();
  }
});

test('一张任务挂两张单，各要 100 只做了 100：两张都不算做完；做够 200 才算；今日把库存先分给先建的那张', () => {
  const f = madeFixture();
  try {
    const a = f.order(100),
      b = f.order(100);
    f.make([a.id, b.id], '100');
    assert.deepEqual([orderOf(f.store, a.id).status, orderOf(f.store, b.id).status], ['生产中', '生产中']);
    // 做好的 100 只只够一张：交期一样时先建的 a 分到库存能先发，b 还要再排 100
    assert.ok(!f.unscheduled(a.id) && f.unscheduled(b.id));
    const today = buildToday(f.store, '2026-10-27');
    assert.equal(today.todo.find((t) => t.id === a.id)?.group, 'ship');
    const bTodo = today.todo.find((t) => t.id === b.id);
    assert.ok(bTodo);
    assert.ok(bTodo.step.params);
    // 今日直接照这一步打开窗口：带着按分配算出的缺口，而不是点开后自己重算成“建送货单”
    assert.deepEqual([bTodo.group, bTodo.step.kind, bTodo.step.params.quantity], ['schedule', 'schedule', '100']);
    f.make([a.id, b.id], '100');
    assert.deepEqual([orderOf(f.store, a.id).status, orderOf(f.store, b.id).status], ['待发货', '待发货']);
  } finally {
    f.store.close();
  }
});

test('一张任务挂的另一张单改回了待确认：它的数量不算进要做的数，做够有效的那张就待发货', () => {
  const f = madeFixture();
  try {
    const a = f.order(100),
      b = f.order(50);
    f.make([a.id, b.id], '100');
    assert.equal(orderOf(f.store, a.id).status, '生产中', '两张都有效时要做 150');
    f.store.db.prepare("UPDATE orders SET status='待确认' WHERE id=?").run(b.id);
    f.flow.recomputeAfterMaintenance([a.id, b.id]);
    assert.deepEqual([orderOf(f.store, a.id).status, orderOf(f.store, b.id).status], ['待发货', '待确认']);
  } finally {
    f.store.close();
  }
});

test('多产品订单只完工部分产品时仍是生产中；全部完工后才待发货', () => {
  const f = stackFixture();
  try {
    const fb = f.ops.saveItem({ ...rawInput, name: '成品B', kind: 'finished', unit: '只', productId: f.pb.id }, actor),
      o = f.order([f.line(f.pa), f.line(f.pb)]);
    const a = f.task(o, f.pa);
    assert.equal(orderOf(f.store, o.id).status, '生产中');
    f.production(a.id, f.pa, f.fa, '100');
    assert.equal(orderOf(f.store, o.id).status, '生产中', '产品B尚未排产');
    const b = f.task(o, f.pb);
    f.production(b.id, f.pb, fb, '100');
    assert.equal(orderOf(f.store, o.id).status, '待发货');
  } finally {
    f.store.close();
  }
});

test('撤销完工或生产任务后，订单状态随单据回退；已取消的订单不被重算覆盖', () => {
  const f = stackFixture();
  try {
    const undo = (id: number) => f.flow.reverse(id, { version: f.flow.get(id).version, reason: '虚构冲销', acknowledged: true }, superActor());
    const o = f.order([f.line(f.pa)]),
      t = f.task(o, f.pa),
      done = f.production(t.id, f.pa, f.fa, '100');
    assert.equal(orderOf(f.store, o.id).status, '待发货');
    undo(done.id);
    assert.equal(f.flow.get(t.id, 'task').progress, 0);
    assert.equal(orderOf(f.store, o.id).status, '生产中');
    undo(t.id);
    assert.equal(orderOf(f.store, o.id).status, '已确认');
    const cancelled = f.order([f.line(f.pa)]),
      task = f.task(cancelled, f.pa);
    f.store.db.prepare("UPDATE orders SET status='已取消' WHERE id=?").run(cancelled.id);
    undo(task.id);
    assert.equal(orderOf(f.store, cancelled.id).status, '已取消');
  } finally {
    f.store.close();
  }
});

test('谁都不能手工设置派生状态（本机管理员也不能）；有关联单据的订单手工改成“已确认”保存后仍按单据算成生产中，取消照常', () => {
  const f = stackFixture();
  try {
    const o = f.order([f.line(f.pa)]),
      update = (status: string, who: Actor) => {
        const current = trackedOrderOf(f.store, o.id);
        return createBusinessService(f.store).execute(
          { entity: 'orders', action: 'update', id: String(o.id), input: { ...current, status, version: current.version } },
          { source: 'manual-ui', operatorId: who.id, actor: who },
        );
      };
    assert.throws(() => update('已发货', actor), /自动更新/);
    assert.throws(() => update('已发货', localAdministratorActor(superActor())), /自动更新/);
    f.task(o, f.pa);
    assert.equal(orderOf(f.store, o.id).status, '生产中');
    assert.equal(update('已确认', actor).status, '生产中', '有任务在做，手工改成已确认也盖不住');
    assert.equal(update('已取消', actor).status, '已取消', '取消是人工决定，重算不动它');
  } finally {
    f.store.close();
  }
});

test('已发数量、订料进度、改单核对：按有效单据算，改单核对只负责拦截', () => {
  const f = businessFixture();
  try {
    const lineId = f.order.lines[0].id;
    assert.equal(materialByOrder(f.store.db, [f.order.id]).has(f.order.id), false, '没关联采购的订单不在结果里');
    const previous = orderOf(f.store, f.order.id, true);
    assert.equal(orderEditGuard(f.store.db, previous), undefined, '没有关联单据不限制改单');

    f.arrival('100');
    const t = f.task('600');
    f.production(t.id, '600');
    f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: lineId, stockId: f.finished.id, quantity: '400' }] });
    const view = trackedOrderOf(f.store, f.order.id, true);
    assert.deepEqual([view.lines[0].shippedQuantity, view.lines[0].remainingQuantity, view.shippingProgress], [400, 600, '部分发货']);

    const guard = orderEditGuard(f.store.db, view);
    assert.ok(guard);
    const now = view,
      next = (change: Partial<{ customerId: number; status: typeof now.status; quantity: number }>) => ({
        customerId: change.customerId ?? now.customerId,
        status: change.status ?? now.status,
        lines: now.lines.map((l) => ({ ...l, unit: l.unit ?? '只', quantity: change.quantity ?? l.quantity })),
      });
    // 有生产、送货记录：普通修改不能改数量、不能改状态；不改这些的照常保存，明细原地改
    assert.throws(() => guard(next({ quantity: 2000 })), /不能改变客户、产品明细、规格、数量或单位/);
    assert.throws(() => guard(next({ status: '已确认' })), /状态由实际交付进度维护/);
    assert.doesNotThrow(() => guard(next({})));
    // 本机管理员把已出库的订单改成待确认：保存后按全部单据重算（做了 600、要 1000，还在生产中），不停在待确认
    createBusinessService(f.store).execute(
      { entity: 'orders', action: 'update', id: f.order.id, input: { ...now, status: '待确认' } },
      { source: 'manual-ui', operatorId: f.actor.id, superAdminMode: true, actor: f.actor },
    );
    assert.equal(orderOf(f.store, f.order.id).status, '生产中');
  } finally {
    f.store.close();
  }
});

test('删除完工单后订单状态跟着重算，保留库存时改写流水要留修订', () => {
  const f = businessFixture();
  try {
    f.arrival('100');
    const done = f.production(f.task('1000').id, '1000');
    assert.equal(orderOf(f.store, f.order.id).status, '待发货');
    const service = new DatabaseMaintenanceService(f.store);
    const selection = { module: 'production', items: [{ id: done.id, version: f.flow.get(done.id).version }], inventoryPolicy: 'preserve' };
    const revisions = () => count(f.store.db, 'SELECT count(*) FROM stock_movement_revisions');
    const before = revisions();
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: service.preview(selection, f.actor).digest }, f.actor, 's');
    assert.equal(orderOf(f.store, f.order.id).status, '生产中');
    assert.ok(revisions() > before, '保留的流水被改写，要留修订记录');
  } finally {
    f.store.close();
  }
});

test('删掉订单唯一的送货单、或把它改挂到别的订单，原订单按单据重算，不停在已发货', () => {
  // 删除：超级管理员按“库存改回”删掉这张送货单
  const f = flowFixture();
  try {
    f.stockIn('100');
    const o = f.order(100);
    const d = f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.finished.id, quantity: '100' }] });
    assert.equal(orderOf(f.store, o.id).status, '已发货');
    const svc = new DatabaseMaintenanceService(f.store),
      admin = superActor();
    const sel = { module: 'delivery', items: [{ id: d.id, version: f.flow.get(d.id).version }], inventoryPolicy: 'recalculate' };
    svc.delete({ ...sel, requestId: randomUUID(), deletionDigest: svc.preview(sel, admin).digest }, admin, 'b');
    assert.equal(orderOf(f.store, o.id).status, '已确认');
  } finally {
    f.store.close();
  }
  // 改挂：本机管理员更正 A 唯一的送货单，换挂到 B
  const local = localAdmin();
  const g = flowFixture(local);
  try {
    g.stockIn('200');
    const a = g.order(100),
      b = g.order(100);
    const sent = g.confirm('delivery', { customerId: g.customer.id, lines: [{ orderId: a.id, orderLineId: a.lines[0].id, stockId: g.finished.id, quantity: '100' }] });
    const v = { expectedVersion: g.flow.get(sent.id).version, reason: '虚构：挂错订单', lines: [{ index: 0, quantity: '100', orderLineId: b.lines[0].id }] };
    correctDocument(g.store, sent.id, { ...v, previewDigest: planCorrection(g.store, sent.id, v, local).previewDigest, requestId: randomUUID() }, local);
    assert.deepEqual([orderOf(g.store, a.id).status, orderOf(g.store, b.id).status], ['已确认', '已发货']);
  } finally {
    g.store.close();
  }
});

test('订单的三个共用判断：待确认、已取消不算数；还能送的只有已确认、生产中、待发货；已发货、已取消算结束', () => {
  const pick = (judge: (o: { status: string }) => boolean) => statuses.filter((status) => judge({ status }));
  assert.deepEqual(pick(effectiveOrder), ['已确认', '生产中', '待发货', '已发货']);
  assert.deepEqual(pick(deliverableOrder), ['已确认', '生产中', '待发货']);
  assert.deepEqual(pick(closedOrder), ['已发货', '已取消']);
  // 财务的 SQL 用状态清单，和函数是同一个口径
  assert.deepEqual(pick((o) => !effectiveOrder(o)), [...uncountedOrderStatuses]);
});
