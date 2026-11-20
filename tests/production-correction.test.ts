// 更正完工单（server/flow/correction.ts + production-correction-plan.ts）：超级管理员模式改合格数、报废数、领料；
// 本机管理员另能改完工日期、产品、生产任务。撤销原单、另出替代单，流水只追加。内存库、虚构数据。
// 末尾一条守三种更正（到货、送货、完工）同一请求号重发交回的结果和第一次一样。
import { pageActor } from './actor-fixture.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../server/core/auth.js';
import { AppError, count, one, rows } from '../server/core/index.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { stockItemBatches } from '../server/flow/stock-batches.js';
import { completionOrigin, originOf } from '../server/finance/costing-origins.js';
import type { Store } from '../server/core/db.js';
import { productSchema } from '../shared/core/domain.js';
import { businessFixture, clerk, flowFixture } from './flow-fixture.js';
import { correctionFixture, ofKind } from './receive-fixture.js';
import { deliveryCorrectionSetup } from './delivery-correction-fixture.js';

/** 进了超级管理员模式、但不是本机管理员（从域名访问的超级管理员） */
const superUser = (): Actor =>
  pageActor({ id: 'flow-super', name: '虚构超管', role: 'super_admin', permissions: ['business:edit'], superAdminMode: true, superAdminUntil: Date.now() + 3600000 });
/** 没有权限（403）的出错 */
const forbidden = (e: unknown): e is AppError => e instanceof AppError && e.status === 403;

/** 纸板 100 张、任务 1000 只、完工 good 只（领 100 张纸板）；ship 把成品发给订单 */
function setup(t: TestContext, good = '1000') {
  const f = businessFixture();
  t.after(() => f.store.close());
  f.arrival('100');
  const task = f.task('1000');
  const done = f.confirm('production', {
    taskId: task.id,
    productId: f.product.id,
    finishedStockId: f.finished.id,
    goodQuantity: good,
    operator: '虚构员工',
    materials: [{ stockId: f.raw.id, issued: '100', returned: '0' }],
  });
  const ship = (quantity: string) => {
    const d = f.flow.save('delivery', { date: '2026-10-28', plannedDate: '2026-10-28', customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.finished.id, quantity }] }, f.actor);
    return f.flow.confirm(d.id, { previewDigest: f.flow.preview(d.id, f.actor).previewDigest, requestId: randomUUID(), acknowledged: true, shipDate: '2026-10-28' }, f.actor);
  };
  const input = (id: number, extra: Record<string, unknown>) => ({ expectedVersion: f.flow.get(id).version, reason: '虚构：登记多了', ...extra });
  const preview = (id: number, extra: Record<string, unknown>, who: Actor = superUser()) => ofKind(planCorrection(f.store, id, input(id, extra), who), 'production');
  const correct = (id: number, extra: Record<string, unknown>, who: Actor = superUser()) => {
    const v = input(id, extra),
      plan = planCorrection(f.store, id, v, who);
    return ofKind(correctDocument(f.store, id, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, who), 'production');
  };
  const balance = (id: number) => f.ops.repo.balance(id);
  return { ...f, task, done, ship, preview, correct, balance };
}

test('完工 1000 已发 800：撤销被拒，更正成 900（领料 100 → 90）能办；批次由替代单接手剩 100，成本找得到原完工和原领料', (t) => {
  const f = setup(t);
  f.ship('800');
  assert.deepEqual([f.balance(f.finished.id), f.balance(f.raw.id)], [200000, 0]);
  assert.throws(
    () => f.flow.reverse(f.done.id, { version: f.flow.get(f.done.id).version, reason: '虚构', acknowledged: true }, f.actor),
    /撤销要扣回.*不够扣。.*改用“更正完工单”/,
  );
  const plan = f.preview(f.done.id, { goodQuantity: '900', materials: [{ index: 0, issued: '90' }] });
  assert.deepEqual(plan.good, { before: '1000', after: '900' });
  assert.deepEqual(plan.materials.map((m) => [m.issued.before, m.issued.after]), [['100', '90']]);
  assert.deepEqual(plan.taskImpact.map((x) => [x.before, x.after, x.planned]), [['1000', '900', '1000']]);
  const result = f.correct(f.done.id, { goodQuantity: '900', materials: [{ index: 0, issued: '90' }] });
  const old = f.flow.get(f.done.id, 'production'),
    rep = f.flow.get(result.replacementId, 'production');
  assert.deepEqual([old.status, old.replacedBy, rep.status, rep.correctionOf], ['reversed', rep.id, 'confirmed', f.done.id]);
  assert.deepEqual([rep.date, rep.confirmedAt, rep.operator, rep.taskId], [old.date, old.confirmedAt, old.operator, old.taskId]);
  assert.deepEqual([f.balance(f.finished.id), f.balance(f.raw.id)], [100000, 10000]);
  assert.equal(f.flow.get(f.task.id, 'task').completed, '900');
  assert.match(result.summary, /^完工单 DJ-.* 已更正为 DJ-.*：合格 1000 只 → 900 只；虚构纸板 领用 100 → 90 张/);
  const batches = stockItemBatches(f.store, f.finished.id, { allDepleted: true });
  assert.equal(batches.unmatchedUnits, 0);
  assert.deepEqual(batches.open.map((b) => [b.documentId, b.remaining]), [[rep.id, '100']]);
  // 冲回：成品一笔 -1000、纸板一笔 +100，都按库存品合计
  const movement = rows.stock_movements.pick({ id: true, item_id: true, delta_units: true, source_id: true, date: true });
  const row = (id: string) => {
    const m = one(f.store.db, movement, 'SELECT id,item_id,delta_units,source_id,date FROM stock_movements WHERE id=?', id);
    assert.ok(m, '流水 ' + id + ' 应在库里');
    return m;
  };
  const reversals = result.movements.reversal.map(row);
  assert.deepEqual(reversals.map((m) => m.delta_units).sort((a, b) => a - b), [-1000000, 100000]);
  const finishedBack = reversals.find((m) => m.item_id === f.finished.id),
    rawBack = reversals.find((m) => m.item_id === f.raw.id);
  assert.ok(finishedBack && rawBack);
  assert.deepEqual(completionOrigin(f.store.db, finishedBack, '2026-10-01'), { same: true });
  const found = originOf(f.store.db, { ...rawBack, kind: 'raw' }, '2026-10-01');
  assert.equal(found.kind === 'reversal' && found.origin?.same, true);
});

test('权限和拦下：没进超级管理员模式 403；合格报废都 0 提示撤销；没变不用提交；非本机管理员改日期、产品、任务 403', (t) => {
  const f = setup(t);
  assert.throws(() => f.preview(f.done.id, { goodQuantity: '900' }, clerk), forbidden);
  assert.throws(() => f.preview(f.done.id, { goodQuantity: '0', scrapQuantity: '0' }), /合格、报废都是 0.*撤销这次完工/);
  assert.throws(() => f.preview(f.done.id, { goodQuantity: '1000' }), /更正内容和原完工单一样，不用提交/);
  const denied = (e: unknown) => forbidden(e) && /改完工日期、产品、生产任务要本机管理员/.test(e.message);
  assert.throws(() => f.preview(f.done.id, { goodQuantity: '900', date: '2026-10-26' }), denied);
  assert.throws(() => f.preview(f.done.id, { goodQuantity: '900', taskId: null }), denied);
  // 生产任务不进更正
  assert.throws(() => f.preview(f.task.id, { goodQuantity: '900' }), /生产任务不能更正/);
});

test('超计划只提示，“已入库”不算原单自己；加一行衬板、再更正一次成链', (t) => {
  const f = setup(t);
  f.arrival('50');
  const glueIn = f.ops.repo.items(true, f.glue.id)[0];
  f.ops.move(f.glue.id, { action: 'in', quantity: '20', date: '2026-10-20', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: glueIn.version }, f.actor);
  const over = f.preview(f.done.id, { goodQuantity: '1100' });
  assert.ok(over.warnings.some((w: string) => /超过生产计划数量.*已核对入库 0 只/.test(w)), over.warnings.join('|'));
  const first = f.correct(f.done.id, { goodQuantity: '1100', materials: [{ index: 0, issued: '100' }, { stockId: f.glue.id, issued: '20', returned: '5' }] });
  assert.equal(f.balance(f.glue.id), 5000);
  assert.equal(f.flow.get(f.task.id, 'task').completed, '1100');
  const second = f.correct(first.replacementId, { goodQuantity: '1000', materials: [{ index: 0, issued: '100' }] });
  assert.equal(f.flow.get(first.replacementId).replacedBy, second.replacementId);
  assert.deepEqual([f.balance(f.finished.id), f.balance(f.glue.id), f.balance(f.raw.id)], [1000000, 20000, 50000]);
  assert.equal(f.flow.get(f.task.id, 'task').completed, '1000');
});

test('本机管理员换产品（换成品库存）、不挂任务、改完工日期：两个成品库存、任务已入库都对', (t) => {
  const f = setup(t, '300');
  const other = f.store.saveProduct(productSchema.parse({ name: '虚构另一款纸箱' }));
  const plan = f.preview(f.done.id, { productId: other.id, taskId: null, date: '2026-10-26' }, f.actor);
  assert.deepEqual([plan.product.before.name, plan.product.after.name], ['虚构纸箱', '虚构另一款纸箱']);
  assert.equal(count(f.store.db, 'SELECT count(*) n FROM stock_items WHERE product_id=?', other.id), 0, '预览不建成品库存');
  const result = f.correct(f.done.id, { productId: other.id, taskId: null, date: '2026-10-26' }, f.actor);
  const rep = f.flow.get(result.replacementId, 'production');
  assert.deepEqual([rep.productId, rep.taskId, rep.date, rep.productName], [other.id, null, '2026-10-26', '虚构另一款纸箱']);
  assert.notEqual(rep.finishedStockId, f.finished.id);
  assert.deepEqual([f.balance(f.finished.id), f.balance(Number(rep.finishedStockId))], [0, 300000]);
  assert.equal(f.flow.get(f.task.id, 'task').completed, '0');
});

test('同一请求号重发：到货、送货、完工三种更正交回的结果都和第一次一样', (t) => {
  /** 先出方案、按摘要提交一次，再用同一个请求号原样重发：返回两次的结果 */
  const twice = (store: Store, id: number, v: Record<string, unknown>, who: Actor) => {
    const request = { ...v, previewDigest: planCorrection(store, id, v, who).previewDigest, requestId: randomUUID() };
    return [correctDocument(store, id, request, who), correctDocument(store, id, request, who)];
  };
  const base = flowFixture(),
    a = { ...base, ...correctionFixture(base, clerk) };
  t.after(() => a.store.close());
  const [arrival, arrivalAgain] = twice(a.store, a.arrivalId, a.input(a.arrivalId, [{ index: 0, quantity: '900' }]), clerk);
  assert.deepEqual(arrivalAgain, arrival);
  const d = deliveryCorrectionSetup(t),
    shipped = d.ship([[d.order, 0, '300'], [d.order, 1, '300']]);
  const [delivery, deliveryAgain] = twice(d.store, shipped.id, d.input(shipped.id, [{ index: 0, quantity: '250' }]), clerk);
  assert.deepEqual(deliveryAgain, delivery);
  const p = setup(t);
  const v = { expectedVersion: p.flow.get(p.done.id).version, reason: '虚构：登记多了', goodQuantity: '900', materials: [{ index: 0, issued: '90' }] };
  const [production, productionAgain] = twice(p.store, p.done.id, v, superUser());
  assert.deepEqual(productionAgain, production);
});
