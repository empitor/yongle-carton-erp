// 客户、产品、订单的接口（server/orders/、不带登录的 createApp）：增改查、校验、版本冲突、筛选、首页金额、来源保护、重开库后数据还在。
// 每条测试自己起服务、自己造虚构数据，互不依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/core/db.js';
import { createApp } from '../server/app.js';
import { specification, today } from '../shared/core/domain.js';
import { listen, testProblems } from './http-fixture.js';
import { z } from 'zod';
import { orderViewSchema } from '../shared/core/order-view.js';

const customer = { name: '测试客户（虚构）', contact: '测试', phone: '', address: '测试地址', notes: '' };
const product = { name: '测试纸箱', length: 300, width: 200, height: 100, material: '测试配纸', flute: 'B 楞', requirements: '粘箱', priceCents: 123 };

// 回答的样子：记录整份留着（要原样交回整张保存），只把测试要看的字段写出类型
const stamped = { id: z.number(), version: z.number() };
const customerView = z.looseObject({ ...stamped, name: z.string() });
const size = z.number().nullish(),
  text = z.string().nullish();
const productView = z.looseObject({ ...stamped, name: z.string(), priceCents: z.number().nullish(), length: size, width: size, height: size, dimensionUnit: text, material: text, flute: text });
const orderView = orderViewSchema.loose();
const cents = z.number();
const dashboardView = z.looseObject({ count: z.number(), amountCents: cents, estimatedCostCents: cents, estimatedProfitCents: cents, deliveredCents: cents, uncostedCount: z.number() });
const list = z.array(z.unknown());
/** 读回答并按结构核对 */
const read = async <T extends z.ZodType>(response: Response | Promise<Response>, schema: T): Promise<z.output<T>> => schema.parse(await (await response).json());

async function served(file = ':memory:') {
  const store = new Store(file),
    server = await listen(createApp(store, { problems: testProblems() }));
  const request = (route: string, body?: unknown, method = 'POST', extra: Record<string, string> = {}) =>
    fetch(server.api + route, {
      method: body === undefined ? 'GET' : method,
      headers: body === undefined ? extra : { 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = <T extends z.ZodType>(schema: T, route: string, body?: unknown, method = 'POST') => read(request(route, body, method), schema);
  /** 一个客户、一个产品、一张两行的已确认订单（3×1.23 + 2×1.01 = 5.71 元，没核算成本） */
  const seed = async () => {
    const c = await json(customerView, '/customers', customer),
      p = await json(productView, '/products', product);
    const o = await json(orderView, '/orders', {
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
    return { c, p, o };
  };
  const costs = { material: 100, processing: 50, waste: 20, other: 10, basis: '测试逐单估算' };
  return {
    store, request, json, seed, costs, api: server.api,
    async close() {
      await server.close();
      store.close();
    },
  };
}

test('客户可新增、查询、编辑；旧版本修改被拒绝', async () => {
  const h = await served();
  try {
    let r = await h.request('/customers', customer);
    assert.equal(r.status, 201);
    const c = await read(r, customerView);
    assert.equal((await h.json(list, '/customers?q=' + encodeURIComponent('测试客户'))).length, 1);
    r = await h.request('/customers/' + c.id, { ...c, contact: '新联系人' }, 'PUT');
    assert.equal(r.status, 200);
    assert.equal((await read(r, customerView)).version, 2);
    assert.equal((await h.request('/customers/' + c.id, c, 'PUT')).status, 409);
  } finally {
    await h.close();
  }
});

test('产品保存尺寸、材质、加工要求和参考单价；订单多明细的金额由后端重算，没核算成本的是 null', async () => {
  const h = await served();
  try {
    const { p, o } = await h.seed();
    assert.equal(p.priceCents, 123);
    assert.deepEqual([o.totalCents, o.costCents, o.lines.length], [571, null, 2]);
    const d = await h.json(dashboardView, '/dashboard');
    assert.deepEqual([d.estimatedProfitCents, d.uncostedCount], [0, 1]);
  } finally {
    await h.close();
  }
});

test('拒绝负数、小数数量、不存在的客户、无效日期及交期，一张也不多存', async () => {
  const h = await served();
  try {
    const { o } = await h.seed();
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
      assert.equal((await h.request('/orders', { ...o, ...bad })).status, 400, JSON.stringify(bad));
    assert.equal(h.store.orders().length, 1);
  } finally {
    await h.close();
  }
});

test('改客户和产品不重写历史订单；编辑订单仍保留当时的快照', async () => {
  const h = await served();
  try {
    const { c, p, o } = await h.seed();
    await h.request('/customers/' + c.id, { ...c, name: '更名客户' }, 'PUT');
    await h.request('/products/' + p.id, { ...p, name: '新产品名', length: 999, priceCents: 999 }, 'PUT');
    let historical = await h.json(orderView, '/orders/' + o.id);
    assert.deepEqual(
      [historical.customerName, historical.lines[0].productName, historical.lines[0].specification],
      [c.name, p.name, specification(p)],
    );
    // 生产中、待发货、已发货只由单据派生，手工只能在待确认、已确认、已取消之间改
    const r = await h.request('/orders/' + o.id, { ...o, status: '已确认', costs: h.costs }, 'PUT');
    assert.equal(r.status, 200);
    historical = await read(r, orderView);
    assert.deepEqual([historical.costCents, historical.lines[0].productName, historical.customerName], [180, p.name, c.name]);
  } finally {
    await h.close();
  }
});

test('订单旧版本修改被拒，金额、明细、状态都不变', async () => {
  const h = await served();
  try {
    const { o } = await h.seed();
    await h.request('/orders/' + o.id, { ...o, notes: '先改一次' }, 'PUT');
    const before = h.store.order(o.id);
    assert.equal((await h.request('/orders/' + o.id, { ...o, lines: [{ ...o.lines[0], quantity: 999 }] }, 'PUT')).status, 409);
    assert.deepEqual(h.store.order(o.id), before);
  } finally {
    await h.close();
  }
});

test('订单按客户、状态、下单日期和关键字组合筛选；日期写错或起止颠倒 400', async () => {
  const h = await served();
  try {
    const { c, o } = await h.seed();
    const t = today();
    assert.equal((await h.json(list, `/orders?customerId=${c.id}&status=${encodeURIComponent('已确认')}&start=${t}&end=${t}`)).length, 1);
    assert.equal((await h.json(list, '/orders?status=' + encodeURIComponent('已发货'))).length, 0);
    assert.equal((await h.request('/orders?start=bad')).status, 400);
    assert.equal((await h.request('/orders?start=2026-12-01&end=2026-01-01')).status, 400);
    assert.equal((await h.json(list, '/orders?q=' + o.number)).length, 1);
  } finally {
    await h.close();
  }
});

test('首页成本和毛利用同一批订单；待确认和已取消的不算有效金额', async () => {
  const h = await served();
  try {
    const { o } = await h.seed();
    const costed = await h.json(orderView, '/orders/' + o.id, { ...o, costs: h.costs }, 'PUT');
    const d = await h.json(dashboardView, '/dashboard');
    assert.deepEqual([d.amountCents, d.estimatedCostCents, d.estimatedProfitCents, d.deliveredCents], [571, 180, 391, 0]);
    await h.request('/orders', { ...costed, status: '待确认' });
    await h.request('/orders', { ...costed, status: '已取消' });
    const next = await h.json(dashboardView, '/dashboard');
    assert.deepEqual([next.count, next.amountCents], [1, 571]);
  } finally {
    await h.close();
  }
});

test('外站来源 403、不是 JSON 415、JSON 写坏 400、不存在的记录 404', async () => {
  const h = await served();
  try {
    assert.equal((await h.request('/customers', customer, 'POST', { Origin: 'https://evil.example' })).status, 403);
    const post = (type: string, body: string) => fetch(h.api + '/customers', { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal((await post('text/plain', '{}')).status, 415);
    assert.equal((await post('application/json', '{')).status, 400);
    assert.equal((await h.request('/orders/99999')).status, 404);
  } finally {
    await h.close();
  }
});

test('关闭数据库再打开，客户、订单和订单明细仍存在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'carton-erp-test-')),
    file = join(dir, 'test.sqlite');
  try {
    const h = await served(file);
    const { c, o } = await h.seed();
    await h.close();
    const store = new Store(file);
    try {
      assert.equal(store.orders().length, 1);
      assert.equal(store.order(o.id)?.totalCents, 571);
      assert.equal(store.customer(c.id)?.name, customer.name);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
