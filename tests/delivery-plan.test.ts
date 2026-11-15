import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOrderDelivery } from '../shared/business/warehouse-delivery.js';

const line = (id: number, productId: number, quantity: number) => ({ id, productId, productName: '虚构箱' + productId, quantity, unit: '只' });
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
    // 没给可用量时按结余算
    { id: 8, productId: 2, balanceUnits: 20_000 },
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
