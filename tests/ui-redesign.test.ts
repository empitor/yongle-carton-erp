// 界面重构的数据和渲染规则，只用内存虚构库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { buildToday } from '../server/business/workbench.js';
import { orderChain } from '../shared/order-chain.js';
import { orderNextSteps, purchaseNextSteps } from '../shared/order-next-step.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';
import Navigation from '../src/Navigation.js';
import Combobox from '../src/ui/Combobox.js';
import { FlowService } from '../server/flow/service.js';
import { groupIssues } from '../src/import/ReviewIssues.js';
import { allocateShipments } from '../src/ReadyToShip.js';
import { pageRows } from '../server/paging.js';
import { createApp } from '../server/app.js';
import { randomUUID } from 'node:crypto';

const actor: any = { id: 'ui', name: '虚构操作员', permissions: ['business:edit'] };
const states = (order: any) =>
  Object.fromEntries(orderChain(order, '2026-11-05').map((n) => [n.key, n.state]));

test('履约链按事实表达进度，逾期标在卡住的环节，没有依据的环节不算完成', () => {
  assert.deepEqual(states({ status: '草稿', deliveryDate: '2026-01-01' }), {
    order: 'active',
    material: 'na',
    production: 'todo',
    delivery: 'todo',
  });
  assert.equal(states({ status: '已确认', deliveryDate: '2026-12-01' }).production, 'todo');
  assert.equal(states({ status: '已确认', deliveryDate: '2026-11-01' }).production, 'blocked');
  assert.equal(states({ status: '生产中', deliveryDate: '2026-12-01' }).production, 'active');
  const shipping = states({
    status: '待发货',
    deliveryDate: '2026-11-01',
    shippingProgress: '部分发货',
  });
  assert.equal(shipping.production, 'done');
  assert.equal(shipping.delivery, 'blocked');
  assert.equal(
    states({ status: '已发货', deliveryDate: '2026-11-01', shippingProgress: '已发完' }).delivery,
    'done',
  );
  assert.equal(states({ status: '已取消', deliveryDate: '2026-11-01' }).production, 'na');
  assert.equal(
    states({ status: '已确认', deliveryDate: '2026-12-01', materialProgress: 'partial' }).material,
    'active',
  );
});

test('今日队列把真实记录分到逾期、未排产、待下单和到货待登记', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构箱' }));
  const order = (deliveryDate: string, status = '已确认') =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-01',
        deliveryDate,
        status,
        notes: '',
        costs: null,
        lines: [
          {
            productId: product.id,
            productName: product.name,
            specification: '',
            quantity: 100,
            unit: '只',
            unitPriceCents: 100,
          },
        ],
      }),
    );
  const late = order('2026-11-01'),
    upcoming = order('2026-12-01');
  order('2026-11-01', '草稿');
  const supplier = ops.saveSupplier({ name: '虚构供应商' }, actor);
  const purchase = (status: string, expectedDate: string) =>
    ops.savePurchase(
      {
        supplierId: supplier.id,
        customerOrderId: upcoming.id,
        orderDate: '2026-10-01',
        expectedDate,
        status,
        notes: '',
        lines: [{ name: '虚构纸板', unit: '张', quantity: '100', unitPrice: '1.5' }],
      },
      actor,
    );
  const toOrder = purchase('待订货', '2026-12-01'),
    due = purchase('已订货', '2026-11-03');
  purchase('已订货', '2026-12-01');
  const today = buildToday(store, '2026-11-05');
  assert.deepEqual(
    today.overdue.map((o) => [o.id, o.lateDays]),
    [[late.id, 4]],
  );
  // 已逾期的不重复出现在未排产里，草稿不算待办。
  assert.deepEqual(
    today.unscheduled.map((o) => o.id),
    [upcoming.id],
  );
  assert.deepEqual(
    today.toOrder.map((p) => p.id),
    [toOrder.id],
  );
  assert.deepEqual(
    today.arrivalsDue.map((p) => p.id),
    [due.id],
  );
  assert.equal(store.order(upcoming.id)!.materialProgress, 'pending');
  assert.equal(store.order(late.id)!.materialProgress, 'none');
  store.close();
});

test('导航按页面和查询参数高亮唯一入口，不再有归档之外的一级技术菜单', () => {
  const selected = (page: string, route: string) =>
    renderToStaticMarkup(h(Navigation, { page, route, navigate: () => {} })).match(
      /aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)/g,
    );
  for (const [page, route, label] of [
    ['warehouse', '#warehouse', '库存'],
    ['warehouse', '#warehouse?kind=finished', '库存'],
    ['warehouse', '#warehouse?arrivals=1', '到货'],
    ['warehouse', '#warehouse?deliveries=1&kind=finished', '送货'],
    ['warehouse', '#warehouse?flow=1', '流水'],
    ['production', '#production', '生产任务'],
    ['production', '#production?view=production', '完工记录'],
  ]) {
    const matched = selected(page, route);
    assert.equal(matched?.length, 1, route);
    assert.ok(matched![0].endsWith(label), route + ' -> ' + matched![0]);
  }
  const html = renderToStaticMarkup(
    h(Navigation, { page: 'dashboard', navigate: () => {}, inboxCount: 3 }),
  );
  assert.match(html, /nav-count">3</);
});

test('可搜索下拉未选择时才要求必填，已选值显示名称', () => {
  const options = [{ value: '1', label: '虚构客户甲' }];
  const empty = renderToStaticMarkup(
    h(Combobox, { value: '', options, onChange: () => {}, ariaLabel: '客户', required: true }),
  );
  assert.match(empty, /required/);
  const chosen = renderToStaticMarkup(
    h(Combobox, { value: '1', options, onChange: () => {}, ariaLabel: '客户', required: true }),
  );
  assert.doesNotMatch(chosen, /required/);
  assert.match(chosen, /value="虚构客户甲"/);
});

test('库存可用量扣除送货和生产草稿，确认后转为实际库存，在途只算已订货未到齐', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store),
    customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构箱' })),
    stock = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: product.id }, actor);
  ops.move(
    stock.id,
    { action: 'in', quantity: '100', date: '2026-10-01', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: stock.version },
    actor,
  );
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-30',
      status: '已确认',
      notes: '',
      costs: null,
      lines: [{ productId: product.id, productName: product.name, specification: '', quantity: 80, unit: '只', unitPriceCents: 100 }],
    }),
  );
  const draft = flow.save(
    'delivery',
    { date: '2026-10-06', customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '80' }] },
    actor,
  );
  const item = () => ops.repo.items().find((i) => i.id === stock.id);
  assert.equal(item().balanceUnits, 100000);
  assert.equal(item().reservedUnits, 80000);
  assert.equal(item().availableUnits, 20000);
  const preview = flow.preview(draft.id, actor, 's');
  flow.confirm(draft.id, { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true }, actor, 's');
  assert.equal(item().balanceUnits, 20000);
  assert.equal(item().reservedUnits, 0);
  assert.equal(item().availableUnits, 20000);
  const supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
    raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor),
    purchase = (status: string) =>
      ops.savePurchase(
        { supplierId: supplier.id, orderDate: '2026-10-01', status, notes: '', lines: [{ name: '虚构纸板', stockItemId: raw.id, unit: '张', quantity: '50' }] },
        actor,
      );
  purchase('待订货');
  purchase('已订货');
  assert.equal(ops.repo.items().find((i) => i.id === raw.id).onOrderUnits, 50000);
  store.close();
});

test('可发货合并按勾选先后分配同一成品的可用量，合计不超过可用', () => {
  const candidates = [
    { key: 'a', stockId: 1, remaining: 80, available: 100000 },
    { key: 'b', stockId: 1, remaining: 50, available: 100000 },
    { key: 'c', stockId: 1, remaining: 10, available: 100000 },
    { key: 'd', stockId: 2, remaining: 30, available: 20000 },
  ];
  const first = allocateShipments(candidates, ['a', 'b', 'd']);
  assert.deepEqual(Object.fromEntries(first.allocated), { a: 80000, b: 20000, d: 20000 });
  assert.equal(first.left.get(1), 0);
  assert.equal(first.left.get(2), 0);
  // 用尽后再勾选也分不到数量；取消前面的行，余量释放给后面的行。
  assert.equal(allocateShipments(candidates, ['a', 'b', 'c']).allocated.has('c'), false);
  assert.deepEqual(Object.fromEntries(allocateShipments(candidates, ['b', 'c']).allocated), {
    b: 50000,
    c: 10000,
  });
  assert.equal(allocateShipments(candidates, ['b', 'c']).left.get(1), 40000);
});

test('列表分页：不带页码保持全量，页码超出落到最后一页，排序跨页稳定', () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ id, number: 'N' + id, deliveryDate: '2026-11-0' + (6 - id) }));
  assert.deepEqual(pageRows(rows, {}), { rows, filteredRecords: 5 });
  const second = pageRows(rows, { page: '2', pageSize: '2', sort: 'recent' });
  assert.deepEqual(second.rows.map((r) => r.id), [3, 2]);
  assert.equal(second.filteredRecords, 5);
  assert.equal(second.page, 2);
  const beyond = pageRows(rows, { page: '99', pageSize: '2', sort: 'oldest' });
  assert.equal(beyond.page, 3);
  assert.deepEqual(beyond.rows.map((r) => r.id), [5]);
  assert.deepEqual(pageRows(rows, { page: '1', pageSize: '2', sort: 'due' }).rows.map((r) => r.id), [5, 4]);
  assert.equal(pageRows([], { page: '3' }).page, 1);
  assert.throws(() => pageRows(rows, { page: '1', pageSize: '1000' }));
  assert.throws(() => pageRows(rows, { page: '1', sort: '任意' }));
});

test('HTTP 分页：统计按完整筛选结果，不带页码的调用方仍拿到全量，采购可按主键读取', async () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构箱' })),
    supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
    stock = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只' }, actor);
  const orders = [1, 2, 3].map((n) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-0' + n,
        deliveryDate: '2026-12-0' + n,
        status: '已确认',
        notes: '',
        costs: null,
        lines: [
          { productId: product.id, productName: product.name, specification: '', quantity: 10, unit: '只', unitPriceCents: 100 },
        ],
      }),
    ),
  );
  const purchases = [1, 2, 3].map(() =>
    ops.savePurchase(
      { supplierId: supplier.id, orderDate: '2026-10-01', status: '已订货', notes: '', lines: [{ name: '虚构纸板', unit: '张', quantity: '5' }] },
      actor,
    ),
  );
  for (let n = 0, version = stock.version; n < 3; n++, version++)
    ops.move(
      stock.id,
      { action: 'in', quantity: '1', date: '2026-10-01', notes: '虚构', acknowledged: true, requestId: randomUUID(), expectedVersion: version },
      actor,
    );
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const get = async (path: string) => {
    const r = await fetch('http://127.0.0.1:' + (server.address() as any).port + '/api' + path);
    return { status: r.status, body: await r.json() };
  };
  try {
    const paged = (await get('/orders?withMetrics=1&page=2&pageSize=2&sort=recent')).body;
    assert.deepEqual(paged.rows.map((o: any) => o.id), [orders[0].id]);
    assert.equal(paged.filteredRecords, 3);
    assert.equal(paged.totalRecords, 3);
    assert.equal(paged.page, 2);
    assert.equal(paged.metrics.total, 3);
    assert.equal((await get('/orders')).body.length, 3);
    assert.equal((await get('/orders?withMetrics=1')).body.rows.length, 3);
    const paid = (await get('/purchases?withMetrics=1&page=1&pageSize=1&sort=oldest')).body;
    assert.deepEqual(paid.rows.map((p: any) => p.id), [purchases[0].id]);
    assert.equal(paid.filteredRecords, 3);
    assert.equal(paid.metrics.total, 3);
    assert.deepEqual(paid.suppliers, [{ id: supplier.id, name: '虚构供应商' }]);
    assert.equal((await get('/purchases/' + purchases[1].id)).body.id, purchases[1].id);
    assert.equal((await get('/purchases/999999')).status, 404);
    const moves = (await get('/warehouse/movements?withMetrics=1&page=1&pageSize=2')).body;
    assert.equal(moves.rows.length, 2);
    assert.equal(moves.filteredRecords, 3);
    assert.equal(moves.metrics.length >= 1, true);
    assert.equal((await get('/warehouse/movements')).body.length, 3);
    assert.equal((await get('/orders?withMetrics=1&page=1&pageSize=9999')).status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('下一步按事实判断：草稿先确认，库存够先送货，有任务先完工，没排产才安排生产', () => {
  const line = (id: number, productId: number, remainingQuantity: number) => ({
    id,
    productId,
    productName: '虚构箱' + id,
    quantity: remainingQuantity,
    remainingQuantity,
    unit: '只',
  });
  const order = (lines: any[], status = '已确认') => ({ id: 9, status, lines });
  const stock = (productId: number, availableUnits: number) => ({ productId, unit: '只', availableUnits });
  const kinds = (o: any, r: any) => orderNextSteps(o, r).steps.map((s) => s.kind);
  const empty = { tasks: [], stocks: [], deliveries: [], purchases: [] };

  assert.deepEqual(kinds(order([line(1, 1, 10)], '草稿'), null), ['confirm']);
  assert.equal(orderNextSteps(order([line(1, 1, 10)], '已取消'), empty).done, '订单已取消');
  assert.equal(orderNextSteps(order([line(1, 1, 0)]), empty).done, '已全部发货');
  assert.deepEqual(kinds(order([line(1, 1, 10)]), empty), ['schedule']);
  // 库存够发：先建送货单，不再要求排产
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, stocks: [stock(1, 10000)] }), ['delivery']);
  // 库存只够一部分：先排产，送货排在后面
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, stocks: [stock(1, 4000)] }), ['schedule', 'delivery']);
  // 单位不同的库存不算
  assert.deepEqual(
    kinds(order([line(1, 1, 10)]), { ...empty, stocks: [{ productId: 1, unit: '张', availableUnits: 99000 }] }),
    ['schedule'],
  );
  const task = { id: 5, number: 'SC-1', productId: 1, quantity: '10', completed: '4', unit: '只', status: 'confirmed' };
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, tasks: [task] }), ['complete']);
  assert.deepEqual(orderNextSteps(order([line(1, 1, 10)]), { ...empty, tasks: [task] }).steps[0].params, { task: '5' });
  // 已取消的任务不算排产；草稿任务要先确认
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, tasks: [{ ...task, status: 'cancelled' }] }), ['schedule']);
  assert.deepEqual(kinds(order([line(1, 1, 10)]), { ...empty, tasks: [{ ...task, status: 'draft' }] }), ['confirm_task']);
  // 送货草稿最优先
  const draft = { id: 7, number: 'SH-1', status: 'draft' };
  assert.equal(kinds(order([line(1, 1, 10)]), { ...empty, deliveries: [draft] })[0], 'confirm_delivery');
  const noted = orderNextSteps(order([line(1, 1, 10)]), {
    ...empty,
    purchases: [
      { number: 'CG-1', businessStatus: '待订货' },
      { number: 'CG-2', businessStatus: '已订货', arrivalProgress: '部分到货' },
      { number: 'CG-3', businessStatus: '已订货', arrivalProgress: '全部到货' },
      { number: 'CG-4', businessStatus: '已取消' },
    ],
  }).notes;
  assert.deepEqual(noted, ['采购 CG-1 还没有下单', '采购 CG-2 还没到齐']);

  assert.equal(purchaseNextSteps({ businessStatus: '待订货' }).steps[0].kind, 'export');
  assert.equal(purchaseNextSteps({ id: 1, businessStatus: '已订货', arrivalProgress: '部分到货' }).steps[0].kind, 'arrival');
  assert.equal(purchaseNextSteps({ businessStatus: '已订货', arrivalProgress: '全部到货' }).done, '已全部到货');
});

test('疑点清单合并相同提示，必须处理的排在前面', () => {
  const groups = groupIssues(
    [
      { path: 'a', message: '字段待核对' },
      { path: 'b', message: '字段待核对' },
      { path: 'products.optional', message: '资料可后补' },
      { path: 'c', message: '金额不符', severity: 'error' },
    ],
    ['模型提示', '字段待核对'],
  );
  assert.deepEqual(
    groups.map((g) => [g.message, g.error, g.count]),
    [
      ['金额不符', true, 1],
      ['字段待核对', false, 2],
      ['模型提示', false, 1],
    ],
  );
});
