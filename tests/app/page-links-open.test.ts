/**
 * 带参数的地址打开的就是要的那一屏：经营概况点进订单页不落到被滤空的“待处理”；#production?task= 直接登记完工；
 * 已归档送货单 doc=&archived=1 打开那一张；带着产品新建订单整页刷新后产品行还在（产品读到再开窗）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageParams } from '../../shared/core/index.js';
import { overviewOrderLinks } from '../../src/records/BusinessOverview.js';
import { readListFilters } from '../../src/records/record-filters.js';
import { linkedCompletionTask } from '../../src/flow/useFlowLaunch.js';
import { routeWarehouseScope } from '../../src/warehouse/useWarehouseList.js';
import { linkedRow } from '../../src/warehouse/useWarehouseView.js';
import { waitsForProducts } from '../../src/records/RecordEditors.js';

const range = { range: 'custom' as const, start: '2026-11-01', end: '2026-11-30' };

test('经营概况点“已发货”“已取消”、订单总数：订单页看全部（不落到滤掉已发货、已取消的待处理）', () => {
  const links = overviewOrderLinks(range);
  for (const href of [links.orders, links.status('已发货'), links.status('已取消')]) {
    const f = readListFilters(href);
    assert.equal(f.view, 'current', href);
    assert.deepEqual([f.preset, f.start, f.end], ['custom', '2026-11-01', '2026-11-30'], href);
  }
  assert.equal(readListFilters(links.status('已发货')).status, '已发货');
  // 待完成、逾期本来就看待处理，不带多余参数
  assert.equal(readListFilters(links.pending).view, 'pending');
  assert.equal(links.pending, '#orders?range=all');
});

test('#production?task= 不带 view=production 也直接打开登记完工窗', () => {
  const params = new URLSearchParams('task=29');
  assert.equal(linkedCompletionTask('task', params), 29);
  assert.equal(linkedCompletionTask('production', params), 29);
  assert.equal(linkedCompletionTask('task', new URLSearchParams('doc=29')), null);
  assert.equal(linkedCompletionTask('delivery', params), null, '到货、送货窗口不管登记完工');
});

test('已归档送货单的链接（doc=&archived=1）：进页面就看已归档，打开那一张', () => {
  const hash = '#warehouse?kind=finished&deliveries=1&doc=1&archived=1';
  assert.equal(pageParams('warehouse', hash).archived, true);
  assert.equal(routeWarehouseScope('delivery', hash), 'archived');
  assert.equal(routeWarehouseScope('delivery', '#warehouse?deliveries=1&doc=1'), 'open');
  assert.equal(routeWarehouseScope('arrival', '#warehouse?arrivals=1&state=pending'), 'open');
  assert.equal(routeWarehouseScope('arrival', '#warehouse?arrivals=1'), 'all');
  const archivedDoc = { id: 1, status: 'confirmed', lines: [] };
  const pendingDoc = { id: 2, flowId: 2, status: 'draft', pending: true, lines: [] };
  const list = { records: [pendingDoc], archivedScope: true, archivedRows: [archivedDoc] };
  assert.equal(linkedRow(1, list), archivedDoc);
  assert.equal(linkedRow(2, list), undefined, '看已归档时只在已归档的单据里找');
  assert.equal(linkedRow(2, { ...list, archivedScope: false }), pendingDoc);
});

test('带着产品新建订单：产品列表还没读到时先不开窗，读到了再开（产品行在开窗那一刻定下）', () => {
  const editor = { kind: 'orders' as const, preset: { customerId: 2, productIds: [1, 2] } };
  assert.equal(waitsForProducts(editor, false, true), true, '整页刷新：产品还在读');
  assert.equal(waitsForProducts(editor, false, false), false, '读完了就是没有产品，照样开窗');
  assert.equal(waitsForProducts(editor, true, true), false, '读到过产品，重读时不再等');
  assert.equal(waitsForProducts({ kind: 'orders', preset: { customerId: 2 } }, false, true), false, '没带产品不用等');
});
