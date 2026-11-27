import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryPlan } from '../../shared/business/index.js';
import { deliveryBody, planLookups, shownGroups } from '../../src/warehouse/delivery-plan.js';

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
