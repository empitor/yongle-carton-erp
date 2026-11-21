// 更正送货单（server/flow/correction/correction.ts + delivery-correction-plan.ts）：业务账号改每行数量、删行，撤销原单、另出替代单，流水只追加。
// 本机管理员改出库日期、换挂、加行，超订单发货，成品批次和成本配对，老样子的数据在 delivery-correction-admin.test.ts。内存库、虚构数据。
import { test } from 'node:test';
// 归档原单要单据流转登记的记录种类（server/flow/deletion.ts，经入口加载）；只引内部文件时单独跑这个文件会缺登记
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { correctDocument, planCorrection } from '../server/flow/index.js';
import { flowStatusText } from '../shared/business/index.js';
import { today } from '../shared/core/index.js';
import { AppError, count } from '../server/core/index.js';
import { clerk, localAdmin } from './flow-fixture.js';
import { deliveryCorrectionSetup } from './delivery-correction-fixture.js';
import { archiveDoc } from './receive-fixture.js';

test('两行 300 + 300 更正成 250 + 300：原单已更正、替代单沿用出库日和确认时间，库存净 +50，订单已发 600 → 550，原流水一条不改', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300'], [f.order, 1, '300']]);
  const before = f.moves();
  const plan = f.preview(d.id, [{ index: 0, quantity: '250' }, { index: 1, quantity: '300' }]);
  assert.deepEqual(plan.stockImpact.map((s) => [s.before, s.after, s.delta]), [['400', '450', '+50']]);
  assert.deepEqual(plan.orderImpact.map((o) => [o.before, o.after]), [['300', '250'], ['300', '300']]);
  assert.deepEqual(plan.lines.map((l) => [l.before, l.after]), [['300', '250'], ['300', '300']]);
  assert.equal(f.balance(), 400000, '预览不写库');
  const result = f.correct(d.id, [{ index: 0, quantity: '250' }, { index: 1, quantity: '300' }]);
  assert.equal(result.verified, true);
  const old = f.flow.get(d.id, 'delivery'),
    rep = f.flow.get(result.replacementId, 'delivery');
  assert.equal(old.status, 'reversed');
  assert.equal(old.replacedBy, rep.id);
  assert.equal(flowStatusText(old), '已更正');
  assert.equal(rep.status, 'confirmed');
  assert.equal(rep.correctionOf, d.id);
  assert.equal(rep.correctionReason, '虚构：点错数量');
  assert.match(rep.number, new RegExp('^SH-' + today().replaceAll('-', '') + '-'), '单号按更正当天');
  assert.deepEqual([rep.date, rep.shippedAt, rep.confirmedAt, rep.shippedBy], [old.date, old.shippedAt, old.confirmedAt, old.shippedBy]);
  assert.deepEqual(rep.lines.map((l) => l.quantity), ['250', '300']);
  assert.equal(f.balance(), 450000);
  assert.deepEqual([f.shipped(f.order, 0), f.shipped(f.order, 1)], [250, 300]);
  assert.match(result.summary, /^送货单 SH-.* 已更正为 SH-.*：虚构外箱 300 只 → 250 只/);
  // 流水只追加：原单两笔不动；冲回按库存品合计一笔 +600，先记，再记替代单两笔出库
  const after = f.moves();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(
    after.slice(before.length).map((m) => [m.source_kind, Number(m.source_id), Number(m.delta_units)]),
    [
      ['flow_reversal', d.id, 600000],
      ['flow_delivery', rep.id, -250000],
      ['flow_delivery', rep.id, -300000],
    ],
  );
  assert.equal(count(f.store.db, 'SELECT count(*) n FROM stock_movement_revisions'), 0);
  // 修改历史：原单、替代单各一条
  assert.deepEqual(
    f.store.db.prepare("SELECT entity,record_id FROM business_audit WHERE action='correct' ORDER BY id").all().map((r) => [r.entity, Number(r.record_id)]),
    [['flow_delivery', d.id], ['flow_delivery', rep.id]],
  );
});

test('已送达的也能更正，送达记录带到替代单上；替代单还能再更正（成链）', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '600']]);
  f.flow.markDelivered(d.id, { version: f.flow.get(d.id).version, date: '2026-11-03' }, clerk);
  const first = f.flow.get(f.correct(d.id, [{ index: 0, quantity: '550' }]).replacementId, 'delivery');
  assert.deepEqual([first.deliveredAt, first.deliveredBy], ['2026-11-03', clerk.name]);
  assert.equal(flowStatusText(first), '已送达');
  const second = f.flow.get(f.correct(first.id, [{ index: 0, quantity: '500' }]).replacementId, 'delivery');
  assert.equal(second.correctionOf, first.id);
  assert.equal(f.flow.get(first.id).replacedBy, second.id);
  assert.equal(f.balance(), 500000);
  assert.equal(f.shipped(f.order, 0), 500);
});

test('库存已发光（0）时把 600 更正成 550 也能办（先记冲回、再记替代出库）；数量变多库存不够拒', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300'], [f.order, 1, '300']]);
  f.ship([[f.order, 0, '400']]);
  assert.equal(f.balance(), 0);
  const rep = f.correct(d.id, [{ index: 0, quantity: '250' }, { index: 1, quantity: '300' }]);
  assert.equal(f.balance(), 50000);
  assert.throws(
    () => f.correct(rep.replacementId, [{ index: 0, quantity: '350' }, { index: 1, quantity: '300' }]),
    (e: unknown) => e instanceof AppError && e.status === 409 && /虚构外箱库存不足：现有50只，本次需扣减100只/.test(e.message),
  );
  assert.equal(f.flow.get(rep.replacementId).status, 'confirmed');
});

test('删掉一行可以；每一行都删、内容没变、已撤销、已被替代、待送货、已归档的拒绝', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '300'], [f.order, 1, '200']]);
  assert.throws(() => f.preview(d.id, []), /至少要留一行；整张没发生请用“撤销这次送货”/);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300' }, { index: 1, quantity: '200' }]), /更正内容和原送货单一样，不用提交/);
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '300' }, { index: 0, quantity: '200' }]), /更正明细重复/);
  const rep = f.correct(d.id, [{ index: 1, quantity: '200' }]);
  assert.deepEqual(f.flow.get(rep.replacementId, 'delivery').lines.map((l) => [l.orderLineId, l.quantity]), [[f.order.lines[1].id, '200']]);
  assert.deepEqual([f.shipped(f.order, 0), f.shipped(f.order, 1)], [0, 200]);
  assert.equal(f.balance(), 800000);
  // 已被替代的原单
  assert.throws(() => f.preview(d.id, [{ index: 0, quantity: '1' }]), (e: unknown) => e instanceof AppError && e.status === 409 && /只能更正有效的已出库送货单/.test(e.message));
  // 待送货的
  const draft = f.flow.save('delivery', { date: '2026-11-05', plannedDate: '2026-11-05', customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.item.id, quantity: '10' }] }, clerk);
  assert.throws(() => f.preview(draft.id, [{ index: 0, quantity: '5' }]), /只能更正有效的已出库送货单；待送货的请直接编辑/);
  // 已撤销的
  const other = f.ship([[f.order, 0, '10']]);
  f.flow.reverse(other.id, { version: f.flow.get(other.id).version, reason: '虚构发错', acknowledged: true }, clerk);
  assert.throws(() => f.preview(other.id, [{ index: 0, quantity: '5' }]), /只能更正有效的已出库送货单/);
  // 已归档的先恢复
  const third = f.ship([[f.order, 0, '10']]);
  archiveDoc(f.flow, third.id, false, clerk, f.flow.get(third.id).version);
  assert.throws(() => f.preview(third.id, [{ index: 0, quantity: '5' }]), /已归档，请先恢复再更正/);
});

test('同一请求号重发原样返回、不会再出一张；换内容 409；预览以后库存变了 409 preview-changed；版本不对 409；没有业务权限 403', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '600']]);
  const v = f.input(d.id, [{ index: 0, quantity: '550' }]),
    plan = planCorrection(f.store, d.id, v, clerk);
  assert.throws(() => planCorrection(f.store, d.id, v, { ...clerk, permissions: [] }), (e: unknown) => e instanceof AppError && e.status === 403);
  assert.throws(() => planCorrection(f.store, d.id, { ...v, expectedVersion: 99 }, clerk), (e: unknown) => e instanceof AppError && e.status === 409 && /送货单版本已改变/.test(e.message));
  // 预览以后库存变了
  f.ship([[f.order, 1, '10']]);
  assert.throws(
    () => correctDocument(f.store, d.id, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, clerk),
    (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'preview-changed',
  );
  const fresh = planCorrection(f.store, d.id, v, clerk),
    request = { ...v, previewDigest: fresh.previewDigest, requestId: randomUUID() };
  const first = correctDocument(f.store, d.id, request, clerk);
  const deliveryCount = () => count(f.store.db, "SELECT count(*) n FROM flow_documents WHERE kind='delivery'");
  const documents = deliveryCount(),
    moves = f.moves().length;
  const again = correctDocument(f.store, d.id, request, clerk);
  assert.equal(again.replacementId, first.replacementId);
  assert.deepEqual([deliveryCount(), f.moves().length], [documents, moves]);
  assert.throws(() => correctDocument(f.store, d.id, { ...request, reason: '虚构另一个原因' }, clerk), (e: unknown) => e instanceof AppError && e.status === 409);
});

test('写库中途失败整笔回滚：单据、流水、订单、请求记录都不变', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '600']]);
  const snapshot = () =>
    Object.fromEntries(
      ['stock_movements', 'flow_documents', 'flow_refs', 'orders', 'operation_requests', 'business_audit'].map((table) => [
        table,
        f.store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(),
      ]),
    );
  const before = snapshot();
  f.store.db.exec(`CREATE TRIGGER fail_delivery_replacement BEFORE INSERT ON stock_movements
    WHEN NEW.source_kind='flow_delivery' BEGIN SELECT RAISE(ABORT, 'fictional replacement failed'); END;`);
  assert.throws(() => f.correct(d.id, [{ index: 0, quantity: '550' }]), /fictional replacement failed/);
  assert.deepEqual(snapshot(), before);
});

test('出库后订单改了单价：只更正数量时替代单沿用出库时的单价、税率，金额按新数量算，提示里说订单现价；换挂、新加的行才按订单现价', (t) => {
  const f = deliveryCorrectionSetup(t);
  const d = f.ship([[f.order, 0, '600']]);
  const shippedPrice = d.lines[0].unitPriceExact;
  // 出库以后订单这一行改成 2 元，另一张订单也是 2 元
  f.store.db.prepare('UPDATE order_lines SET unit_price_e4=20000 WHERE order_id IN (?,?)').run(f.order.id, f.second.id);
  const plan = f.preview(d.id, [{ index: 0, quantity: '550' }]);
  assert.deepEqual([Number(plan.beforeAmount), Number(plan.afterAmount)], [600, 550], '数量改少，金额只随数量变');
  assert.equal(plan.lines[0].unitPrice, shippedPrice);
  assert.ok(plan.warnings.some((w) => /单价现在是 2.*仍按出库时的 1/.test(w)), plan.warnings.join('|'));
  const rep = f.flow.get(f.correct(d.id, [{ index: 0, quantity: '550' }]).replacementId, 'delivery');
  assert.deepEqual([rep.lines[0].unitPriceExact, Number(rep.lines[0].amountExact)], [shippedPrice, 550]);
  // 本机管理员加的一行（另一张订单）：按那条订单明细现在的单价
  const added = f.flow.get(
    f.correct(rep.id, [{ index: 0, quantity: '550' }, { quantity: '10', orderLineId: f.second.lines[0].id }], localAdmin()).replacementId,
    'delivery',
  );
  assert.deepEqual(added.lines.map((l) => Number(l.amountExact)), [550, 20]);
});
