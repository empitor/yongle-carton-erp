// 送货出库和送达（server/flow/、server/documents/）：导出送货单就是出库，确认送达只记送达，撤销送货加回库存。
// 出库日期的规则见 delivery-ship-date.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WarehouseDaily } from '../server/flow/daily.js';
import { customerSchema, orderSchema, today } from '../shared/core/domain.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { flowStatusLabel } from '../shared/business/physical-flow.js';
import type { DeliveryDaily } from '../shared/business/index.js';
import { allocateShipments } from '../src/warehouse/ReadyToShip.js';
import { deliverySetup, shift } from './delivery-fixture.js';
import { deliveryForm } from '../server/documents/delivery-form.js';
import { archiveDoc } from './receive-fixture.js';
import { AppError, count, one as oneRow, rows, type Actor } from '../server/core/index.js';
import { actor } from './actor-fixture.js';

const exportShip = (f: ReturnType<typeof deliverySetup>, id: number, version: number) =>
  f.docs.generate({ kind: 'delivery', id, format: 'xlsx', markShipped: true, expectedVersion: version, requestId: randomUUID() }, actor);

test('安排送货后是待送货；导出送货单完整交付后出库扣库存、变送货中；确认送达后已送达且不再动库存', async (t) => {
  const f = deliverySetup(t);
  assert.equal(flowStatusLabel(f.flow.get(f.delivery.id)), '待送货');
  const file = await exportShip(f, f.delivery.id, f.delivery.version);
  assert.doesNotMatch(file.filename, /预览|非正式/, '导出出库的是正式送货单');
  assert.equal(f.balance(), 1000_000, '文件还没交付完不出库');
  f.docs.delivered(file.exportId, actor);
  f.docs.complete(file.exportId, file.sha256, actor);
  const shipped = f.flow.get(f.delivery.id, 'delivery');
  assert.equal(shipped.status, 'confirmed');
  assert.ok(shipped.shippedAt);
  assert.equal(flowStatusLabel(shipped), '送货中');
  assert.equal(f.balance(), 400_000, '导出出库时扣库存');
  assert.equal(f.store.order(f.order.id)?.lines[0].remainingQuantity, 400, '算进订单已发');
  // 再导出一次不重复出库
  const again = await exportShip(f, f.delivery.id, shipped.version);
  f.docs.delivered(again.exportId, actor);
  f.docs.complete(again.exportId, again.sha256, actor);
  assert.equal(f.balance(), 400_000);
  const delivered = f.flow.markDelivered(f.delivery.id, { version: f.flow.get(f.delivery.id).version, date: today() }, actor);
  assert.equal(delivered.deliveredAt, today());
  assert.equal(flowStatusLabel(delivered), '已送达');
  assert.equal(f.balance(), 400_000, '确认送达不动库存');
});

test('库存不够就不生成出库送货单；待送货的不能确认送达；直接核对出库也变送货中', async (t) => {
  const f = deliverySetup(t, '500');
  await assert.rejects(exportShip(f, f.delivery.id, f.delivery.version));
  assert.equal(f.balance(), 500_000);
  assert.throws(() => f.flow.markDelivered(f.delivery.id, { version: f.delivery.version }, actor), /已出库的送货单/);
  const g = deliverySetup(t);
  assert.equal(flowStatusLabel(g.ship(g.delivery.id)), '送货中');
});

test('确认送达：不填日期按北京时间记今天，不能晚于今天、早于出库日、不能是不存在的日期；版本旧了拒绝，重复确认原样返回；没有编辑权限、已归档的拒绝', (t) => {
  const f = deliverySetup(t);
  const shipped = f.ship(f.delivery.id);
  const mark = (input: object, who: Actor = actor) => f.flow.markDelivered(f.delivery.id, { version: shipped.version, ...input }, who);
  assert.throws(() => mark({ date: shift(1) }), /不能晚于今天/);
  assert.throws(() => mark({ date: shift(-1) }), /不能早于出库日期/);
  assert.throws(() => mark({ date: '2026-02-30' }));
  assert.throws(() => mark({ version: shipped.version + 5 }), /已变化/);
  assert.throws(() => mark({}, { ...actor, permissions: [] }), (e: unknown) => e instanceof AppError && e.status === 403);
  const done = mark({});
  assert.deepEqual([done.deliveredAt, done.deliveredBy], [today(), actor.name]);
  // 双击、网络重试：拿着旧版本号再提交一次，不报错，也不再写一次
  assert.equal(mark({}).version, done.version);
  assert.equal(count(f.store.db, "SELECT COUNT(*) n FROM business_audit WHERE action='delivered'"), 1);
  // 已归档的送货单不能确认送达
  const other = f.ship(f.arrange(today(), '10').id);
  archiveDoc(f.flow, other.id, false, actor, other.version);
  assert.throws(() => f.flow.markDelivered(other.id, { version: f.flow.get(other.id).version }, actor), /只有已出库的送货单能确认送达/);
});

test('送货发错发重了：普通业务账号（不进超级管理员模式）也能撤销，库存加回、订单已发减回，单据保留为已撤销', (t) => {
  const f = deliverySetup(t);
  const shipped = f.ship(f.delivery.id);
  assert.equal(f.store.order(f.order.id)?.lines[0].remainingQuantity, 400);
  assert.throws(() => f.flow.reverse(f.delivery.id, { version: shipped.version, reason: '', acknowledged: true }, actor), '要写原因');
  const undone = f.flow.reverse(f.delivery.id, { version: shipped.version, reason: '虚构：同一批货发了两次', acknowledged: true }, actor);
  assert.deepEqual([undone.status, undone.reversal?.reason, flowStatusLabel(undone)], ['reversed', '虚构：同一批货发了两次', '已撤销']);
  assert.equal(f.balance(), 1000_000, '库存加回');
  assert.equal(f.store.order(f.order.id)?.lines[0].remainingQuantity, 1000, '订单已发减回');
  const trail = oneRow(f.store.db, rows.business_audit.pick({ source: true }), "SELECT source FROM business_audit WHERE action='reverse'");
  assert.ok(trail, '记了撤销的审计');
  assert.equal(trail.source, AUDIT_SOURCE.page, '在页面上撤销，来源记页面');
});

test('一张送货单两行出同一个成品库存（两张订单）：详情每行只挂自己那一笔出库，撤销扣回的挂第一行，同一笔不在两行里重复', (t) => {
  const f = deliverySetup(t);
  const second = f.store.saveOrder(
    orderSchema.parse({
      customerId: f.order.customerId,
      orderDate: shift(-400),
      deliveryDate: '2026-11-25',
      status: '已确认',
      lines: [{ productId: f.order.lines[0].productId, quantity: 500, unit: '只', unitPriceCents: 100 }],
    }),
  );
  // 待送货那张改成两行：订单甲 300 只、订单乙 200 只，都从同一个成品库存出
  const lines = [
    { orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.item.id, quantity: '300' },
    { orderId: second.id, orderLineId: second.lines[0].id, stockId: f.item.id, quantity: '200' },
  ];
  const draft = f.flow.save('delivery', { date: '2026-11-10', customerId: f.order.customerId, lines, version: f.delivery.version }, actor, f.delivery.id);
  const shipped = f.ship(draft.id);
  const record = () => {
    const found = new WarehouseDaily(f.store).records('delivery').find((d) => d.id === draft.id);
    assert.ok(found, '台账里有这张送货单');
    return found;
  };
  const ids = (r: DeliveryDaily) => r.lines.flatMap((l) => l.movements.map((m) => m.id));
  const before = record();
  assert.deepEqual(before.lines.map((l) => l.movements.map((m) => Number(m.delta_units))), [[-300_000], [-200_000]]);
  assert.equal(new Set(ids(before)).size, ids(before).length, '同一笔流水只出现在一行');
  f.flow.reverse(draft.id, { version: shipped.version, reason: '虚构：发重了', acknowledged: true }, actor);
  const after = record();
  assert.deepEqual(
    after.lines.map((l) => l.movements.map((m) => [m.source_kind, Number(m.delta_units)])),
    [
      [
        ['flow_delivery', -300_000],
        ['flow_reversal', 500_000],
      ],
      [['flow_delivery', -200_000]],
    ],
  );
  assert.equal(new Set(ids(after)).size, ids(after).length);
});

test('送货单上的金额按两位小数写', (t) => {
  const f = deliverySetup(t);
  const { form } = deliveryForm(f.store, f.ship(f.delivery.id).id);
  assert.equal(form.lineData?.[0].amount, '600.00');
});

test('送货单没填收货地址、联系人、电话：导出印“未记录”，不拿客户档案的顶上', (t) => {
  const f = deliverySetup(t);
  const { customerId } = f.flow.get(f.delivery.id, 'delivery');
  const customer = f.store.customer(customerId) ?? assert.fail('有客户');
  f.store.saveCustomer(
    customerSchema.parse({ ...customer, address: '虚构客户档案地址', contact: '虚构档案联系人', phone: '000-档案' }),
    customerId,
    customer.version,
  );
  const printed = (id: number) => {
    const fields = deliveryForm(f.store, id).form.fields;
    return ['收货地址', '客户联系信息'].map((name) => fields.find(([label]) => label === name)?.[1]);
  };
  assert.deepEqual(printed(f.delivery.id), ['未记录', '未记录']);
  const filled = f.arrange('2026-11-11', '10', { address: '虚构收货地址', contact: '虚构收货人', phone: '000-111' });
  assert.deepEqual(printed(filled.id), ['虚构收货地址', '虚构收货人 · 000-111']);
});

test('仓库页“可发货”勾选的几行：和按订单安排送货同一个算法，按交期先后分同一份可用量，合计不超过可用；没勾的不占', () => {
  const line = (id: number, productId: number, remainingQuantity: number) => ({ id, productId, productName: '虚构箱' + productId, quantity: remainingQuantity, remainingQuantity, unit: '只' });
  const order = (id: number, deliveryDate: string, lines: ReturnType<typeof line>[]) => ({ id, number: 'DD-' + id, customerId: 1, status: '已确认', deliveryDate, lines });
  const orders = [order(1, '2026-11-01', [line(11, 1, 80)]), order(2, '2026-11-02', [line(21, 1, 50)]), order(3, '2026-11-03', [line(31, 1, 10)]), order(4, '2026-11-04', [line(41, 2, 30)])];
  const items = [
    { id: 7, productId: 1, availableUnits: 100000 },
    { id: 8, productId: 2, availableUnits: 20000 },
  ];
  const first = allocateShipments(orders, items, ['1:11', '2:21', '4:41']);
  assert.deepEqual(Object.fromEntries(first.allocated), { '1:11': 80000, '2:21': 20000, '4:41': 20000 });
  assert.deepEqual([first.left.get(7), first.left.get(8)], [0, 0]);
  // 用尽后再勾也分不到；取消前面的行，余量给后面的行，和勾的先后无关
  assert.equal(allocateShipments(orders, items, ['1:11', '2:21', '3:31']).allocated.has('3:31'), false);
  const later = allocateShipments(orders, items, ['3:31', '2:21']);
  assert.deepEqual(Object.fromEntries(later.allocated), { '2:21': 50000, '3:31': 10000 });
  assert.equal(later.left.get(7), 40000);
});

test('送货页默认只读还要处理的和最近 90 天的：很早的待送货、送货中照样列出，早就送达的不读；要全部时 scope=all', (t) => {
  const f = deliverySetup(t, '5000');
  const longAgo = shift(-200);
  const oldPending = f.arrange(longAgo, '10'); // 很早安排、一直没送
  const oldTransit = f.arrange(longAgo, '10');
  f.ship(oldTransit.id, { shipDate: longAgo }); // 很早出库、一直没确认送达
  const oldDone = f.arrange(longAgo, '10');
  f.ship(oldDone.id, { shipDate: longAgo });
  f.flow.markDelivered(oldDone.id, { version: f.flow.get(oldDone.id).version, date: longAgo }, actor);
  const recentDone = f.arrange(shift(-10), '10');
  f.ship(recentDone.id, { shipDate: shift(-10) });
  const daily = new WarehouseDaily(f.store);
  const ids = (raw: Record<string, unknown>) => daily.get({ kind: 'delivery', ...raw }).records.map((r) => r.id);
  const recent = ids({ scope: 'recent' });
  for (const d of [oldPending, oldTransit, recentDone, f.delivery]) assert.ok(recent.includes(d.id), '还要处理的和最近的要列出：' + d.id);
  assert.ok(!recent.includes(oldDone.id), '200 天前就送达的不读');
  assert.ok(ids({ scope: 'all' }).includes(oldDone.id));
  assert.ok(ids({ scope: 'recent', days: 365 }).includes(oldDone.id), '放宽天数就能读到');
});
