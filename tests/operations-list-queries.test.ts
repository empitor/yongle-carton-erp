// 供应商、采购单、库存品、流水列表（src/records/list-api.ts）发出的查询参数：带统计（withMetrics）、分页、筛选、
// 带不带已归档的（archived），和服务端的接口表一致；没填的筛选不带。不开浏览器：fetch 换成替身，只记下发出的地址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMovements, loadPurchaseLookups, loadPurchases, loadStockItems, loadSuppliers } from '../src/records/list-api.js';
import { json, signedIn, stubBrowser } from './browser-fixture.js';

/** 发出的业务请求：地址和按顺序的查询参数 */
async function sentBy(run: () => Promise<unknown>) {
  const browser = stubBrowser((url) => (url === '/api/auth/state' ? signedIn() : json(200, { rows: [] })));
  try {
    await run();
    return browser.calls
      .filter((c) => c.url !== '/api/auth/state')
      .map((c) => {
        const [path, query] = c.url.split('?');
        return [c.init?.method ?? 'GET', path, [...new URLSearchParams(query)]];
      });
  } finally {
    browser.restore();
  }
}

test('供应商列表：带统计，已归档范围、关键词、有没有采购往来照填的带；没填的不带', async () => {
  assert.deepEqual(await sentBy(() => loadSuppliers({ range: '?archived=1', search: '虚构', history: 'with' })), [
    ['GET', '/api/suppliers', [['withMetrics', '1'], ['archived', '1'], ['q', '虚构'], ['history', 'with']]],
  ]);
  assert.deepEqual(await sentBy(() => loadSuppliers({ range: '', search: '', history: '' })), [
    ['GET', '/api/suppliers', [['withMetrics', '1']]],
  ]);
});

test('采购页的供应商和库存品：超级管理员连同已归档的一起读，平常只带统计', async () => {
  assert.deepEqual(await sentBy(() => loadPurchaseLookups(true)), [
    ['GET', '/api/suppliers', [['withMetrics', '1'], ['archived', 'all']]],
    ['GET', '/api/warehouse/items', [['withMetrics', '1'], ['archived', 'all']]],
  ]);
  assert.deepEqual(await sentBy(() => loadPurchaseLookups(false)), [
    ['GET', '/api/suppliers', [['withMetrics', '1']]],
    ['GET', '/api/warehouse/items', [['withMetrics', '1']]],
  ]);
});

test('采购单列表：带统计、供应商、状态、关键词、日期、只看待到货，服务端分页排序', async () => {
  const sent = await sentBy(() =>
    loadPurchases({
      range: '?archived=all',
      search: '虚构',
      start: '2026-11-01',
      end: '2026-11-30',
      supplierFilter: '3',
      status: '已订货',
      pendingOnly: true,
      page: 2,
      pageSize: 50,
      sort: 'due',
    }),
  );
  assert.deepEqual(sent, [
    [
      'GET',
      '/api/purchases',
      [
        ['withMetrics', '1'],
        ['archived', 'all'],
        ['supplierId', '3'],
        ['status', '已订货'],
        ['q', '虚构'],
        ['start', '2026-11-01'],
        ['end', '2026-11-30'],
        ['pending', '1'],
        ['page', '2'],
        ['pageSize', '50'],
        ['sort', 'due'],
      ],
    ],
  ]);
  // 没填的筛选不带，分页排序照带
  const plain = await sentBy(() =>
    loadPurchases({ range: '', search: '', start: '', end: '', supplierFilter: '', status: '', pendingOnly: false, page: 1, pageSize: 50, sort: 'recent' }),
  );
  assert.deepEqual(plain, [
    ['GET', '/api/purchases', [['withMetrics', '1'], ['page', '1'], ['pageSize', '50'], ['sort', 'recent']]],
  ]);
});

test('库存品列表：原材料按供应商筛、成品按客户筛；只看零库存时两种一起、不按往来单位筛', async () => {
  assert.deepEqual(await sentBy(() => loadStockItems({ range: '?archived=1', kind: 'raw', zeroOnly: false, party: '5', search: '瓦楞' })), [
    ['GET', '/api/warehouse/items', [['withMetrics', '1'], ['archived', '1'], ['kind', 'raw'], ['supplierId', '5'], ['q', '瓦楞']]],
  ]);
  assert.deepEqual(await sentBy(() => loadStockItems({ range: '', kind: 'finished', zeroOnly: false, party: '9' })), [
    ['GET', '/api/warehouse/items', [['withMetrics', '1'], ['kind', 'finished'], ['customerId', '9']]],
  ]);
  assert.deepEqual(await sentBy(() => loadStockItems({ range: '', kind: 'raw', zeroOnly: true, party: '5' })), [
    ['GET', '/api/warehouse/items', [['withMetrics', '1'], ['zero', '1']]],
  ]);
});

test('库存流水：按仓库、变动类型、日期、关键词、某个库存品筛，带统计，服务端分页', async () => {
  const sent = await sentBy(() =>
    loadMovements({ kind: 'raw', action: 'purchase', start: '2026-11-01', end: '2026-11-30', search: '虚构', itemId: 7, page: 3, pageSize: 50 }),
  );
  assert.deepEqual(sent, [
    [
      'GET',
      '/api/warehouse/movements',
      [
        ['withMetrics', '1'],
        ['kind', 'raw'],
        ['action', 'purchase'],
        ['start', '2026-11-01'],
        ['end', '2026-11-30'],
        ['q', '虚构'],
        ['itemId', '7'],
        ['page', '3'],
        ['pageSize', '50'],
      ],
    ],
  ]);
  assert.deepEqual(
    await sentBy(() => loadMovements({ kind: '', action: '', start: '', end: '', search: '', page: 1, pageSize: 5 })),
    [['GET', '/api/warehouse/movements', [['withMetrics', '1'], ['page', '1'], ['pageSize', '5']]]],
  );
});
