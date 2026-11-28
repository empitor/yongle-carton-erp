import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deliveryPlan } from '../../shared/business/index.js';
import DeliveryPlanGroup from '../../src/warehouse/DeliveryPlanGroup.js';
import { deliveryBody, planLookups, planProblem, shownGroups } from '../../src/warehouse/delivery-plan.js';

test('同客户明细初始按默认厂区合单，拆给别的厂区后每个厂区提交各自的送货单', () => {
  const east = { id: 51, name: '虚构东厂', isDefault: true, contact: '王工', phone: '0001', address: '虚构一路', notes: '' };
  const west = { ...east, id: 52, name: '虚构西厂', isDefault: false, address: '虚构二路' };
  const lines = [11, 12, 13].map((orderLineId) => ({ orderId: 1, orderLineId, stockId: 4, quantity: '20' }));
  const plan = deliveryPlan({ customers: [{ id: 2, sites: [west, east] }], items: [], orders: [], pending: new Map() },
    { preset: { customerId: 2, lines } });
  assert.deepEqual(plan.groups.map((g) => [g.siteId, g.siteName, g.address]), [[east.id, east.name, east.address]]);
  const groups = shownGroups(plan, [], { '2|12|4': '8' }, { '2|12|4': west.id, '2|13|4': west.id });
  const look = planLookups(null, { '2/52': { plannedDate: '2026-11-29' } });
  const submitted = groups.map((g) => deliveryBody(g, look.inputOf(g), false));
  assert.deepEqual(submitted.map((d) => [d.customerId, d.siteId, d.lines.map((l) => [l.orderLineId, l.quantity])]), [
    [2, 51, [[11, '20']]],
    [2, 52, [[12, '8'], [13, '20']]],
  ]);
  assert.equal(submitted[1].plannedDate, '2026-11-29');
});

test('同一客户拆成几张送货单时，名字、校验提示都带上厂区；只有一张时只写客户', () => {
  const east = { id: 51, name: '虚构东厂', isDefault: true, contact: '', phone: '', address: '', notes: '' };
  const west = { ...east, id: 52, name: '虚构西厂', isDefault: false };
  const lines = [11, 12].map((orderLineId) => ({ orderId: 1, orderLineId, stockId: 4, quantity: '20' }));
  const plan = deliveryPlan({ customers: [{ id: 2, sites: [east, west] }], items: [], orders: [], pending: new Map() },
    { preset: { customerId: 2, lines } });
  const one = shownGroups(plan, [], {});
  const two = shownGroups(plan, [], {}, { '2|12|4': west.id });
  // 没有订单数据时每行都算超订单，先写上原因，只看计划日那一句
  const look = planLookups(null, { [two[0].key]: { reason: '虚构' }, [two[1].key]: { plannedDate: '', reason: '虚构' } });
  assert.deepEqual(one.map((g) => look.groupName(g, one)), ['客户']);
  assert.deepEqual(two.map((g) => look.groupName(g, two)), ['客户 · 虚构东厂', '客户 · 虚构西厂']);
  assert.equal(planProblem(two, {}, look), '请填写送给 客户 · 虚构西厂 的计划送货日期。');
});

test('安排送货窗的明细表带上手机排法要的标记：外层 wh-plan-lines，本次送货那格写明叫法；拆单下拉在明细那格里', () => {
  const east = { id: 51, name: '虚构东厂', isDefault: true, contact: '', phone: '', address: '', notes: '' };
  const west = { ...east, id: 52, name: '虚构西厂', isDefault: false };
  const lines = [11, 12].map((orderLineId) => ({ orderId: 1, orderLineId, stockId: 4, quantity: '20', notes: '', key: 'k' + orderLineId }));
  const html = renderToStaticMarkup(h(DeliveryPlanGroup, {
    title: '虚构客户甲', lines, input: { plannedDate: '2026-11-29', reason: '' }, change: () => {}, over: [], locked: false,
    stockName: () => '虚构成品', lineInfo: () => ({ order: 'DD-1', product: '虚构箱', unit: '只' }),
    setQuantity: () => {}, remove: () => {}, destination: { siteId: east.id, sites: [east, west], assign: () => {} },
  }));
  assert.match(html, /class="line-table span-full wh-plan-lines"/);
  assert.equal((html.match(/<td class="num" data-label="本次送货">/g) || []).length, 2);
  assert.equal((html.match(/<td class="wh-cell-text">[^]*?<select class="wh-site-split"/g) || []).length, 2);
});
