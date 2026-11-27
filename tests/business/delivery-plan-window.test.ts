// 安排送货窗口的窗口状态（src/warehouse/delivery-plan.ts）：删行、改数、预填的输入、交之前的检查、交给服务端的内容。
// 排法本身在共用的 deliveryPlan，测试在 delivery-plan.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { today } from '../../shared/core/index.js';
import { deliverySiteSnapshot } from '../../shared/business/index.js';
import { deliveryBody, emptyText, planLookups, planProblem, shownGroups } from '../../src/warehouse/delivery-plan.js';

const planLine = (orderLineId: number, stockId: number, quantity: string) => ({ orderId: 1, orderLineId, stockId, quantity, notes: '' });
const site = { id: 7, name: '虚构一厂', address: '虚构路1号', contact: '虚构甲', phone: '000-1', notes: '', isDefault: true };
const plan = {
  groups: [
    { customerId: 1, sites: [site], ...deliverySiteSnapshot(site), lines: [planLine(11, 7, '30'), planLine(12, 8, '5')] },
    { customerId: 2, sites: [], ...deliverySiteSnapshot(undefined), lines: [planLine(21, 7, '10')] },
  ],
};

test('窗口里的送货单：人删掉的行不显示，删空的送货单整张不显示，数量用人改过的', () => {
  const groups = shownGroups(plan, ['1|12|8', '2|21|7'], { '1|11|7': '25' });
  assert.deepEqual(
    groups.map((g) => [g.customerId, g.lines.map((l) => [l.key, l.quantity])]),
    [[1, [['1|11|7', '25']]]],
  );
});

test('每张送货单的计划日预填今天，超订单用人填写的原因', () => {
  const [g] = shownGroups(plan, [], {});
  const look = planLookups(null, { '1/7': { reason: '客户要多送' } });
  assert.deepEqual(look.inputOf(g), { plannedDate: today(), reason: '客户要多送' });
  assert.equal(look.customerName(1), '客户', '读到数据之前没有客户名');
  assert.deepEqual(look.overOf(g.lines), []);
});

test('交之前查：没写计划日、超订单没写原因的拦下说清给谁；已经建好的那张不再查', () => {
  const groups = shownGroups(plan, [], {});
  const base = planLookups(null, { '1/7': { plannedDate: '' } });
  assert.match(planProblem(groups, {}, base), /请填写送给 客户 的计划送货日期/);
  const created = { '1/7': 'SH-1' };
  assert.equal(planProblem(groups, created, base), '');
  const over = { ...planLookups(null, { '2/': { reason: '  ' } }), overOf: () => ['2|21|7'] };
  assert.match(planProblem(groups, created, over), /超过订单数量，请写明超订单的原因/);
  const reasoned = { ...planLookups(null, { '2/': { reason: '客户要多送' } }), overOf: () => ['2|21|7'] };
  assert.equal(planProblem(groups, created, reasoned), '');
});

test('交给服务端的送货单：超订单时带上去掉首尾空白的原因，不超时不带；行里不带窗口用的键', () => {
  const [g] = shownGroups(plan, [], {});
  const input = { plannedDate: '2026-11-25', reason: ' 客户要多送 ' };
  const over = deliveryBody(g, input, true);
  assert.equal(over.allowOverdelivery, true);
  assert.equal(over.siteId, 7);
  assert.equal(over.overdeliveryReason, '客户要多送');
  assert.deepEqual(over.lines, [planLine(11, 7, '30'), planLine(12, 8, '5')]);
  const normal = deliveryBody(g, input, false);
  assert.deepEqual([normal.allowOverdelivery, normal.overdeliveryReason, normal.plannedDate], [false, '', '2026-11-25']);
});

test('一张都排不出来时：对不上的指向上面的原因，按成品、按订单各说各的', () => {
  assert.match(emptyText(true, true), /对不上/);
  assert.match(emptyText(false, true), /选的成品没有客户订单在等/);
  assert.match(emptyText(false, false), /选的订单没有可送的库存/);
});
