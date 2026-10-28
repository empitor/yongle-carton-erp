import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { specification, today } from '../shared/domain.js';
const dir = mkdtempSync(join(tmpdir(), 'carton-erp-test-'));
const path = join(dir, 'test.sqlite');
let store: Store, server: Server, url: string;
before(async () => {
  store = new Store(path);
  server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
async function request(
  route: string,
  body?: unknown,
  method = 'POST',
  extra: Record<string, string> = {},
) {
  return fetch(url + route, {
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? extra : { 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const customer = {
  name: '测试客户（虚构）',
  contact: '测试',
  phone: '',
  address: '测试地址',
  notes: '',
};
const product = {
  name: '测试纸箱',
  length: 300,
  width: 200,
  height: 100,
  material: '测试配纸',
  flute: 'B 楞',
  requirements: '粘箱',
  priceCents: 123,
};
let c: any, p: any, o: any;
test('客户可新增、查询、编辑；旧版本修改被拒绝', async () => {
  let r = await request('/customers', customer);
  assert.equal(r.status, 201);
  c = await r.json();
  r = await request('/customers?q=' + encodeURIComponent('测试客户'));
  assert.equal((await r.json()).length, 1);
  r = await request('/customers/' + c.id, { ...c, contact: '新联系人' }, 'PUT');
  assert.equal(r.status, 200);
  const next = await r.json();
  assert.equal(next.version, 2);
  assert.equal((await request('/customers/' + c.id, c, 'PUT')).status, 409);
  c = next;
});
test('产品保存尺寸、材质、加工要求和参考单价', async () => {
  const r = await request('/products', product);
  assert.equal(r.status, 201);
  p = await r.json();
  assert.equal(p.priceCents, 123);
});
test('订单多明细、金额后端重算，未核算成本保持 null', async () => {
  const r = await request('/orders', {
    customerId: c.id,
    orderDate: today(),
    deliveryDate: today(),
    status: '已确认',
    notes: '测试',
    lines: [
      { productId: p.id, specification: specification(p), quantity: 3, unitPriceCents: 123 },
      { productId: p.id, specification: '独立规格', quantity: 2, unitPriceCents: 101 },
    ],
    costs: null,
    totalCents: 1,
  });
  assert.equal(r.status, 201);
  o = await r.json();
  assert.equal(o.totalCents, 571);
  assert.equal(o.costCents, null);
  assert.equal(o.lines.length, 2);
  const d = await (await request('/dashboard')).json();
  assert.equal(d.estimatedProfitCents, 0);
  assert.equal(d.uncostedCount, 1);
});
test('拒绝负数、小数数量、不存在的客户、无效日期及交期', async () => {
  for (const bad of [
    { customerId: 99999 },
    { deliveryDate: '2025-02-30' },
    { deliveryDate: '2020-01-01' },
    { lines: [{ ...o.lines[0], quantity: -1 }] },
    { lines: [{ ...o.lines[0], quantity: 1.1 }] },
    { lines: [{ ...o.lines[0], unitPriceCents: -1 }] },
    { lines: [] },
    { costs: { material: 0, processing: 0, waste: 0, other: 0, basis: '' } },
  ])
    assert.equal((await request('/orders', { ...o, ...bad })).status, 400);
  assert.equal(store.orders().length, 1);
});
test('修改客户和产品不重写历史订单；编辑状态仍保留快照', async () => {
  await request('/customers/' + c.id, { ...c, name: '更名客户' }, 'PUT');
  await request(
    '/products/' + p.id,
    { ...p, name: '新产品名', length: 999, priceCents: 999 },
    'PUT',
  );
  let historical = await (await request('/orders/' + o.id)).json();
  assert.equal(historical.customerName, c.name);
  assert.equal(historical.lines[0].productName, p.name);
  assert.equal(historical.lines[0].specification, specification(p));
  const r = await request(
    '/orders/' + o.id,
    {
      ...o,
      status: '生产中',
      costs: { material: 100, processing: 50, waste: 20, other: 10, basis: '测试逐单估算' },
    },
    'PUT',
  );
  assert.equal(r.status, 200);
  historical = await r.json();
  assert.equal(historical.costCents, 180);
  assert.equal(historical.lines[0].productName, p.name);
  assert.equal(historical.customerName, c.name);
  o = historical;
});
test('订单并发版本冲突不改变金额、明细或状态', async () => {
  const before = store.order(o.id);
  assert.equal(
    (
      await request(
        '/orders/' + o.id,
        { ...o, version: 1, lines: [{ ...o.lines[0], quantity: 999 }] },
        'PUT',
      )
    ).status,
    409,
  );
  assert.deepEqual(store.order(o.id), before);
});
test('支持客户、状态、下单日期和关键字组合筛选', async () => {
  assert.equal(
    (
      await (
        await request(
          `/orders?customerId=${c.id}&status=${encodeURIComponent('生产中')}&start=${today()}&end=${today()}`,
        )
      ).json()
    ).length,
    1,
  );
  assert.equal(
    (await (await request('/orders?status=' + encodeURIComponent('已发货'))).json()).length,
    0,
  );
  assert.equal((await request('/orders?start=bad')).status, 400);
  assert.equal((await request('/orders?start=2026-12-01&end=2026-01-01')).status, 400);
  assert.equal((await (await request('/orders?q=' + o.number)).json()).length, 1);
});
test('首页成本与毛利使用相同订单范围；草稿和取消不计有效金额', async () => {
  const d = await (await request('/dashboard')).json();
  assert.equal(d.amountCents, 571);
  assert.equal(d.estimatedCostCents, 180);
  assert.equal(d.estimatedProfitCents, 391);
  assert.equal(d.shippedCents, 0);
  await request('/orders', { ...o, status: '草稿' });
  await request('/orders', { ...o, status: '已取消' });
  const next = await (await request('/dashboard')).json();
  assert.equal(next.count, 1);
  assert.equal(next.amountCents, 571);
});
test('本机来源保护、请求格式与不存在记录', async () => {
  assert.equal(
    (await request('/customers', customer, 'POST', { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + '/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(url + '/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal((await request('/orders/99999')).status, 404);
});
test('只读业务元数据接口不包含业务记录且 AI 写入能力保持禁用', async () => {
  const r = await request('/business/metadata');
  assert.equal(r.status, 200);
  const metadata = await r.json();
  assert.equal(metadata.catalogVersion, '25');
  assert.equal(metadata.readiness.aiWrites, false);
  assert.ok(metadata.modules.orders.inputSchema.properties.lines);
  assert.ok(!JSON.stringify(metadata).includes('更名客户'));
  assert.equal((await request('/ai/execute', { approved: true })).status, 404);
});
test('关闭数据库再打开，客户、订单和订单明细仍存在', () => {
  const count = store.orders().length;
  store.close();
  store = new Store(path);
  assert.equal(store.orders().length, count);
  assert.equal(store.order(o.id)?.totalCents, 571);
  assert.equal(store.customer(c.id)?.name, '更名客户');
});
