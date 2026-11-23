import { sales } from '../server/sales/index.js';
import { trackOrders } from '../server/orders/index.js';
import { z } from 'zod';
import { pageActor, actor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessBase, damageOrderCost } from './business-base-fixture.js';
import { planStockDelivery } from '../shared/business/warehouse-delivery.js';
import { assistantFixture, ctxOf, toolsOf } from './assistant-fixture.js';
import type { Store as StoreType } from '../server/core/index.js';
import type { ToolContext } from '../server/assistant/tools/context.js';
import { readAs } from './read-result.js';

/** 试算结果里的行（各命令的键不同，按名字取） */
const rows = z.array(z.looseObject({}));
/** 按客户或产品分的组，每组逐行 */
const groups = z.array(z.looseObject({ lines: rows }));

/**
 * 两个虚构客户都在等同一种纸箱：甲 11-15 交 300 只，乙 11-20 交 400 只；成品库存 500 只。
 * 另一张甲的订单要 200 只另一种纸箱，没有库存。
 */
function setup(store: StoreType) {
  const base = businessBase(actor, store),
    { ops } = base;
  const a = base.customer({ name: '虚构甲电器', address: '虚构路1号' }),
    b = base.customer({ name: '虚构乙食品', address: '虚构路2号' });
  const box = base.product({ name: '虚构外箱' }),
    tray = base.product({ name: '虚构内托' });
  const order = (c: { id: number }, deliveryDate: string, p: { id: number; name: string }, quantity: number) =>
    base.order(c, [base.line(p, quantity, { productName: p.name, notes: '' })], { orderDate: '2026-11-01', deliveryDate, notes: '', costs: null });
  const oa = order(a, '2026-11-15', box, 300),
    ob = order(b, '2026-11-20', box, 400),
    oc = order(a, '2026-11-18', tray, 200);
  const stock = base.finished(box, { name: '虚构外箱' });
  base.finished(tray, { name: '虚构内托' });
  base.stockIn(stock, { quantity: '500', date: '2026-11-05' });
  return { ops, base, a, b, box, tray, oa, ob, oc, stock };
}

test('按交期先后把成品排满：先给交期早的甲，剩下给乙；指定只给乙也行', () => {
  const fx = assistantFixture();
  try {
    const f = setup(fx.store);
    const tools = toolsOf(fx.store);
    const plan = readAs(tools.read('delivery.plan', { stockIds: [f.stock.id] }, actor), { groups, contested: z.array(z.unknown()) });
    assert.deepEqual(
      plan.groups.map((g) => [g.customerName, g.lines.map((l) => l.quantity)]),
      [
        ['虚构甲电器', ['300']],
        ['虚构乙食品', ['200']],
      ],
    );
    assert.equal(plan.contested.length, 1, '两个客户在等，先问给谁');
    const onlyB = readAs(tools.read('delivery.plan', { stockIds: [f.stock.id], owners: [{ stockId: f.stock.id, customerId: f.b.id }] }, actor), { groups, contested: z.array(z.unknown()) });
    assert.deepEqual(onlyB.groups.map((g) => [g.customerName, g.lines[0].quantity]), [['虚构乙食品', '400']]);
    // 和窗口一样：指定了给谁的还列着，带上指定的客户
    assert.deepEqual(readAs(onlyB.contested[0], { owner: z.number() }).owner, f.b.id);
    // 和人工窗口同一份算法
    const items = f.base.flow.views.items().filter((i) => i.kind === 'finished');
    assert.deepEqual(
      planStockDelivery(items.filter((i) => i.id === f.stock.id), trackOrders(fx.store, sales(fx.store).orders())).map((g) => g.lines),
      plan.groups.map((g) => g.lines.map(({ orderNumber, productName, unit, ...l }) => l)),
    );
  } finally {
    fx.close();
  }
});

test('多选订单合并送货：没库存的说明原因；安排生产合成一张任务，数量 = 合计待发 − 库存可用', () => {
  const fx = assistantFixture();
  try {
    const f = setup(fx.store);
    const tools = toolsOf(fx.store);
    const delivery = readAs(tools.read('delivery.plan', { orderIds: [f.oa.id, f.ob.id, f.oc.id] }, actor), { missing: rows });
    // 按交期先后：内托那张 11-18，乙的外箱 11-20
    assert.deepEqual(delivery.missing.map((m) => [m.productName, m.quantity]), [
      ['虚构内托', '200'],
      ['虚构外箱', '200'],
    ]);
    const production = readAs(tools.read('production.plan', { orderIds: [f.oa.id, f.ob.id, f.oc.id] }, actor), { groups: rows });
    const box = readAs(production.groups.find((g) => g.productId === f.box.id), { orderIds: z.array(z.unknown()) });
    assert.deepEqual(box.orderIds.sort(), [f.oa.id, f.ob.id].sort(), '同一产品合成一张任务');
    assert.equal(box.needQuantity, '700');
    assert.equal(box.availableQuantity, '500');
    assert.equal(box.suggested, '200');
    assert.equal(readAs(production.groups.find((g) => g.productId === f.tray.id), {}).suggested, '200');
  } finally {
    fx.close();
  }
});

test('delivery.plan 按主键批量读：不全量加载订单和库存品再筛，结果和全量算的一致', (t) => {
  const fx = assistantFixture(),
    f = setup(fx.store);
  try {
    const tools = toolsOf(fx.store);
    // 另一个不相干的客户、产品和库存：不该被读进来，也不影响结果
    const other = f.base.product({ name: '虚构无关纸箱' });
    const unrelated = f.base.order(f.base.customer({ name: '虚构无关客户' }), [f.base.line(other, 1)]);
    const otherStock = f.base.finished(other, { name: '虚构无关纸箱' });
    const expectedByOrders = tools.read('delivery.plan', { orderIds: [f.oa.id, f.ob.id, f.oc.id] }, actor);
    const expectedByStock = tools.read('delivery.plan', { stockIds: [f.stock.id] }, actor);
    const views = tools.flow.views,
      items = views.items.bind(views);
    const seenItems: number[][] = [];
    damageOrderCost(fx.store, unrelated.id);
    t.mock.method(views, 'items', (include: boolean, ids?: Parameters<typeof views.items>[1]) => {
      assert.ok(ids !== undefined, '库存品要按编号读');
      seenItems.push([ids].flat());
      return items(include, ids);
    });
    try {
      assert.deepEqual(tools.read('delivery.plan', { orderIds: [f.oa.id, f.ob.id, f.oc.id] }, actor), expectedByOrders);
      assert.deepEqual(tools.read('delivery.plan', { stockIds: [f.stock.id] }, actor), expectedByStock);
    } finally {
      t.mock.restoreAll();
    }
    assert.ok(seenItems.every((ids) => !ids.includes(otherStock.id)), '没读无关的库存品');
  } finally {
    fx.close();
  }
});

test('delivery.plan 扣掉已经排在待送货单上的数量，和人工“安排送货”窗口一样', () => {
  const fx = assistantFixture(),
    f = setup(fx.store);
  try {
    const tools = toolsOf(fx.store);
    // 甲的 300 只已经排在一张待送货单上：可用库存剩 200，甲不用再排
    tools.flow.save(
      'delivery',
      {
        date: '2026-11-10',
        plannedDate: '2026-11-10',
        customerId: f.a.id,
        address: '虚构路1号',
        contact: '',
        phone: '',
        lines: [{ orderId: f.oa.id, orderLineId: f.oa.lines[0].id, stockId: f.stock.id, quantity: '300', notes: '' }],
        notes: '',
      },
      actor,
    );
    const byStock = readAs(tools.read('delivery.plan', { stockIds: [f.stock.id] }, actor), { groups });
    assert.deepEqual(
      byStock.groups.map((g) => [g.customerName, g.lines.map((l) => l.quantity)]),
      [['虚构乙食品', ['200']]],
    );
    const byOrders = readAs(tools.read('delivery.plan', { orderIds: [f.oa.id, f.ob.id] }, actor), { groups, missing: rows });
    assert.deepEqual(
      byOrders.groups.flatMap((g) => g.lines.map((l) => [l.orderId, l.quantity])),
      [[f.ob.id, '200']],
    );
    assert.deepEqual(byOrders.missing.map((m) => [m.orderId, m.quantity]), [[f.ob.id, '200']]);
  } finally {
    fx.close();
  }
});

test('delivery.plan 选的成品送不了时和窗口说同样的原因：没可用库存、没有订单在等', () => {
  const fx = assistantFixture(),
    f = setup(fx.store);
  try {
    const tools = toolsOf(fx.store);
    const tray = readAs(f.base.flow.views.items().find((i) => i.productId === f.tray.id), { id: z.number() });
    const idle = f.base.finished(f.base.product({ name: '虚构无单纸箱' }), { name: '虚构无单纸箱' });
    f.base.stockIn(idle, { quantity: '10', date: '2026-11-05' });
    const plan = readAs(tools.read('delivery.plan', { stockIds: [tray.id, idle.id] }, actor), { skipped: rows });
    const byStock = (s: { stockId?: unknown }) => (s.stockId === tray.id ? 0 : 1);
    assert.deepEqual(plan.skipped.sort((a, b) => byStock(a) - byStock(b)).map((s) => [s.stockId, s.reason]), [
      [tray.id, '可用库存为 0（没货，或已被待送货的送货单占用）'],
      [idle.id, '没有客户订单在等'],
    ]);
  } finally {
    fx.close();
  }
});

// 助手工具文件的直接测试
test('安排送货、安排生产的试算（tools/planning.ts）：参数二选一；选的订单不存在时什么也不排', async () => {
  const { Store } = await import('../server/core/index.js');
  const store = new Store(':memory:'),
    who = pageActor({ id: 'tool-direct', name: '虚构直测', permissions: ['business:edit'] });
  try {
    const ctx: ToolContext = ctxOf(store);
    assert.throws(() => ctx.tools.read('delivery.plan', {}, who), /传stockIds（成品库存）或orderIds（订单）其中一种/);
    const planned = z.looseObject({ groups: z.array(z.unknown()) });
    const delivery = planned.parse(ctx.tools.read('delivery.plan', { orderIds: [999] }, who));
    assert.deepEqual(delivery.groups, []);
    assert.equal(delivery.url, '#orders');
    const production = planned.parse(ctx.tools.read('production.plan', { orderIds: [999] }, who));
    assert.deepEqual(production.groups, []);
    assert.equal(production.url, '#orders');
  } finally {
    store.close();
  }
});
