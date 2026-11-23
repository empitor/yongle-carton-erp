// 更正送货单的本机管理员部分（出库日期、换挂、加行）、超订单发货、成品批次和成本配对、按原单重新填写留下的老数据。
// 业务账号的基本用法在 delivery-correction.test.ts。内存库、虚构数据。
import { pageActor } from '../support/actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from '../../server/core/index.js';
import { AppError, one as oneRow, rows } from '../../server/core/index.js';
import { stockItemBatches } from '../../server/flow/index.js';
import { originsOf } from '../../server/finance/costing/costing-origins.js';
import { must, viewAs } from '../support/read-result.js';
import { today } from '../../shared/core/index.js';
import { clerk, localAdmin } from '../support/flow-fixture.js';
import { deliveryCorrectionSetup } from '../support/delivery-correction-fixture.js';

/** 进了超级管理员模式、但不是本机管理员（从域名访问的超级管理员） */
const superUser = (): Actor =>
  (pageActor({ id: 'flow-super', name: '虚构超管', role: 'super_admin', permissions: ['business:edit'], superAdminMode: true, superAdminUntil: Date.now() + 3600000 }));

test('改出库日期、换挂、加行只有本机管理员能做；出库日期不晚于今天、不早于下单日、不晚于送达日', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300']]);
  const denied = (e: unknown) => e instanceof AppError && e.status === 403 && /改出库日期、换订单明细、加行要本机管理员/.test(e.message);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300' }], clerk, { date: '2026-11-01' }), denied);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300', orderLineId: f.second.lines[0].id }], clerk), denied);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300' }, { quantity: '10', orderLineId: f.second.lines[0].id }], superUser()), denied);
  const admin = localAdmin();
  f.flow.markDelivered(d.id, { version: f.flow.get(d.id).version, date: '2026-11-03' }, clerk);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300' }], admin, { date: '2026-11-04' }), /不能晚于已确认的送达日期 2026-11-03/);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300' }], admin, { date: '2026-09-30' }), /不能早于订单 .* 的下单日期 2026-10-01/);
  const rep = f.flow.get(f.correct(d.id, [{ index: 0, quantity: '300' }], admin, { date: '2026-11-01' }).replacementId, 'delivery');
  assert.equal(rep.date, '2026-11-01');
  assert.equal(rep.shippedAt, new Date('2026-11-01T12:00:00+08:00').toISOString(), '出库时间按新日期北京时间中午');
  assert.equal(rep.deliveredAt, '2026-11-03');
  assert.deepEqual(
    f.store.db.prepare("SELECT date FROM stock_movements WHERE source_kind='flow_delivery' AND source_id=?").all(String(rep.id)).map((m) => m.date),
    ['2026-11-01'],
  );
  assert.equal(f.balance(), 700000, '只改日期，库存不变');
  const tomorrow = new Date(Date.parse(today() + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  assert.throws(() => f.preview(rep.id, [{ index: 0, quantity: '300' }], admin, { date: tomorrow }), /出库日期不能晚于今天/);
});

test('本机管理员换挂到同一客户的另一张订单、加一行：两张订单的已发都对', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300']]);
  const admin = localAdmin();
  const plan = f.preview(d.id, [{ index: 0, quantity: '300', orderLineId: f.second.lines[0].id }, { quantity: '100', orderLineId: f.order.lines[1].id }], admin);
  assert.deepEqual(
    plan.orderImpact.map((o) => [o.orderNumber, o.before, o.after]).sort(),
    [[f.order.number, '0', '100'], [f.order.number, '300', '0'], [f.second.number, '0', '300']].sort(),
  );
  const rep = f.flow.get(f.correct(d.id, [{ index: 0, quantity: '300', orderLineId: f.second.lines[0].id }, { quantity: '100', orderLineId: f.order.lines[1].id }], admin).replacementId, 'delivery');
  assert.deepEqual(rep.lines.map((l) => [l.orderId, l.quantity]), [[f.second.id, '300'], [f.order.id, '100']]);
  assert.deepEqual([f.shipped(f.order, 0), f.shipped(f.order, 1), f.shipped(f.second, 0)], [0, 100, 300]);
  assert.equal(f.balance(), 600000);
});

test('数量变多超出订单剩余：不勾拒、勾了没进超级管理员模式拒、没写原因拒；数量变少不卡历史超发', (t) => {
  const f = deliveryCorrectionSetup(t, '2000');
  const d = f.ship([[f.order, 0, '900']]);
  const lines = [{ index: 0, quantity: '1100' }];
  assert.throws(() => f.preview(d.id, lines), (e: unknown) => e instanceof AppError && e.status === 409 && /本次发货超过订单剩余数量.*还能发 1000 只，本次 1100 只/.test(e.message));
  assert.throws(() => f.preview(d.id, lines, clerk, { allowOverdelivery: true, overdeliveryReason: '虚构' }), (e: unknown) => e instanceof AppError && e.status === 403);
  assert.throws(() => f.preview(d.id, lines, superUser(), { allowOverdelivery: true }), /超订单数量发货要写明原因/);
  const over = f.correct(d.id, lines, superUser(), { allowOverdelivery: true, overdeliveryReason: '虚构：客户加单' });
  assert.equal(f.shipped(f.order, 0), 1100);
  // 已经超发的单子改少：业务账号照样能办
  const less = f.correct(over.replacementId, [{ index: 0, quantity: '1050' }]);
  assert.equal(f.shipped(f.order, 0), 1050);
  assert.equal(f.flow.get(less.replacementId, 'delivery').overdeliveryReason, '虚构：客户加单');
});

test('一张送货单两行出同一个成品：更正后成品批次没有多出“其他入库”，成本计算按原两笔出库冲回', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300'], [f.order, 1, '300']]);
  const rep = f.correct(d.id, [{ index: 0, quantity: '250' }, { index: 1, quantity: '300' }]);
  const batches = stockItemBatches(f.store, f.item.id, { allDepleted: true });
  assert.equal(batches.unmatchedUnits, 0);
  assert.deepEqual(batches.open.map((b) => b.remaining), ['450'], '只剩期初一批，送货和冲回成对去掉');
  const [reversal] = rep.movements.reversal;
  const m = oneRow(
    f.store.db,
    rows.stock_movements.pick({ id: true, item_id: true, delta_units: true, source_id: true, date: true }),
    'SELECT id,item_id,delta_units,source_id,date FROM stock_movements WHERE id=?',
    reversal,
  );
  assert.ok(m, '有冲回的那笔流水');
  const found = must(originsOf(f.store.db, [{ ...m, kind: 'finished' }], '2026-11-01').get(m.id), '冲回找到的原单据');
  assert.equal(found.kind === 'reversal' && found.origin?.same, true);
});

test('保存单据不再收更正关系：带了 correctionOf 新建的送货单只是一张普通待送货单，原单也不会被标成已更正', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300']]);
  f.flow.reverse(d.id, { version: f.flow.get(d.id).version, reason: '虚构：发错', acknowledged: true }, clerk);
  const draft = f.flow.save(
    'delivery',
    { date: '2026-11-05', plannedDate: '2026-11-05', customerId: f.customer.id, correctionOf: d.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.item.id, quantity: '280' }] },
    superUser(),
  );
  assert.equal(draft.correctionOf ?? null, null);
  const stored = oneRow(f.store.db, rows.flow_documents.pick({ correction_of: true }), 'SELECT correction_of FROM flow_documents WHERE id=?', draft.id);
  assert.ok(stored, '新建的送货单在库里');
  assert.equal(stored.correction_of, null);
  assert.equal(f.flow.get(d.id).replacedBy ?? null, null);
});

test('老数据：按原单重新填写留下的待送货单（指向已撤销、没被替代的原单）照普通待送货单出库，出库日按当天或补录日，也能取消', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300']]);
  f.flow.reverse(d.id, { version: f.flow.get(d.id).version, reason: '虚构：按原单重填', acknowledged: true }, clerk);
  const legacy = () => {
    const draft = f.flow.save('delivery', { date: '2026-11-05', plannedDate: '2026-11-05', customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.item.id, quantity: '280' }] }, clerk);
    f.store.db
      .prepare("UPDATE flow_documents SET correction_of=?,document=json_set(document,'$.correctionOf',?) WHERE id=?")
      .run(d.id, d.id, draft.id);
    return f.flow.get(draft.id);
  };
  const first = legacy();
  assert.equal(first.correctionOf, d.id);
  const shipped = viewAs(f.base.check(first, {}, clerk), 'delivery');
  assert.equal(shipped.date, today(), '出库日按当天，不沿用原单');
  assert.equal(today(shipped.shippedAt ? new Date(shipped.shippedAt) : undefined), today());
  assert.equal(f.shipped(f.order, 0), 280);
  const second = legacy();
  const cancelled = f.flow.cancel(second.id, { version: second.version, reason: '虚构：不要了', acknowledged: true }, clerk);
  assert.equal(cancelled.status, 'cancelled');
});
