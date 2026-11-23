// 送货单的出库日（server/flow/、server/documents/export-delivery.ts）：按实际出库那天记，补录可以指定但有上下限，
// 纸上印的和系统里记的一致，跨零点不挪；更正送货单时出库日的规则（沿用、本机管理员改出库日）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BusinessDocuments } from '../../server/documents/service.js';
import { today } from '../../shared/core/domain.js';
import { localAdministratorActor, type Store, type Actor } from '../../server/core/index.js';
import { flowFixture, localAdmin } from '../support/flow-fixture.js';
import { correctDocument, planCorrection } from '../../server/flow/index.js';
import { deliverySetup, shift } from '../support/delivery-fixture.js';
import type { z } from 'zod';
import type { FlowService } from '../../server/flow/index.js';
import { deliveryCorrectionPreviewSchema } from '../../shared/business/index.js';
import type { BusinessForm } from '../../shared/documents/index.js';
import { actor } from '../support/actor-fixture.js';

const owner = () => localAdministratorActor({ ...actor, role: 'super_admin', superAdminMode: true, superAdminUntil: Date.now() + 3600000 });
/** 送货更正的一行（deliveryCorrectionPreviewSchema 收的样子） */
type CorrectionLine = z.input<typeof deliveryCorrectionPreviewSchema>['lines'][number];
/** 更正一张已出库的送货单（server/flow/correction/correction.ts），返回替代单 */
const correct = (f: { store: Store; flow: FlowService }, id: number, lines: CorrectionLine[], who: Actor, extra: Record<string, unknown> = {}) => {
  const v = { expectedVersion: f.flow.get(id).version, reason: '虚构：数量错了', lines, ...extra };
  return f.flow.get(correctDocument(f.store, id, { ...v, previewDigest: planCorrection(f.store, id, v, who).previewDigest, requestId: randomUUID() }, who).replacementId, 'delivery');
};
const movementDates = (f: ReturnType<typeof deliverySetup>, id: number) =>
  f.store.db.prepare("SELECT date FROM stock_movements WHERE source_kind='flow_delivery' AND source_id=?").all(String(id)).map((r) => r.date);

test('出库按实际出库那天记：上个月安排的送货单今天出库，单据日期和出库流水都是今天，原来的日期留作计划送货日；补录可以指定出库日但不能晚于今天', (t) => {
  const f = deliverySetup(t);
  const lastMonth = shift(-35);
  const old = f.arrange(lastMonth, '100');
  f.flow.shipDelivery(old.id, old.version, actor);
  const shipped = f.flow.get(old.id, 'delivery');
  assert.deepEqual([shipped.date, shipped.actualDate], [today(), today()]);
  assert.equal(shipped.plannedDate, lastMonth, '安排的日期还在，作为计划送货日');
  assert.deepEqual(movementDates(f, old.id), [today()]);
  // 补录：出库日可以指定，不能晚于今天
  const back = f.arrange(shift(-3), '50');
  assert.throws(() => f.ship(back.id, { shipDate: shift(1) }), /出库日期不能晚于今天/);
  assert.equal(f.flow.get(back.id).status, 'draft');
  f.ship(back.id, { shipDate: shift(-2) });
  assert.equal(f.flow.get(back.id).date, shift(-2));
  assert.deepEqual(movementDates(f, back.id), [shift(-2)]);
});

test('补录出库日不能早于订单的下单日期，不是送货单不能填；更正已出库的送货单沿用原出库日和送达记录，不挪到今天', (t) => {
  const f = deliverySetup(t, '3000');
  assert.throws(() => f.ship(f.arrange(shift(-1), '10').id, { shipDate: shift(-401) }), new RegExp('不能早于订单 .* 的下单日期 ' + shift(-400)));
  // 不是送货单：带了出库日期就拒收
  const supplier = f.ops.saveSupplier({ name: '虚构供应商-出库日' }, actor);
  const arrival = f.flow.save('arrival', { date: shift(-1), supplierId: supplier.id, reference: '虚构送货单-出库日', lines: [{ item: { name: '虚构纸板', unit: '张' }, quantity: '10' }] }, actor);
  assert.throws(() => f.ship(arrival.id, { shipDate: shift(-1) }), /只有送货单出库时能填出库日期/);
  // 前天出库、昨天送达，今天发现数量错了：更正送货单，出库日和送达记录都照旧
  const shipped = f.arrange(shift(-2), '20');
  f.ship(shipped.id, { shipDate: shift(-2) });
  f.flow.markDelivered(shipped.id, { version: f.flow.get(shipped.id).version, date: shift(-1) }, actor);
  const before = f.flow.get(shipped.id, 'delivery');
  const after = correct(f, shipped.id, [{ index: 0, quantity: '25' }], actor);
  assert.equal(after.date, shift(-2), '更正后的送货单还是前天出库');
  assert.equal(after.shippedAt, before.shippedAt);
  assert.equal(after.deliveredAt, shift(-1), '送达记录也带过来');
});

test('本机管理员更正时改已出库送货单的日期：出库时间跟着改，送达日期校验按新日期', (t) => {
  const f = deliverySetup(t, '3000');
  f.flow.shipDelivery(f.delivery.id, f.delivery.version, actor);
  const shipped = f.flow.get(f.delivery.id, 'delivery');
  const after = correct(f, shipped.id, [{ index: 0, quantity: shipped.lines[0].quantity }], owner(), { date: shift(-3) });
  assert.equal(after.date, shift(-3));
  assert.ok(after.shippedAt, '替代单有出库时间');
  assert.equal(today(new Date(after.shippedAt)), shift(-3), '出库时间跟着单据日期');
  f.flow.markDelivered(after.id, { version: after.version, date: shift(-2) }, actor);
  assert.equal(f.flow.get(after.id, 'delivery').deliveredAt, shift(-2));
});

test('本机管理员更正时给已出库送货单加行：替代单的出库排在之后的入库后面，不算成负库存；改出库日不能晚于今天和送达日', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const admin = localAdmin();
  const f = flowFixture(admin);
  t.after(() => f.store.close());
  const o1 = f.order(50),
    o2 = f.order(50);
  // 先建待送货（这时还没库存），过一会儿再入库、再出库：新加的行要是按建单时间排，会排到入库前面
  const d = f.draft('delivery', { customerId: f.customer.id, lines: [{ orderId: o1.id, orderLineId: o1.lines[0].id, stockId: f.finished.id, quantity: '20' }] });
  t.mock.timers.tick(60_000);
  f.stockIn('100');
  f.confirmId(d.id, { shipDate: '2026-10-28' });
  const added = correct(f, d.id, [{ index: 0, quantity: '20' }, { quantity: '10', orderLineId: o2.lines[0].id }], admin);
  assert.equal(added.lines.length, 2);
  assert.equal(f.ops.balance(f.finished.id), 70_000);
  f.flow.markDelivered(added.id, { version: added.version, date: '2026-10-29' }, admin);
  const keep = [{ index: 0, quantity: '20' }, { index: 1, quantity: '10' }];
  assert.throws(() => correct(f, added.id, keep, admin, { date: '2026-11-05' }), /不能晚于已确认的送达日期 2026-10-29/);
  assert.throws(() => correct(f, added.id, keep, admin, { date: '2099-03-01' }), /出库日期不能晚于今天/);
});

test('导出送货单出库：纸上印的是今天出库（送货日期），不是当初安排的日子；以后补打也一样', async (t) => {
  const f = deliverySetup(t);
  let printed: BusinessForm | null = null;
  const docs = new BusinessDocuments(f.store, async (form) => {
    printed = form;
    return Buffer.from('虚构送货单文件');
  });
  const arranged = f.arrange(shift(-5), '100');
  const dateOf = () => {
    assert.ok(printed, '排了一份送货单');
    return Object.fromEntries(printed.fields.filter(([k]) => /送货日期/.test(k)));
  };
  const file = await docs.generate({ kind: 'delivery', id: arranged.id, format: 'xlsx', markShipped: true, expectedVersion: arranged.version, requestId: randomUUID() }, actor);
  assert.deepEqual(dateOf(), { 送货日期: today() });
  docs.delivered(file.exportId, actor);
  docs.complete(file.exportId, file.sha256, actor);
  assert.equal(f.flow.get(arranged.id).date, today(), '系统里记的出库日和纸上一致');
  await docs.generate({ kind: 'delivery', id: arranged.id, format: 'xlsx', expectedVersion: f.flow.get(arranged.id).version, requestId: randomUUID() }, actor);
  assert.deepEqual(dateOf(), { 送货日期: today() }, '补打也是出库那天');
});

test('导出并出库跨了北京时间零点：出库日按纸上印的送货日期，不挪到第二天', async (t) => {
  // 北京时间 2026-11-10 23:59:50 生成文件，过了零点才下载交付完成
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T15:59:50Z') });
  const f = deliverySetup(t);
  const printed: BusinessForm[] = [];
  const docs = new BusinessDocuments(f.store, async (form) => {
    printed.push(form);
    return Buffer.from('虚构送货单文件');
  });
  const file = await docs.generate(
    { kind: 'delivery', id: f.delivery.id, format: 'xlsx', markShipped: true, expectedVersion: f.delivery.version, requestId: randomUUID() },
    actor,
  );
  assert.deepEqual(printed[0].fields.find(([label]) => label === '送货日期'), ['送货日期', '2026-11-10'], '纸上印的是生成文件那天');
  assert.equal(file.shipDate, '2026-11-10', '印上去的日期记进导出记录');
  t.mock.timers.tick(20_000);
  assert.equal(today(), '2026-11-11');
  docs.delivered(file.exportId, actor);
  docs.complete(file.exportId, file.sha256, actor);
  const shipped = f.flow.get(f.delivery.id, 'delivery');
  assert.equal(shipped.status, 'confirmed');
  assert.equal(shipped.date, '2026-11-10', '出库日和纸上一致');
  assert.equal(today(new Date(String(shipped.shippedAt))), '2026-11-10');
  assert.deepEqual(movementDates(f, f.delivery.id), ['2026-11-10'], '出库流水也记在那天');
  assert.equal(f.balance(), 400_000);
});
