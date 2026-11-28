/**
 * 助手给的记录链接（server/assistant/tools/modules.ts 的 recordLink）直接打开那一条，和页面别处一样：
 * 到货单按单据编号（flowDocHref），订单 order=、客户产品采购单和库存品 record=；供应商页不从地址打开，仍按名称搜；
 * 已归档的客户、产品、订单、采购单在已归档列表里按单号或名称搜（单条读取普通账号读不到已归档的）。
 * 页面地址册子不登记没人读的参数（warehouse.receipt、orders.view）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordLink } from '../../server/assistant/tools/modules.js';
import { flowDocHref, pageParams } from '../../shared/core/index.js';

test('助手给的记录链接直接打开那一条，不靠搜索', () => {
  assert.equal(recordLink('arrivals', { id: 7 }), flowDocHref('arrival', 7));
  assert.equal(pageParams('warehouse', recordLink('arrivals', { id: 7 })).doc, 7);
  assert.equal(recordLink('orders', { id: 5, number: 'ZX-20261101-0005' }), '#orders?order=5');
  // 已归档的客户、产品、订单、采购单：单条读取只给超级管理员模式（采购单连它也读不到），照旧在已归档列表里按单号或名称搜
  assert.equal(recordLink('orders', { id: 5, number: 'ZX-20261101-0005', archived: true }), '#orders?q=ZX-20261101-0005&archived=1');
  assert.equal(recordLink('customers', { id: 3, name: '虚构客户', archived: true }), '#customers?q=' + encodeURIComponent('虚构客户') + '&archived=1');
  assert.equal(recordLink('products', { id: 4, name: '虚构纸箱', archived: true }), '#products?q=' + encodeURIComponent('虚构纸箱') + '&archived=1');
  assert.equal(recordLink('customers', { id: 3, name: '虚构客户' }), '#customers?record=3');
  assert.equal(recordLink('products', { id: 4, name: '虚构纸箱' }), '#products?record=4');
  assert.equal(recordLink('purchases', { id: 6, number: 'CG-20261101-0006' }), '#purchases?record=6');
  assert.equal(recordLink('purchases', { id: 6, number: 'CG-20261101-0006', archived: true }), '#purchases?q=CG-20261101-0006&archived=1');
  assert.equal(recordLink('raw_inventory', { id: 8, name: '虚构纸板' }), '#warehouse?kind=raw&record=8');
  assert.equal(recordLink('finished_inventory', { id: 9, name: '虚构成品', archived: true }), '#warehouse?kind=finished&record=9&archived=1');
  assert.equal(recordLink('suppliers', { id: 2, name: '虚构纸业' }), '#suppliers?q=' + encodeURIComponent('虚构纸业'));
});

test('页面地址册子不登记没人读的参数：仓储页的 receipt、订单页的 view', () => {
  assert.ok(!Object.hasOwn(pageParams('warehouse', ''), 'receipt'));
  assert.ok(!Object.hasOwn(pageParams('orders', ''), 'view'));
});
