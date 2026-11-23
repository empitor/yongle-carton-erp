// 订单筛选只有一份判断（shared/business/orders/order-filter.ts）：页面订单列表和助手查订单按状态筛出同样的订单，
// 状态只认页面上的叫法。内存库、虚构数据。
import { sales } from '../server/sales/index.js';
import { trackOrders } from '../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';
import { toolsOf } from './assistant-fixture.js';
import { readAs } from './read-result.js';
import { orderList } from '../server/orders/record-lists.js';
import { orderMatches, orderStatusMatches } from '../shared/business/index.js';
import { displayOrderStatuses } from '../shared/core/index.js';

test('发了一部分、还在生产的订单：按“部分发货”筛得到，按存的状态“生产中”筛不到', () => {
  const partly: Parameters<typeof orderStatusMatches>[0] = { status: '生产中', shippingProgress: '部分发货' };
  assert.equal(orderStatusMatches(partly, '部分发货'), true);
  assert.equal(orderStatusMatches(partly, '生产中'), false);
  assert.equal(orderStatusMatches({ status: '已发货', shippingProgress: '已发完' }, '已发货'), true);
  assert.equal(orderStatusMatches({ status: '已发货', shippingProgress: '已发完' }, undefined), true, '没给状态都算');
});

test('订单筛选：客户、产品、关键字和状态一起判断', (t) => {
  const base = businessBase(actor);
  t.after(() => base.store.close());
  const customer = base.customer(),
    product = base.product();
  base.order(customer, [base.line(product, 10)], { orderDate: '2026-11-01', deliveryDate: '2026-11-20' });
  const [order] = trackOrders(base.store, sales(base.store).orders());
  const matches = (f: Parameters<typeof orderMatches>[1]) => orderMatches(order, f);
  assert.equal(matches({ customerId: customer.id, productId: product.id, q: product.name, status: '已确认' }), true);
  assert.equal(matches({ customerId: customer.id + 1 }), false);
  assert.equal(matches({ productId: product.id + 1 }), false);
  assert.equal(matches({ q: '没有的字' }), false);
  assert.equal(matches({ status: '待确认' }), false);
});

test('页面订单列表和助手查订单按每个页面状态筛出同样的订单', (t) => {
  const base = businessBase(actor);
  t.after(() => base.store.close());
  const customer = base.customer(),
    product = base.product();
  for (const status of ['待确认', '已确认', '已取消', '已发货'])
    base.order(customer, [base.line(product, 10)], { status, orderDate: '2026-11-01', deliveryDate: '2026-11-20' });
  const tools = toolsOf(base.store);
  const viaAssistant = (status: string) =>
    readAs(tools.read('records.search', { module: 'orders', filters: { status } }, actor), {
      results: z.array(z.object({ record: z.object({ id: z.number() }) })),
    }).results.map((r) => r.record.id);
  for (const status of displayOrderStatuses) {
    const page = orderList(base.store, { status }, false);
    assert.ok(Array.isArray(page));
    assert.deepEqual(viaAssistant(status), page.map((o) => o.id), status);
  }
});

test('助手按订单状态筛：不是页面上的叫法就报错并列出能用的（“已完成”不再当成已发货）', (t) => {
  const base = businessBase(actor);
  t.after(() => base.store.close());
  const tools = toolsOf(base.store);
  assert.throws(
    () => tools.read('records.search', { module: 'orders', filters: { status: '已完成' } }, actor),
    (e: unknown) => e instanceof Error && e.message.includes('订单状态没有“已完成”') && e.message.includes(displayOrderStatuses.join('、')),
  );
});
