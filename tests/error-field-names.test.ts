// 保存没通过时报错里的栏目名按那种记录的叫法说（server/http-errors.ts 按地址或要改的那张单据认出是哪种记录，叫法查栏目登记表）：
// 采购单的日期叫“采购日期”，订单明细的名称叫“本单名称”，送货单的地址叫“收货地址”，说不出是哪种记录的按基本叫法。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/index.js';
import { fieldNamer, userError } from '../shared/core/index.js';
import { deliverySetup } from './delivery-fixture.js';
import { startHttp } from './http-fixture.js';

const messageOf = async (response: Response) => z.object({ message: z.string() }).parse(await response.json()).message;

test('保存采购单、订单没通过：报错按那种记录的栏目叫法说（采购日期、本单名称）', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  try {
    const purchase = await h.post('/purchases', { supplierId: 1, status: '待订货', orderDate: '2026-13-45', lines: [] });
    assert.equal(purchase.status, 400);
    assert.match(await messageOf(purchase), /^采购日期：/);
    const order = await h.post('/orders', {
      customerId: 1,
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-30',
      status: '待确认',
      lines: [{ productId: 1, productName: '', quantity: 1, unitPriceCents: 100 }],
    });
    assert.equal(order.status, 400);
    assert.match(await messageOf(order), /明细第1项的本单名称：请填写本单名称/);
  } finally {
    await h.close();
    store.close();
  }
});

test('改待送货的送货单（地址里只有单据编号）：报错按这张单据的种类说，地址叫“收货地址”', async (t) => {
  const f = deliverySetup(t),
    h = await startHttp(f.store);
  try {
    const d = f.flow.get(f.delivery.id, 'delivery');
    const response = await h.send(
      '/flow/' + d.id,
      {
        requestId: randomUUID(),
        version: d.version,
        date: d.date,
        plannedDate: d.plannedDate,
        customerId: d.customerId,
        address: '虚构'.repeat(3000),
        lines: d.lines.map((l) => ({ orderId: l.orderId, orderLineId: l.orderLineId, stockId: l.stockId, quantity: l.quantity })),
      },
      h.cookie,
      { method: 'PUT' },
    );
    assert.equal(response.status, 400);
    assert.match(await messageOf(response), /^收货地址：/);
  } finally {
    await h.close();
  }
});

test('纸板资料里另起名字的栏目（纸板名称）不再接上一层的“纸板”', () => {
  assert.equal(userError('lines.0.item.name: 请填写', fieldNamer('arrival')), '明细第1项的纸板名称：请填写');
  // 没另起名字的照旧接上一层
  assert.equal(userError('lines.0.item.flute: 太长', fieldNamer('arrival')), '明细第1项的纸板的楞型：太长');
});
