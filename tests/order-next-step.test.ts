// 订单和采购单的“下一步”（shared/business/order-next-step.ts）、履约链（order-chain.ts）、订料预填（src/operations/purchase-seed.ts）：
// 只按已有单据和库存判断。前面是纯函数，后面几条按真实单据算（待送货单占的数量）。全部是虚构数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderNextSteps, purchaseNextSteps } from '../shared/business/order-next-step.js';
import { orderChain } from '../shared/business/order-chain.js';
import { planOrderDelivery, pendingByOrderLine } from '../shared/business/warehouse-delivery.js';
import { planProductionForOrders } from '../shared/business/production-plan.js';
import { relatedBusiness } from '../server/business/related-business.js';
import { buildToday } from '../server/business/workbench.js';
import {
  boardReference,
  previousSingleProductOrder,
  purchaseSeedFromOrder,
  withoutEditorFields,
} from '../src/operations/purchase-seed.js';
import { flowFixture } from './flow-fixture.js';
import { stackActor, stackFixture } from './stack-fixture.js';

type StepOrder = Parameters<typeof orderNextSteps>[0];
type Related = Parameters<typeof orderNextSteps>[1];

const line = (id: number, productId: number, remainingQuantity: number) => ({
  id,
  productId,
  productName: '虚构箱' + productId,
  quantity: remainingQuantity,
  remainingQuantity,
  unit: '只',
});
const order = (lines: NonNullable<StepOrder['lines']>, extra: Partial<StepOrder> = {}): StepOrder => ({
  id: 9,
  status: '已确认',
  materialProgress: 'none',
  lines,
  ...extra,
});
const empty = { tasks: [], stocks: [], deliveries: [], purchases: [] };
const kinds = (o: StepOrder, r: Related) => orderNextSteps(o, r).steps.map((s) => s.kind);

test('安排订料：要生产、没关联采购单的订单先订料，再安排生产', () => {
  const next = orderNextSteps(order([line(1, 1, 10)]), empty);
  assert.deepEqual(
    next.steps.map((s) => s.kind),
    ['purchase', 'schedule'],
  );
  const step = next.steps[0];
  assert.equal(step.label, '安排订料');
  assert.deepEqual(step.params, { order: '9', products: '1' });
  // 生产中的订单也提示
  assert.deepEqual(kinds(order([line(1, 1, 10)], { status: '生产中' }), empty), ['purchase', 'schedule']);
});

test('安排订料：有有效采购、或服务端说已关联采购时不提示；没有这项事实也不提示', () => {
  const active = { number: 'CG-虚构1', businessStatus: '已订货', arrivalProgress: '未到货' };
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, purchases: [active] }), ['schedule']);
  assert.deepEqual(kinds(order([line(1, 1, 10)], { materialProgress: 'pending' }), empty), ['schedule']);
  assert.deepEqual(kinds(order([line(1, 1, 10)], { materialProgress: undefined }), empty), ['schedule']);
  // 关联记录还没读到（purchases 不是数组）时不猜
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { tasks: [], stocks: [], deliveries: [] }), ['schedule']);
  // 只有已取消或已归档的采购，等于没有关联采购
  assert.deepEqual(
    kinds(order([line(1, 1, 10)]), {
      ...empty,
      purchases: [
        { number: 'CG-虚构2', businessStatus: '已取消' },
        { number: 'CG-虚构3', businessStatus: '已订货', archived: true },
      ],
    })[0],
    'purchase',
  );
});

test('安排订料：库存够发、已经开工、待确认或已发完的订单不提示', () => {
  const stock = (productId: number, availableUnits: number) => ({ productId, unit: '只', availableUnits });
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, stocks: [stock(1, 10000)] }), ['delivery']);
  // 只够发一部分：还要生产，所以还要订料
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, stocks: [stock(1, 4000)] }), [
    'purchase',
    'schedule',
    'delivery',
  ]);
  const task = { id: 5, number: 'SC-虚构', productId: 1, quantity: '10', completed: '4', unit: '只', status: 'confirmed' };
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, tasks: [task] }), ['complete']);
  // 任务还没开工（完工 0）时纸板可能还没着落，仍然提示订料
  assert.ok(kinds(order([line(1, 1, 10)]), { ...empty, tasks: [{ ...task, completed: '0' }] }).includes('purchase'));
  assert.deepEqual(kinds(order([line(1, 1, 10)], { status: '待确认' }), null), ['confirm']);
  assert.equal(kinds(order([line(1, 1, 10)], { status: '待发货' }), empty).includes('purchase'), false);
  assert.equal(orderNextSteps(order([line(1, 1, 0)]), empty).done, '已全部发货');
});

test('安排订料：多产品只带还要生产的那几种，同一产品分几行只算一次', () => {
  const next = orderNextSteps(order([line(1, 1, 10), line(2, 2, 5), line(3, 2, 5)]), {
    ...empty,
    stocks: [{ productId: 1, availableUnits: 10000 }],
  });
  const step = next.steps.find((s) => s.kind === 'purchase');
  assert.ok(step);
  assert.equal(step.params?.products, '2');
  assert.match(step.detail || '', /虚构箱2/);
  assert.doesNotMatch(step.detail || '', /虚构箱1/);
});

test('预填采购单：只带产品的材质和楞型，尺寸、张数、单价留空', () => {
  const o = { id: 9, lines: [line(1, 1, 10), line(2, 2, 5)] };
  const products = [
    { id: 1, name: '虚构外箱', material: 'K=A', flute: 'BC' },
    { id: 2, name: '虚构内盒', material: '', flute: 'E' },
  ];
  const seed = purchaseSeedFromOrder(o, products, [1, 2]);
  assert.equal(seed.customerOrderId, 9);
  assert.equal(seed.lines.length, 2);
  assert.equal(seed.lines[0].name, '虚构外箱 纸板');
  assert.equal(seed.lines[0].material, 'K=A');
  assert.equal(seed.lines[0].flute, 'BC');
  for (const l of seed.lines) {
    assert.equal(l.quantity, '');
    assert.equal(l.unitPrice, null);
    assert.equal(l.length, null);
    assert.equal(l.width, null);
    assert.equal(l.dimensionUnit, null);
    assert.equal(l.stockItemId, null);
    assert.equal(l.unit, '张');
    assert.equal('reference' in l, false);
  }
  assert.equal(seed.lines[1].material, '');
  // 不传产品时按订单里的产品各一行
  assert.equal(purchaseSeedFromOrder(o, products, []).lines.length, 2);
});

test('参考上次：只认同一产品的单产品订单、有效且只有一行、尺寸齐全的采购', () => {
  const current = { id: 9, lines: [line(1, 1, 10)] };
  const orders = [
    current,
    { id: 3, orderDate: '2026-09-01', status: '已发货', materialProgress: 'done', lines: [line(1, 1, 10)] },
    { id: 5, orderDate: '2026-10-01', status: '已发货', materialProgress: 'done', lines: [line(1, 1, 10)] },
    // 多产品订单分不清采购明细对应哪种产品，不用
    { id: 7, orderDate: '2026-10-20', status: '已发货', materialProgress: 'done', lines: [line(1, 1, 5), line(2, 2, 5)] },
    // 没关联过采购的不用
    { id: 8, orderDate: '2026-10-25', status: '已发货', materialProgress: 'none', lines: [line(1, 1, 5)] },
    { id: 6, orderDate: '2026-10-30', status: '已取消', materialProgress: 'done', lines: [line(1, 1, 5)] },
  ];
  assert.equal(previousSingleProductOrder(orders, current, 1)?.id, 5);
  assert.equal(previousSingleProductOrder(orders, current, 2), undefined);

  const spec = { length: 1250, width: 1000, dimensionUnit: 'mm', material: 'K=A', flute: 'BC' };
  assert.deepEqual(
    boardReference([
      { id: 1, number: 'CG-虚构旧', orderDate: '2026-09-01', businessStatus: '全部到货', lines: [{ ...spec, length: 900 }] },
      { id: 2, number: 'CG-虚构新', orderDate: '2026-10-01', businessStatus: '已订货', lines: [spec] },
      { id: 3, number: 'CG-虚构取消', orderDate: '2026-10-02', businessStatus: '已取消', lines: [spec] },
    ]),
    { number: 'CG-虚构新', ...spec },
  );
  assert.equal(boardReference([{ id: 4, number: 'CG-虚构两行', businessStatus: '已订货', lines: [spec, spec] }]), null);
  assert.equal(
    boardReference([{ id: 5, number: 'CG-虚构无单位', businessStatus: '已订货', lines: [{ ...spec, dimensionUnit: null }] }]),
    null,
  );
  assert.equal(boardReference(undefined), null);

  const seed = purchaseSeedFromOrder(current, [{ id: 1, name: '虚构外箱', material: '', flute: '' }], [1], {
    1: { number: 'CG-虚构新', ...spec },
  });
  const l = seed.lines[0];
  assert.equal(l.reference, '参考上次 CG-虚构新');
  assert.equal(l.length, 1250);
  assert.equal(l.width, 1000);
  assert.equal(l.dimensionUnit, 'mm');
  assert.equal(l.material, 'K=A', '产品没写材质时用上次的');
  assert.equal(l.quantity, '', '张数仍然留空');
  assert.equal(l.unitPrice, null, '不带上次的单价');
  // 提交前去掉只用于显示的“参考上次”
  assert.equal('reference' in withoutEditorFields(seed.lines)[0], false);
});

test('下一步：已取消的订单不再给步骤；完工那一步带任务编号，已取消的任务不算排产；有待送货单时先把它送出去；采购没下单、没到齐写进提示', () => {
  const plain = (lines: NonNullable<StepOrder['lines']>, status = '已确认') => order(lines, { status, materialProgress: undefined });
  assert.equal(orderNextSteps(plain([line(1, 1, 10)], '已取消'), empty).done, '订单已取消');
  const task = { id: 5, number: 'SC-1', productId: 1, quantity: '10', completed: '4', unit: '只', status: 'confirmed' };
  assert.deepEqual(orderNextSteps(plain([line(1, 1, 10)]), { ...empty, tasks: [task] }).steps[0].params, { task: '5' });
  assert.deepEqual(kinds(plain([line(1, 1, 10)]), { ...empty, tasks: [{ ...task, status: 'cancelled' }] }), ['schedule']);
  const pending = { id: 7, number: 'SH-1', status: 'draft' };
  assert.equal(kinds(plain([line(1, 1, 10)]), { ...empty, deliveries: [pending] })[0], 'confirm_delivery');
  const noted = orderNextSteps(plain([line(1, 1, 10)]), {
    ...empty,
    purchases: [
      { number: 'CG-1', businessStatus: '待订货' },
      { number: 'CG-2', businessStatus: '已订货', arrivalProgress: '部分到货' },
      { number: 'CG-3', businessStatus: '已订货', arrivalProgress: '全部到货' },
      { number: 'CG-4', businessStatus: '已取消' },
    ],
  }).notes;
  assert.deepEqual(noted, ['采购 CG-1 还没有下单', '采购 CG-2 还没到齐']);
  assert.equal(purchaseNextSteps({ id: 1, businessStatus: '待订货' }).steps[0].kind, 'export');
  assert.equal(purchaseNextSteps({ id: 1, businessStatus: '已订货', arrivalProgress: '部分到货' }).steps[0].kind, 'arrival');
  assert.equal(purchaseNextSteps({ id: 1, businessStatus: '已订货', arrivalProgress: '全部到货' }).done, '已全部到货');
});

test('多产品订单里，已经做好且库存够的产品不再提醒排产', () => {
  const next = orderNextSteps(order([line(1, 1, 100), line(2, 2, 50)], { status: '生产中', materialProgress: undefined }), {
    ...empty,
    tasks: [
      { id: 1, number: 'SC-1', productId: 1, quantity: '100', completed: '100', unit: '只', status: 'confirmed' },
      { id: 2, number: 'SC-2', productId: 2, quantity: '50', completed: '10', unit: '只', status: 'confirmed' },
    ],
    stocks: [{ productId: 1, availableUnits: 100000 }],
  });
  assert.equal(next.steps.some((s) => s.kind === 'schedule'), false, 'A 已做好够发，B 还在做');
  assert.ok(next.steps.some((s) => s.kind === 'delivery'));
});

test('履约链按事实表达进度，逾期标在卡住的环节，没有依据的环节不算完成', () => {
  const states = (o: Parameters<typeof orderChain>[0]) => Object.fromEntries(orderChain(o, '2026-11-05').map((n) => [n.key, n.state]));
  assert.deepEqual(states({ status: '待确认', deliveryDate: '2026-01-01' }), { order: 'active', material: 'na', production: 'todo', delivery: 'todo' });
  assert.equal(states({ status: '已确认', deliveryDate: '2026-12-01' }).production, 'todo');
  assert.equal(states({ status: '已确认', deliveryDate: '2026-11-01' }).production, 'blocked');
  assert.equal(states({ status: '生产中', deliveryDate: '2026-12-01' }).production, 'active');
  const shipping = states({ status: '待发货', deliveryDate: '2026-11-01', shippingProgress: '部分发货' });
  assert.deepEqual([shipping.production, shipping.delivery], ['done', 'blocked']);
  assert.equal(states({ status: '已发货', deliveryDate: '2026-11-01', shippingProgress: '已发完' }).delivery, 'done');
  assert.equal(states({ status: '已取消', deliveryDate: '2026-11-01' }).production, 'na');
  assert.equal(states({ status: '已确认', deliveryDate: '2026-12-01', materialProgress: 'partial' }).material, 'active');
});

test('待送货单已经占了的数量不算缺口：有待送货单的不再提醒排产，交期晚的那张分到剩下的库存能发', () => {
  const f = stackFixture();
  try {
    const a = f.order([f.line(f.pa, 100)]),
      b = f.order([f.line(f.pa, 50)]);
    f.production(null, f.pa, f.fa, '150');
    const arranged = f.store.order(a.id);
    assert.ok(arranged);
    // a 已经安排了一张待送货单，把 100 只占住了（可用库存只剩 50）
    f.flow.save(
      'delivery',
      { date: '2026-10-05', customerId: f.customer.id, lines: [{ orderId: a.id, orderLineId: arranged.lines[0].id, stockId: f.fa.id, quantity: '100' }] },
      stackActor,
    );
    const steps = (id: number) => {
      const current = f.store.order(id);
      assert.ok(current);
      return orderNextSteps(current, relatedBusiness(f.store, 'orders', id)).steps.map((x) => x.kind);
    };
    assert.deepEqual(steps(a.id), ['confirm_delivery'], '只剩把待送货单送出去，不提醒排产');
    assert.ok(steps(b.id).includes('delivery') && !steps(b.id).includes('schedule'), 'b 用剩下的 50 只就能发');
    const today = buildToday(f.store, '2026-10-06');
    assert.equal(today.todo.find((t) => t.id === a.id), undefined, 'a 只在“可发货”的待送货单那一行出现');
    assert.equal(today.todo.find((t) => t.id === b.id)?.group, 'ship');
    assert.equal(today.draftDeliveries.length, 1);
  } finally {
    f.store.close();
  }
});

test('批量安排送货、安排生产扣掉已经排在待送货单上的数量，和单张下一步一致', () => {
  const f = flowFixture();
  try {
    const o = f.order(100);
    f.stockIn('60');
    f.draft('delivery', { customerId: f.customer.id, lines: [{ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.finished.id, quantity: '60' }] });
    const rel = relatedBusiness(f.store, 'orders', o.id);
    const ord = f.store.order(o.id);
    assert.ok(ord);
    // 生产：订单 100、待送货 60、可用 0 → 还要做 40
    assert.deepEqual(planProductionForOrders([ord], [rel], f.ops.repo.items()).groups.map((g) => g.suggested), ['40']);
    const scheduled = orderNextSteps(ord, rel).steps.filter((s) => s.kind === 'schedule');
    assert.deepEqual(scheduled.map((s) => {
      assert.ok(s.params);
      return s.params.quantity;
    }), ['40']);
    // 送货：再入库 200，只再排剩下的 40，不会排到 160
    f.stockIn('200');
    const finished = f.ops.repo.items().filter((i) => i.kind === 'finished');
    const current = f.store.order(o.id);
    assert.ok(current);
    const plan = planOrderDelivery([current], finished, pendingByOrderLine(rel?.deliveries || []));
    assert.deepEqual(plan.groups.flatMap((g) => g.lines.map((l) => l.quantity)), ['40']);
  } finally {
    f.store.close();
  }
});
