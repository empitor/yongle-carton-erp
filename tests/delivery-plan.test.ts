import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOrderDelivery, deliveryPlan, overOrderLines } from '../shared/business/index.js';

const line = (id: number, productId: number, quantity: number, extra: { specification?: string; remainingQuantity?: number } = {}) => ({
  id,
  productId,
  productName: '虚构箱' + productId,
  quantity,
  remainingQuantity: quantity,
  unit: '只',
  ...extra,
});
const order = (id: number, customerId: number, deliveryDate: string | null, lines: ReturnType<typeof line>[], extra: { status?: string; archived?: boolean } = {}) => ({
  id,
  number: 'DD-' + id,
  customerId,
  status: extra.status ?? '已确认',
  archived: extra.archived ?? false,
  deliveryDate,
  lines,
});

test('按订单排送货：交期早的先分可用量，扣掉已在待送货单上的；没货的进缺口，不能送的订单说清原因；一个客户一张送货单', () => {
  const stocks = [
    { id: 7, productId: 1, availableUnits: 150_000 },
    { id: 8, productId: 2, availableUnits: 20_000 },
  ];
  const orders = [
    order(1, 1, '2026-11-05', [line(11, 1, 100)]),
    order(2, 2, '2026-11-01', [line(21, 1, 80), line(22, 2, 30)]),
    order(3, 1, null, [line(31, 1, 10)]),
    order(4, 1, '2026-11-02', [line(41, 1, 5)], { status: '待确认' }),
    order(5, 1, '2026-11-02', [line(51, 1, 5)], { archived: true }),
    order(6, 1, '2026-11-02', [line(61, 1, 5)], { status: '已取消' }),
    order(7, 1, '2026-11-02', [line(71, 1, 5)], { status: '已发货' }),
    order(8, 1, '2026-11-03', [line(81, 3, 5)]),
  ];
  // 订单 2 的第一行已经有 30 只排在待送货单上
  const plan = planOrderDelivery(orders, stocks, new Map([[21, 30_000]]));
  assert.deepEqual(plan.groups, [
    {
      customerId: 2,
      lines: [
        { orderId: 2, orderLineId: 21, stockId: 7, quantity: '50', notes: '' },
        { orderId: 2, orderLineId: 22, stockId: 8, quantity: '20', notes: '' },
      ],
    },
    { customerId: 1, lines: [{ orderId: 1, orderLineId: 11, stockId: 7, quantity: '100', notes: '' }] },
  ]);
  assert.deepEqual(plan.missing, [
    { orderId: 2, orderNumber: 'DD-2', productName: '虚构箱2', quantity: '10', unit: '只' },
    { orderId: 8, orderNumber: 'DD-8', productName: '虚构箱3', quantity: '5', unit: '只' },
    { orderId: 3, orderNumber: 'DD-3', productName: '虚构箱1', quantity: '10', unit: '只' },
  ]);
  assert.deepEqual(plan.skipped, [
    { orderId: 4, orderNumber: 'DD-4', reason: '订单还待确认，先确认订单' },
    { orderId: 5, orderNumber: 'DD-5', reason: '已归档' },
    { orderId: 6, orderNumber: 'DD-6', reason: '已取消' },
    { orderId: 7, orderNumber: 'DD-7', reason: '已发货' },
  ]);
});

// 安排送货的方案（shared/business/flow/delivery-plan.ts）：页面窗口和助手 delivery.plan 共用
const stock = (id: number, productId: number, availableUnits: number, extra: { archived?: boolean; kind?: string } = {}) => ({
  id,
  productId,
  name: '虚构成品' + id,
  kind: extra.kind ?? 'finished',
  archived: extra.archived ?? false,
  availableUnits,
});
const customers = [
  { id: 1, address: '虚构路1号', contact: '虚构甲', phone: '000-1' },
  { id: 2, address: null, contact: null, phone: null },
];
const planData = (items: ReturnType<typeof stock>[], orders: ReturnType<typeof order>[], pending = new Map<number, number>()) => ({
  items,
  orders,
  customers,
  pending,
});

test('按成品排：几个客户在等的列进 contested（指定了给谁的也列着），送不了的说两种原因；收货信息按客户档案预填', () => {
  const items = [stock(7, 1, 500_000), stock(8, 2, 0), stock(9, 3, 10_000), stock(10, 1, 5_000, { kind: 'raw' })];
  const orders = [order(1, 1, '2026-11-15', [line(11, 1, 300)]), order(2, 2, '2026-11-20', [line(21, 1, 400), line(22, 2, 10)])];
  const data = planData(items, orders);
  const plan = deliveryPlan(data, { stockIds: [7, 8, 9, 10] });
  assert.deepEqual(plan.groups, [
    { customerId: 1, address: '虚构路1号', contact: '虚构甲', phone: '000-1', lines: [{ orderId: 1, orderLineId: 11, stockId: 7, quantity: '300', notes: '' }] },
    { customerId: 2, address: '', contact: '', phone: '', lines: [{ orderId: 2, orderLineId: 21, stockId: 7, quantity: '200', notes: '' }] },
  ]);
  assert.deepEqual(plan.contested.map((c) => [c.stock.id, c.customers]), [[7, [1, 2]]]);
  assert.deepEqual(plan.idle.map((x) => [x.stock.id, x.reason]), [
    [8, '可用库存为 0（没货，或已被待送货的送货单占用）'],
    [9, '没有客户订单在等'],
  ]);
  const onlyB = deliveryPlan(data, { stockIds: [7], owners: { 7: 2 } });
  assert.deepEqual(onlyB.groups.map((g) => [g.customerId, g.lines[0].quantity]), [[2, '400']]);
  assert.deepEqual(onlyB.contested.map((c) => c.stock.id), [7], '指定了的还在，人可以改');
});

test('按成品排：订单在等却规格对不上的进 blockers，不再算成“没有订单在等”', () => {
  const sized = { ...stock(7, 1, 100_000), specification: '300×200×100', length: 300, width: 200, height: 100, dimensionUnit: 'mm' };
  const orders = [order(1, 1, null, [line(11, 1, 50, { specification: '400*300*200' })])];
  const plan = deliveryPlan({ items: [sized], orders, customers, pending: new Map() }, { stockIds: [7] });
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.blockers.map((b) => [b.kind, b.orderLineId, b.stockId]), [['spec', 11, 7]]);
  assert.deepEqual(plan.idle, []);
});

test('按订单排：只用没归档的成品；blockers 只看这几张订单的产品；选订单时不出 contested、idle', () => {
  const items = [stock(7, 1, 50_000), stock(8, 2, 50_000, { archived: true }), stock(9, 3, 50_000)];
  const orders = [order(1, 1, null, [line(11, 1, 30), line(12, 2, 10)]), order(2, 1, null, [line(21, 3, 5)], { status: '待确认' })];
  const plan = deliveryPlan(planData(items, orders), { orderIds: [1, 2] });
  assert.deepEqual(plan.groups.flatMap((g) => g.lines.map((l) => [l.orderLineId, l.stockId, l.quantity])), [[11, 7, '30']]);
  assert.deepEqual(plan.missing.map((m) => m.productName), ['虚构箱2']);
  assert.deepEqual(plan.skipped.map((s) => s.orderId), [2]);
  assert.deepEqual(plan.blockers.map((b) => [b.kind, b.orderLineId]), [['draft', 21]]);
  assert.deepEqual([plan.contested, plan.idle], [[], []]);
  assert.deepEqual(deliveryPlan(planData(items, orders), { orderIds: [2] }).groups, []);
});

test('选了客户：只带出这个客户还能送的订单；没选客户时什么都不排', () => {
  const items = [stock(7, 1, 100_000)];
  const orders = [
    order(1, 1, null, [line(11, 1, 10)]),
    order(2, 1, null, [line(21, 1, 10)], { archived: true }),
    order(3, 1, null, [line(31, 1, 10)], { status: '已发货' }),
    order(4, 2, null, [line(41, 1, 10)]),
  ];
  const data = planData(items, orders);
  assert.deepEqual(deliveryPlan(data, { customerId: 1 }).groups.flatMap((g) => g.lines.map((l) => l.orderId)), [1]);
  assert.deepEqual(deliveryPlan(data, { customerId: null }).groups, []);
});

test('可发货勾好的照搬成一张送货单，只补收货信息，不再排、不出别的提示', () => {
  const preset = { customerId: 1, lines: [{ orderId: 1, orderLineId: 11, stockId: 7, quantity: '999' }] };
  const plan = deliveryPlan(planData([stock(7, 1, 0)], [order(1, 1, null, [line(11, 1, 10)])]), { preset });
  assert.deepEqual(plan.groups, [{ customerId: 1, address: '虚构路1号', contact: '虚构甲', phone: '000-1', lines: [{ ...preset.lines[0], notes: '' }] }]);
  assert.deepEqual([plan.missing, plan.skipped, plan.blockers, plan.contested, plan.idle], [[], [], [], [], []]);
});

test('超订单的行：超过订单没发的减去别的待送货单已占的才算；找不到订单明细的也算超', () => {
  const orders = [order(1, 1, null, [line(11, 1, 100, { remainingQuantity: 60 }), line(12, 1, 20)])];
  const pending = new Map([[11, 10_000]]);
  const lines = [
    { orderId: 1, orderLineId: 11, quantity: '50' },
    { orderId: 1, orderLineId: 11, quantity: '51' },
    { orderId: 1, orderLineId: 12, quantity: '20' },
    { orderId: 9, orderLineId: 99, quantity: '1' },
  ];
  assert.deepEqual(overOrderLines(lines, orders, pending), [lines[1], lines[3]]);
});
