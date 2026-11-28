// 新建订单带防重复请求号（POST /api/orders 的 requestId，server/orders/records-router.ts，照 onceByRequest 的做法）：
// 同一个请求号重发（网络断了重试、连点两下）只建一张、回同一张；同一个请求号换了内容拒收（409）。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, count } from '../../server/core/index.js';
import { startHttp } from '../support/http-fixture.js';

const saved = z.looseObject({ id: z.number() });

test('新建订单：同一个请求号重发只建一张、回同一张；同一个请求号换了内容拒收', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  try {
    const customer = saved.parse(await (await h.send('/customers', { name: '虚构客户' }, h.cookie)).json());
    const product = saved.parse(await (await h.send('/products', { name: '虚构纸箱' }, h.cookie)).json());
    const body = {
      customerId: customer.id,
      orderDate: '2026-11-20',
      deliveryDate: '2026-11-30',
      status: '待确认',
      notes: '',
      lines: [{ productId: product.id, quantity: 100, unit: '只', unitPriceCents: 200 }],
      requestId: randomUUID(),
    };
    const first = await h.send('/orders', body, h.cookie),
      again = await h.send('/orders', body, h.cookie);
    assert.deepEqual([first.status, again.status], [201, 201]);
    assert.equal(saved.parse(await again.json()).id, saved.parse(await first.json()).id);
    assert.equal(count(store.db, 'SELECT count(*) AS n FROM orders'), 1);
    const changed = await h.send('/orders', { ...body, notes: '虚构改了内容' }, h.cookie);
    assert.equal(changed.status, 409);
    assert.equal(count(store.db, 'SELECT count(*) AS n FROM orders'), 1);
  } finally {
    await h.close();
    store.close();
  }
});
