import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { orderSchema, productSchema } from '../shared/domain.js';
import { legacyCents, precisionTotal } from '../shared/precision.js';

import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
const priceList = ['1.3000', '8.7800', '0.1700'],
  qty = [1400, 100, 1400];
test('四位价格与外部采购单号、税费、条款无损保存，旧订单兼容，金额2936而数量2900', () => {
  const s = new Store(':memory:');
  try {
    const c = s.saveCustomer({ name: '虚构客户', contact: '', phone: '', address: '', notes: '' }),
      p = s.saveProduct(
        productSchema.parse({
          name: 'ES001',
          length: 300,
          width: 200,
          height: 150,
          material: '牛卡',
          flute: 'B楞',
          requirements: '粘箱',
          priceCents: 130,
          priceExact: '1.3000',
          customerProductCode: 'ES001',
        }),
      );
    const input = orderSchema.parse({
      customerId: c.id,
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-10',
      status: '草稿',
      notes: '',
      costs: null,
      externalPurchaseOrder: 'TEST-PO-1',
      taxRate: '13',
      taxMode: '含税',
      terms: '送货前确认',
      roundingPolicy: 'exact-cents',
      lines: priceList.map((v, i) => ({
        productId: p.id,
        specification: '300x200x150mm 牛卡 B楞',
        quantity: qty[i],
        unitPriceCents: legacyCents(v),
        unitPriceExact: v,
        unit: '只',
        customerProductCode: 'ES00' + (i + 1),
      })),
    });
    const order = s.saveOrder(input);
    assert.equal(order.totalCents, 293600);
    assert.equal(order.totalAmountExact, '2936.0000');
    assert.deepEqual(
      order.lines.map((l) => l.unitPriceExact),
      priceList,
    );
    assert.equal(order.externalPurchaseOrder, 'TEST-PO-1');
    assert.equal(order.taxRate, '13');
    assert.equal(order.terms, '送货前确认');
    assert.equal(s.product(p.id)!.priceExact, '1.3000');
  } finally {
    s.close();
  }
});
test('不足一分的尾数不静默舍入，必须明确结算规则', () => {
  const base = {
    customerId: 1,
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-10',
    status: '草稿',
    notes: '',
    costs: null,
    lines: [
      {
        productId: 1,
        specification: 'test',
        quantity: 3,
        unitPriceCents: 123,
        unitPriceExact: '1.2345',
      },
    ],
  };
  assert.equal(orderSchema.safeParse(base).success, false);
  const accepted = orderSchema.parse({ ...base, roundingPolicy: 'half-up-cent' });
  const total = precisionTotal(accepted.lines);
  assert.equal(total.exact, '3.7035');
  assert.equal(total.cents, 370);
  assert.equal(
    orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], quantity: 1.5 }] }).success,
    false,
  );
});
test('核对账号加盐哈希存储、Cookie会话、重启需重登，旧业务访问方式不改变', async () => {
  const auth = new AuthManager(':memory:'),
    store = new Store(':memory:'),
    server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  try {
    let r = await fetch(url + '/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构测试管理员', password: 'fictional-password-12345' }),
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    let state = await fetch(url + '/auth/state', {
      headers: { cookie: cookie.split(';')[0] },
    }).then((r) => r.json());
    assert.equal(state.actor.name, '虚构测试管理员');
    assert.ok(!JSON.stringify(state).includes('password'));
    assert.equal((await fetch(url + '/customers')).status, 200);
    r = await fetch(url + '/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '另一个管理员', password: 'fictional-password-12345' }),
    });
    assert.equal(r.status, 409);
    r = await fetch(url + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构测试管理员', password: 'wrong-password-12345' }),
    });
    assert.equal(r.status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    store.close();
  }
});

test('旧客户端修改参考分价格时不会遗留覆盖新价格的旧四位价格', () => {
  const s = new Store(':memory:');
  try {
    const product = {
      name: '虚构产品',
      length: 1,
      width: 1,
      height: 1,
      material: '牛卡',
      flute: 'B',
      requirements: '',
      priceCents: 123,
      priceExact: '1.2345',
    };
    let p = s.saveProduct(product);
    assert.equal(p.priceExact, '1.2345');
    p = s.saveProduct({ ...product, priceExact: undefined, priceCents: 150 }, p.id, p.version);
    assert.equal(p.priceCents, 150);
    assert.equal(p.priceExact, undefined);
  } finally {
    s.close();
  }
});
