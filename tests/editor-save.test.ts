// 客户、产品编辑窗的保存（src/editors/editor-api.ts）带的是打开窗口时读到的版本号：窗口开着时别人改了同一条，
// 页面会重读这条记录，可表单还是打开时的内容；拿它保存必须带打开时的版本，让服务端的版本校验回 409（服务端那一半见 business-http 的 409 用例），
// 不能带重读后的新版本把别人的修改盖掉。不开浏览器：fetch 换成替身，替身照服务端的规矩比版本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveCustomer, saveOrder, saveProduct, saveSupplier } from '../src/editors/editor-api.js';
import { json, signedIn, stubBrowser } from './browser-fixture.js';

const versionOf = (body: unknown) =>
  typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined;

test('编辑窗开着时别人改了同一条：拿打开时的表单保存，带的是打开时的版本，回 409', async () => {
  // 替身服务端：这两条现在都是第 2 版，版本不对回 409
  const sent: unknown[] = [];
  const browser = stubBrowser((url, init) => {
    if (url === '/api/auth/state') return signedIn();
    const body: unknown = JSON.parse(String(init?.body));
    sent.push(body);
    return versionOf(body) === 2 ? json(200, body) : json(409, { message: '记录已被其他页面修改，请刷新后重试' });
  });
  try {
    // 打开窗口时读到的是第 1 版，表单里改了名字
    const customer = { id: 7, version: 1, name: '虚构客户', contact: '', phone: '', address: '', notes: '' };
    const product = { id: 8, version: 1, name: '虚构纸箱', length: 300, width: 200, height: 100, priceCents: 0 };
    await assert.rejects(saveCustomer(customer.id, { ...customer, name: '我改的客户' }), { status: 409 });
    await assert.rejects(saveProduct(product.id, { ...product, name: '我改的纸箱' }), { status: 409 });
    assert.deepEqual(
      browser.calls.filter((c) => c.url !== '/api/auth/state').map((c) => [c.init?.method, c.url]),
      [
        ['PUT', '/api/customers/7'],
        ['PUT', '/api/products/8'],
      ],
    );
    assert.deepEqual(sent.map(versionOf), [1, 1]);
  } finally {
    browser.restore();
  }
});

/** 替身服务端：记下发出的正文；这条现在是第 2 版，正文里的版本不对回 409 */
function secondVersionServer() {
  const sent: unknown[] = [];
  const browser = stubBrowser((url, init) => {
    if (url === '/api/auth/state') return signedIn();
    const body: unknown = JSON.parse(String(init?.body));
    sent.push(body);
    return versionOf(body) === 2 ? json(200, body) : json(409, { message: '记录已被其他页面修改，请刷新后重试' });
  });
  const requests = () => browser.calls.filter((c) => c.url !== '/api/auth/state').map((c) => [c.init?.method, c.url]);
  return { sent, requests, restore: browser.restore };
}

test('供应商编辑窗开着时别人改了同一条：拿打开时的表单保存，带的是打开时的版本，回 409', async () => {
  const server = secondVersionServer();
  try {
    const supplier = { id: 9, version: 1, name: '虚构供应商', contact: '', phone: '', address: '', notes: '' };
    await assert.rejects(saveSupplier(supplier.id, { ...supplier, name: '我改的供应商' }), { status: 409 });
    assert.deepEqual(server.requests(), [['PUT', '/api/suppliers/9']]);
    assert.deepEqual(server.sent.map(versionOf), [1]);
  } finally {
    server.restore();
  }
});

test('订单编辑窗开着时别人改了同一张：拿打开时的表单保存，带的是打开时的版本，回 409', async () => {
  const server = secondVersionServer();
  try {
    const order = {
      version: 1,
      customerId: 3,
      orderDate: '2026-11-13',
      deliveryDate: '2026-11-20',
      status: '待确认' as const,
      lines: [{ productId: 8, productName: '虚构纸箱', quantity: 100, unitPriceCents: 150 }],
    };
    await assert.rejects(saveOrder(5, { ...order, notes: '我改的备注' }), { status: 409 });
    assert.deepEqual(server.requests(), [['PUT', '/api/orders/5']]);
    assert.deepEqual(server.sent.map(versionOf), [1]);
  } finally {
    server.restore();
  }
});
