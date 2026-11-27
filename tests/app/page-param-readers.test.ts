/**
 * 页面读地址参数只走 shared/core/pages.ts 的 pageParams：各页从地址读到的编号和 pageParams 一致。
 * 合法值照常读到；手写的非法编号（0x10、1e3、012、3.0）当作没给，不再被 Number() 读成别的单据、订单、客户。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageParams } from '../../shared/core/index.js';
import { linkedDocId } from '../../src/warehouse/useWarehouseView.js';
import { routePurchaseEditor } from '../../src/records/PurchasesPage.js';
import { orderCreatePreset } from '../../src/records/RecordEditors.js';
import { archivedRoute, readListFilters, recordRoute } from '../../src/records/record-filters.js';
import { hashLaunch } from '../../src/flow/useFlowDesk.js';

test('到货页从地址打开的单据编号和 pageParams 一致：0x10、1e3 当作没给', () => {
  for (const hash of ['#warehouse?arrivals=1&doc=0x10', '#warehouse?arrivals=1&doc=1e3']) {
    assert.equal(pageParams('warehouse', hash).doc, undefined);
    assert.equal(linkedDocId(hash), null, hash);
  }
  assert.equal(linkedDocId('#warehouse?arrivals=1&doc=16'), 16);
  assert.equal(linkedDocId('#warehouse?kind=finished&deliveries=1&doc=5&archived=1'), 5);
  assert.equal(linkedDocId('#warehouse?arrivals=1'), null);
});

test('采购单页“安排订料”读到的订单编号和 pageParams 一致：012 当作没给，改开新建采购单', () => {
  const hash = '#purchases?create=1&order=012';
  assert.equal(pageParams('purchases', hash).order, undefined);
  assert.deepEqual(routePurchaseEditor(hash), { type: 'purchase', seed: { supplierId: undefined, stockIds: [] } });
  assert.deepEqual(routePurchaseEditor('#purchases?create=1&order=12&products=3,5'), {
    type: 'purchase-launch',
    value: { orderId: 12, productIds: [3, 5] },
  });
  assert.deepEqual(routePurchaseEditor('#purchases?create=1&supplier=4&stocks=7,8&n=1700000000000'), {
    type: 'purchase',
    seed: { supplierId: 4, stockIds: [7, 8] },
  });
  assert.equal(routePurchaseEditor('#purchases?order=12'), null, '不带 create=1 不打开编辑窗');
});

test('新建订单预填的客户编号和 pageParams 一致：3.0 当作没给', () => {
  const hash = '#orders?create=1&customer=3.0';
  assert.equal(pageParams('orders', hash).customer, undefined);
  assert.deepEqual(orderCreatePreset(hash), { customerId: undefined, productIds: [] });
  assert.deepEqual(orderCreatePreset('#orders?create=1&customer=3&products=1,2&n=9'), { customerId: 3, productIds: [1, 2] });
  assert.equal(orderCreatePreset('#orders?customer=3'), null, '不带 create=1 不打开新建订单');
});

test('生产页地址里的链接参数按生产页登记表读：写坏的单据、订单编号当作没给', () => {
  assert.deepEqual(hashLaunch('#production?doc=7&edit=1'), {
    doc: '7', edit: '1', review: undefined, task: undefined, create: undefined, order: undefined,
  });
  assert.deepEqual(hashLaunch('#production?view=production&task=4'), {
    doc: undefined, edit: undefined, review: undefined, task: '4', create: undefined, order: undefined,
  });
  assert.equal(hashLaunch('#production?create=1&order=5').order, '5');
  assert.equal(hashLaunch('#production?doc=0x10').doc, undefined);
  assert.equal(hashLaunch('#production?order=012').order, undefined);
  assert.deepEqual(Object.values(hashLaunch('#trash?q=纸箱')).filter(Boolean), [], '归档页地址不带单据参数');
});

test('列表几页按地址所在那一页读参数：合法值照旧，写坏的客户编号当作没筛选', () => {
  assert.equal(readListFilters('#orders?customerId=7').customerId, '7');
  assert.equal(readListFilters('#orders?customerId=3.0').customerId, '');
  assert.equal(readListFilters('#orders?customerId=9999999999').customerId, '9999999999');
  assert.equal(readListFilters('#orders?customerId=12345678901').customerId, '', '客户编号最多认十位，和以前一样');
  assert.equal(readListFilters('#products?customerId=5&unassigned=1').customerId, 'none');
  assert.equal(readListFilters('#orders?scope=all').view, 'current');
  assert.equal(readListFilters('#customers').preset, '2', '客户、产品默认最近两个月');
  assert.equal(readListFilters('#orders?range=bogus').preset, 'all');
  assert.ok(archivedRoute('#products?archived=1') && archivedRoute('#orders?scope=archived') && !archivedRoute('#orders'));
  assert.equal(recordRoute('#trash?q=' + encodeURIComponent('纸箱')).q, '纸箱', '归档页的搜索词照样带进来');
  const stock = recordRoute('#warehouse?kind=finished&zero=1&pending=1&scope=bogus');
  assert.deepEqual([stock.kind, stock.zero, stock.pending, stock.scope], ['finished', true, true, undefined]);
  assert.deepEqual(recordRoute(''), {});
});
