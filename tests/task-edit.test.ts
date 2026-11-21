// 生产任务的修改（server/flow/service.ts）：已下达还没开工的能改，开工后不能；单位只有“只”；助手和人工同一条规则；
// 计划数不能少于已登记的完工数（已入库加待核对入库，取消、撤销的不算）。内存库、虚构数据。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../server/core/auth.js';
import { AppError } from '../server/core/errors.js';
import { count } from '../server/core/index.js';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { productSchema } from '../shared/core/domain.js';
import { localAdmin } from './flow-fixture.js';
import { actor } from './actor-fixture.js';

/** 一张已下达的生产任务（普通编辑账号，不是本机管理员），成品和原材料档案各一个；测试结束关库。 */
function setup(t: TestContext) {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  t.after(() => store.close());
  const product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
  const finished = ops.saveItem({ name: '虚构纸箱', kind: 'finished', unit: '只', productId: product.id }, actor);
  const raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor);
  ops.move(raw.id, { action: 'in', quantity: '100', date: '2026-11-09', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: raw.version }, actor);
  const input = { date: '2026-11-09', plannedDate: '2026-11-10', productId: product.id, quantity: '100', unit: '只', orderIds: [], notes: '' };
  // 安排生产就是下达：保存出来就是已下达
  const task = flow.save('task', input, actor);
  const edit = (patch: object, who: Actor = actor) => flow.save('task', { ...input, ...patch, version: flow.get(task.id).version }, who, task.id);
  /** 登记一张待入库的完工单（每张领 10 张纸板） */
  const complete = (goodQuantity = '10') =>
    flow.save(
      'production',
      { date: '2026-11-10', taskId: task.id, productId: product.id, finishedStockId: finished.id, goodQuantity, scrapQuantity: '0', operator: '虚构机长', materials: [{ stockId: raw.id, issued: '10', returned: '0' }], notes: '' },
      actor,
    );
  /** 待入库的完工单核对入库 */
  const stockIn = (id: number) => flow.confirm(id, { previewDigest: flow.preview(id, actor).previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
  return { store, flow, product, task, input, edit, complete, stockIn };
}
/** 计划数改得比已登记的完工数少：按业务校验不通过拒绝（422），说清已入库、待核对入库各多少 */
const belowRegistered = (done: string, waiting: string) => (e: unknown) =>
  e instanceof AppError && e.status === 422 && e.message === '计划数不能少于已登记的完工数（已入库 ' + done + ' 只，待核对入库 ' + waiting + ' 只）。';

test('已下达但还没开工的生产任务可以改数量、日期和备注，改完仍是已下达，下达记录保留', (t) => {
  const f = setup(t);
  const after = f.edit({ plannedDate: '2026-11-12', quantity: '150', notes: '客户要加量' });
  assert.deepEqual([after.status, after.quantity, after.plannedDate, after.notes], ['confirmed', '150', '2026-11-12', '客户要加量']);
  assert.equal(after.confirmedBy, f.task.confirmedBy, '下达人保留');
  assert.equal(count(f.store.db, "SELECT COUNT(*) FROM business_audit WHERE action='update-confirmed-task'"), 1);
});

test('有了完工单（哪怕还待入库）就不能再改，提示取消剩余或再安排一张；详情和列表都标出有完工单', (t) => {
  const f = setup(t);
  assert.equal(f.flow.get(f.task.id, 'task').hasProduction, false);
  f.complete();
  assert.throws(() => f.edit({ quantity: '150' }), /已经有完工单/);
  assert.equal(f.flow.get(f.task.id, 'task').hasProduction, true, '有一张待入库的完工单');
  assert.equal(f.flow.list('task').find((x) => x.id === f.task.id)?.hasProduction, true);
  assert.equal(f.flow.get(f.task.id, 'task').completed, '0', '还没入库，完工数仍是 0，所以不能只看完工数');
});

test('开工以后只有本机管理员能改（和改没开工的同一个保存）：产品名、下达记录不丢；不能换产品，做完了不能改计划日', (t) => {
  const f = setup(t);
  const admin = localAdmin();
  const pending = f.complete();
  assert.throws(() => f.edit({ quantity: '120' }), /已经有完工单/);
  const after = f.edit({ quantity: '120', notes: '虚构：客户加量' }, admin);
  assert.deepEqual([after.status, after.quantity, after.productName, after.confirmedBy, after.confirmedAt], ['confirmed', '120', f.task.productName, f.task.confirmedBy, f.task.confirmedAt]);
  const other = f.store.saveProduct(productSchema.parse({ name: '虚构另一款纸箱' }));
  assert.throws(() => f.edit({ productId: other.id }, admin), /已经有完工单，不能换产品/);
  // 做完了（已入库 ≥ 计划）不能改计划日
  f.edit({ quantity: '10' }, admin);
  f.stockIn(pending.id);
  assert.throws(() => f.edit({ plannedDate: '2026-11-20' }, admin), /已完工，计划生产日期不能再改/);
});

test('计划数少于已入库的完工数：本机管理员改也被拒（422），说清已入库多少；任务不变', (t) => {
  const f = setup(t);
  f.stockIn(f.complete('30').id);
  assert.throws(() => f.edit({ quantity: '29' }, localAdmin()), belowRegistered('30', '0'));
  assert.equal(f.flow.get(f.task.id, 'task').quantity, '100', '被拒的没有存');
});

test('计划数少于待核对入库的完工数：已登记还没入库的也算，被拒（422）', (t) => {
  const f = setup(t);
  f.complete('30');
  assert.throws(() => f.edit({ quantity: '29' }, localAdmin()), belowRegistered('0', '30'));
  assert.equal(f.flow.get(f.task.id, 'task').quantity, '100');
});

test('已入库和待核对入库都有：按两样的合计算，少一只被拒，正好相等能存', (t) => {
  const f = setup(t),
    admin = localAdmin();
  f.stockIn(f.complete('30').id);
  f.complete('20');
  assert.throws(() => f.edit({ quantity: '49' }, admin), belowRegistered('30', '20'));
  assert.equal(f.edit({ quantity: '50' }, admin).quantity, '50');
});

test('已取消、已撤销的完工单不算进已登记的完工数：计划数可以改到它们以下', (t) => {
  const f = setup(t),
    admin = localAdmin();
  const cancelled = f.complete('30');
  f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：登记错了', acknowledged: true }, actor);
  const reversed = f.stockIn(f.complete('20').id);
  f.flow.reverse(reversed.id, { version: reversed.version, reason: '虚构：入库错了', acknowledged: true }, admin);
  f.complete('10');
  assert.equal(f.edit({ quantity: '10' }, admin).quantity, '10');
  assert.throws(() => f.edit({ quantity: '9' }, admin), belowRegistered('0', '10'));
});

/** 超产的任务：还没开工时计划改成 10 只，再登记 15 只完工（完工超计划只提示不拦）；stocked 时核对入库（进度到 100%） */
function overproduced(t: TestContext, stocked: boolean) {
  const f = setup(t);
  f.edit({ quantity: '10' });
  const done = f.complete('15');
  if (stocked) f.stockIn(done.id);
  return f;
}

test('超产的任务计划数没动：只改备注能存（已入库超产、待入库超产都一样）', (t) => {
  for (const stocked of [true, false]) {
    const f = overproduced(t, stocked);
    assert.equal(f.edit({ quantity: '10', notes: '虚构：只改备注' }, localAdmin()).notes, '虚构：只改备注', stocked ? '已入库超产' : '待入库超产');
  }
});

test('待入库超产、还没做完的任务计划数没动：只改计划日能存', (t) => {
  const f = overproduced(t, false);
  assert.equal(f.edit({ quantity: '10', plannedDate: '2026-11-12' }, localAdmin()).plannedDate, '2026-11-12');
});

test('超产的任务把计划数改大能存：改大以后仍少于已登记的完工数也不拦', (t) => {
  const f = overproduced(t, true);
  assert.equal(f.edit({ quantity: '12' }, localAdmin()).quantity, '12');
});

test('已完工的任务改计划日仍回 409“已完工”：超产的也是这句，不报计划数那句', (t) => {
  const f = overproduced(t, true);
  assert.throws(
    () => f.edit({ quantity: '10', plannedDate: '2026-11-20' }, localAdmin()),
    (e: unknown) => e instanceof AppError && e.status === 409 && e.message === '这张生产任务已完工，计划生产日期不能再改。',
  );
});

test('助手也能改已下达但还没开工的生产任务（和人工同一条规则）', (t) => {
  const f = setup(t);
  const tools = new AssistantTools(f.store);
  const plan = tools.prepare('records.propose_save', { module: 'production_tasks', id: f.task.id, patch: { quantity: '120', notes: '助手改的' } }, actor, 'task-edit');
  assert.ok(tools.commit(plan, actor, 'task-edit'));
  const after = f.flow.get(f.task.id, 'task');
  assert.deepEqual([after.status, after.quantity, after.notes], ['confirmed', '120', '助手改的']);
});

test('生产任务只按“只”记：新建、改成“箱”都拒收（本机管理员直接改也一样），“个”和没写都存成“只”；直接改库也被数据库拦下', (t) => {
  const f = setup(t);
  const message = /产品和成品的数量单位只有“只”（“个”也按“只”）；别的单位请先换算成只再填。/;
  assert.throws(() => f.flow.save('task', { ...f.input, unit: '箱' }, actor), message);
  assert.throws(() => f.edit({ unit: '箱' }), message);
  const admin = localAdmin();
  assert.throws(() => f.edit({ unit: '箱' }, admin), message);
  f.edit({ unit: '个' }, admin);
  assert.equal(f.flow.get(f.task.id, 'task').unit, '只');
  assert.equal(f.flow.save('task', { ...f.input, unit: undefined }, actor).unit, '只');
  assert.throws(
    () => f.store.db.prepare("UPDATE flow_documents SET document=json_set(document,'$.unit','箱') WHERE id=?").run(f.task.id),
    /CHECK constraint failed/,
  );
});
