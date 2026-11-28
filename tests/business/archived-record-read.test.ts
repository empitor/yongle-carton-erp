/**
 * 已归档记录的单条读取和列表同一条线（server/core/http/permissions.ts 的 includeArchivedForRecord）：
 * 业务账号（业务人员、只读，不进超级管理员模式）在“已归档”列表里看得到的客户、产品、订单、采购单，按编号单条也读得到；
 * 列表看不到的（纯财务账号、没登录）单条也读不到，不比列表多。虚构数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BusinessRecords from '../../src/records/BusinessRecords.js';
import { Store } from '../../server/core/index.js';
import { startHttp } from '../support/http-fixture.js';
import { actor } from '../support/actor-fixture.js';
import { businessBase, standardRecords } from '../support/business-base-fixture.js';

const pass = 'Fictional-pass-123';
const listed = z.union([z.array(z.object({ id: z.number() })), z.object({ rows: z.array(z.object({ id: z.number() })) })]);
const idsOf = (value: unknown) => {
  const v = listed.parse(value);
  return (Array.isArray(v) ? v : v.rows).map((r) => r.id);
};

async function setup() {
  const store = new Store(':memory:'),
    base = businessBase(actor, store),
    { customer, product, supplier, raw } = standardRecords(base);
  const order = base.order(customer, [{ productId: product.id, quantity: 100, unitPriceCents: 120 }]);
  const purchase = base.ops.savePurchase(
    {
      supplierId: supplier.id,
      status: '已订货',
      orderDate: '2026-11-01',
      lines: [{ stockItemId: raw.id, name: raw.name, unit: '张', quantity: '1000', unitPrice: '1', priceBasis: 'quantity' }],
    },
    actor,
  );
  // 没归档的一套：单条读回的归档标记是 false
  const activeCustomer = base.customer({ name: '虚构在用客户' }),
    activeProduct = base.product({ name: '虚构在用纸箱' }),
    activeOrder = base.order(activeCustomer, [{ productId: activeProduct.id, quantity: 50, unitPriceCents: 100 }]);
  for (const [entity, id] of [['customers', customer.id], ['products', product.id], ['orders', order.id], ['purchases', purchase.id]] as const)
    store.markArchived(entity, id, actor.id);
  const h = await startHttp(store);
  await h.enterSuperMode();
  for (const [name, level] of [['虚构业务员', 'staff'], ['虚构只读', 'viewer'], ['虚构出纳', 'cashier']])
    assert.equal((await h.send('/auth/users', { name, password: pass, level }, h.cookie)).status, 201, name);
  const cookies = {
    staff: await h.login('虚构业务员', pass),
    viewer: await h.login('虚构只读', pass),
    cashier: await h.login('虚构出纳', pass),
  };
  const records = [
    { list: '/customers', one: '/customers/' + customer.id, id: customer.id },
    { list: '/products', one: '/products/' + product.id, id: product.id },
    { list: '/orders', one: '/orders/' + order.id, id: order.id },
    { list: '/purchases', one: '/purchases/' + purchase.id, id: purchase.id },
  ];
  const active = ['/customers/' + activeCustomer.id, '/products/' + activeProduct.id, '/orders/' + activeOrder.id];
  return {
    h,
    cookies,
    records,
    active,
    async close() {
      await h.close();
      store.close();
    },
  };
}

test('已归档的客户、产品、订单、采购单：业务账号在已归档列表里看得到的，按编号单条也读得到（不用超级管理员模式）', async () => {
  const s = await setup();
  try {
    for (const who of ['staff', 'viewer'] as const)
      for (const r of s.records) {
        const list = await s.h.send(r.list + '?archived=1', undefined, s.cookies[who]);
        assert.equal(list.status, 200, who + ' ' + r.list);
        assert.ok(idsOf(await list.json()).includes(r.id), who + ' 在已归档列表里看得到 ' + r.one);
        const one = await s.h.send(r.one, undefined, s.cookies[who]);
        assert.equal(one.status, 200, who + ' 单条读 ' + r.one);
        assert.equal(z.object({ id: z.number() }).parse(await one.json()).id, r.id);
      }
  } finally {
    await s.close();
  }
});

test('不比列表看得多：列表看不到的单条也读不到（纯财务账号、没登录）；连同已归档一起看仍要超级管理员模式', async () => {
  const s = await setup();
  try {
    for (const r of s.records) {
      assert.equal((await s.h.send(r.list + '?archived=1', undefined, s.cookies.cashier)).status, 403, '出纳看不到列表 ' + r.list);
      assert.equal((await s.h.send(r.one, undefined, s.cookies.cashier)).status, 403, '出纳也读不到单条 ' + r.one);
      assert.equal((await s.h.send(r.list + '?archived=1')).status, 401, '没登录看不到列表 ' + r.list);
      assert.equal((await s.h.send(r.one)).status, 401, '没登录也读不到单条 ' + r.one);
      assert.equal((await s.h.send(r.list + '?archived=all', undefined, s.cookies.viewer)).status, 403, '只读账号不能连同已归档一起看 ' + r.list);
    }
  } finally {
    await s.close();
  }
});

test('单条读回带归档标记（和列表那一行同一个来源）：从不带 archived=1 的链接打开，详情也按记录本身标“已归档”', async () => {
  const s = await setup();
  const flagOf = async (path: string) => {
    const r = await s.h.send(path, undefined, s.cookies.staff);
    assert.equal(r.status, 200, path);
    return z.object({ archived: z.boolean().optional() }).parse(await r.json()).archived;
  };
  try {
    for (const r of s.records) assert.equal(await flagOf(r.one), true, '已归档 ' + r.one);
    for (const path of s.active) assert.equal(await flagOf(path), false, '没归档 ' + path);
  } finally {
    await s.close();
  }
  // 页面按行上的标记显示（src/records/BusinessRecords.tsx 的 isArchived），不按当前这一档：在“全部”里打开已归档的那条也标“已归档”
  const row = { id: 1, name: '虚构客户', contact: '', phone: '', address: '', notes: '', sites: [], version: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  const html = (archived: boolean) =>
    renderToStaticMarkup(createElement(BusinessRecords, { entity: 'customers', rows: [{ ...row, archived }], archived: false, edit: () => {}, changed: () => {} }));
  assert.match(html(true), /已归档/);
  assert.doesNotMatch(html(false), /已归档/);
});
