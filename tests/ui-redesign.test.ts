// 界面重构的数据和渲染规则，只用内存虚构库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { buildToday } from '../server/business/workbench.js';
import { orderChain } from '../shared/order-chain.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';
import Navigation from '../src/Navigation.js';
import Combobox from '../src/ui/Combobox.js';
import { FlowService } from '../server/flow/service.js';
import { groupIssues } from '../src/import/ReviewIssues.js';
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
