// 生产任务和完工单（server/flow/）：进度、领料、预览失效、撤销完工、取消剩余、选错任务的提示。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../server/core/auth.js';
import { count } from '../server/core/index.js';
import { productSchema } from '../shared/core/domain.js';
import { flowStatusLabel, matchesFlowStatus } from '../shared/business/physical-flow.js';
import { flowFixture, clerk, localAdmin } from './flow-fixture.js';

/** flowFixture 加：纸板期初 1000 张；production(良品数, 别的字段) 存一张待核对的完工单（领 80 退 10，报废 5） */
function fixture() {
  const f = flowFixture();
  f.stockIn('1000', f.raw.id);
  const production = (goodQuantity: string, extra: Record<string, unknown> = {}) =>
    f.draft('production', {
      productId: f.product.id,
      finishedStockId: f.finished.id,
      goodQuantity,
      scrapQuantity: '5',
      operator: '虚构机长',
      materials: [{ stockId: f.raw.id, issued: '80', returned: '10' }],
      ...extra,
    });
  const task = (quantity: string, orderIds: number[] = []) =>
    f.task({ productId: f.product.id, quantity, unit: '只', orderIds });
  const snapshot = () =>
    Object.fromEntries(
      ['stock_items', 'stock_movements', 'flow_documents', 'flow_refs', 'operation_requests', 'business_audit', 'orders', 'order_lines'].map((t) => [
        t,
        f.store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all(),
      ]),
    );
  return { ...f, production, task, snapshot };
}

test('生产进度到实际计划量才算完工：99.9% 还是生产中，状态筛选和叫法一致', () => {
  const f = fixture();
  try {
    const task = f.task('1000');
    assert.equal(flowStatusLabel(task), '待生产');
    assert(matchesFlowStatus(task, 'task', '待生产'));
    f.confirmId(f.production('999', { taskId: task.id }).id);
    const partial = f.flow.get(task.id, 'task');
    assert.deepEqual([partial.completed, partial.progress, flowStatusLabel(partial)], ['999', 99, '生产中']);
    assert(!matchesFlowStatus(partial, 'task', '已完工'));
    f.confirmId(f.production('1', { taskId: task.id, materials: [{ stockId: f.raw.id, issued: '1', returned: '0' }] }).id);
    const full = f.flow.get(task.id, 'task');
    assert.deepEqual([full.progress, flowStatusLabel(full)], [100, '已完工']);
    assert(matchesFlowStatus(full, 'task', '已完工'));
    assert.equal(flowStatusLabel({ kind: 'arrival', status: 'confirmed' }), '已确认收货');
    assert.equal(flowStatusLabel({ kind: 'delivery', status: 'confirmed' }), '送货中');
    assert.equal(flowStatusLabel({ kind: 'production', status: 'reversed' }), '已冲销');
  } finally {
    f.store.close();
  }
});

test('完工核对：预览以后库存变了确认被拒；领料超过库存拦下，成品不入库；完工日期不能晚于今天', () => {
  const f = fixture();
  try {
    const stale = f.production('60'),
      preview = f.flow.preview(stale.id, clerk);
    f.confirmId(f.production('20', { materials: [{ stockId: f.raw.id, issued: '10', returned: '0' }] }).id);
    assert.throws(() => f.flow.confirm(stale.id, { previewDigest: preview.previewDigest, requestId: randomUUID(), acknowledged: true }, clerk), /已变化/);
    assert.throws(() => f.confirmId(f.production('5', { materials: [{ stockId: f.raw.id, issued: '2000', returned: '0' }] }).id), /库存不足/);
    assert.equal(f.ops.repo.balance(f.finished.id), 20000);
    assert.throws(() => f.confirm('production', { ...f.flow.get(stale.id), date: '2099-01-01', id: undefined, version: undefined }), /完工日期不能晚于今天/);
  } finally {
    f.store.close();
  }
});

test('完工单确认用同一个请求号重发：交回的单据和第一次一样，不再记流水', () => {
  const f = fixture();
  try {
    const doc = f.production('60'),
      request = { previewDigest: f.flow.preview(doc.id, clerk).previewDigest, requestId: randomUUID(), acknowledged: true };
    const first = f.flow.confirm(doc.id, request, clerk),
      moves = f.store.db.prepare('SELECT count(*) n FROM stock_movements').get();
    assert.equal(first.status, 'confirmed');
    assert.deepEqual(f.flow.confirm(doc.id, request, clerk), first);
    assert.deepEqual(f.store.db.prepare('SELECT count(*) n FROM stock_movements').get(), moves);
  } finally {
    f.store.close();
  }
});

test('撤销完工要超级管理员模式；成品已经送出去、不够扣时拦下，先撤销送货再撤销完工，原料和成品都回到原样', () => {
  const f = fixture();
  try {
    const order = f.order(100);
    const prod = f.confirmId(f.production('60').id);
    const reverse = (id: number, who: Actor) => f.flow.reverse(id, { version: f.flow.get(id).version, reason: '核错', acknowledged: true }, who);
    assert.throws(() => reverse(prod.id, clerk), /超级管理员/);
    const d = f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '40' }] });
    assert.throws(() => reverse(prod.id, localAdmin()), /撤销要扣回.*不够扣。这批库存已经被后面的业务用掉了/);
    reverse(d.id, localAdmin());
    const shipped = f.store.order(order.id);
    assert.ok(shipped);
    assert.equal(shipped.lines[0].shippedQuantity, 0);
    reverse(prod.id, localAdmin());
    assert.deepEqual([f.ops.repo.balance(f.raw.id), f.ops.repo.balance(f.finished.id)], [1000000, 0]);
  } finally {
    f.store.close();
  }
});

test('撤销完工拒绝旧版本；第二笔流水写失败时整单回滚；重试只撤销一次', () => {
  const f = fixture();
  try {
    const task = f.task('30');
    const doc = f.confirmId(f.production('10', { taskId: task.id, scrapQuantity: '0', materials: [{ stockId: f.raw.id, issued: '15', returned: '2' }] }).id);
    const input = { version: doc.version, acknowledged: true, reason: '虚构反向登记' };
    const before = f.snapshot();
    assert.throws(() => f.flow.reverse(doc.id, { ...input, version: doc.version - 1 }, localAdmin()), /单据已变更/);
    f.store.db.exec(`CREATE TRIGGER fail_second_reversal BEFORE INSERT ON stock_movements
      WHEN NEW.source_kind='flow_reversal' AND EXISTS (
        SELECT 1 FROM stock_movements WHERE source_kind='flow_reversal' AND source_id=NEW.source_id
      ) BEGIN SELECT RAISE(ABORT, 'fictional second reversal failed'); END;`);
    assert.throws(() => f.flow.reverse(doc.id, input, localAdmin()), /fictional second reversal failed/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.flow.get(task.id, 'task').completed, '10');
    f.store.db.exec('DROP TRIGGER fail_second_reversal');
    const reversed = f.flow.reverse(doc.id, input, localAdmin());
    assert.equal(reversed.status, 'reversed');
    assert.equal(f.flow.get(task.id, 'task').completed, '0');
    assert.deepEqual([f.ops.repo.balance(f.raw.id), f.ops.repo.balance(f.finished.id)], [1000000, 0]);
    assert.equal(reversed.reversal?.movements.length, 2);
    const after = f.snapshot();
    assert.deepEqual(f.flow.reverse(doc.id, input, localAdmin()), reversed);
    assert.deepEqual(f.snapshot(), after);
  } finally {
    f.store.close();
  }
});

test('取消剩余任务：还有待入库的完工单时不能取消，先入库就行；取消后已完工的数和成品库存保留，不能再登记完工', () => {
  const f = fixture();
  try {
    const order = f.order(150);
    const t = f.task('150', [order.id]);
    f.confirmId(f.production('100', { taskId: t.id }).id);
    const pending = f.production('40', { taskId: t.id, materials: [{ stockId: f.raw.id, issued: '10', returned: '0' }] });
    const cancel = () => f.flow.cancel(t.id, { version: f.flow.get(t.id).version, reason: '客户减量', acknowledged: true }, clerk);
    assert.throws(cancel, /待入库的完工单/);
    f.confirmId(pending.id);
    assert.equal(cancel().status, 'cancelled');
    assert.deepEqual([f.flow.get(t.id, 'task').completed, f.ops.repo.balance(f.finished.id)], ['140', 140000]);
    assert.throws(() => f.confirmId(f.production('1', { taskId: t.id }).id), /任务/);
  } finally {
    f.store.close();
  }
});

test('同一种纸板做两种产品：各入各的成品库存，一张送货单送两种成品不合并', () => {
  const f = fixture();
  try {
    const order = f.order(100);
    f.confirmId(f.production('100').id);
    const product2 = f.store.saveProduct(productSchema.parse({ name: '虚构第二款纸箱' })),
      stock2 = f.ops.saveItem({ name: '虚构第二款成品', kind: 'finished', unit: '只', productId: product2.id }, clerk),
      order2 = f.order(10, { lines: [{ productId: product2.id, quantity: 10, unit: '只', unitPriceCents: 1000 }] });
    f.confirmId(f.production('10', { productId: product2.id, finishedStockId: stock2.id, materials: [{ stockId: f.raw.id, issued: '30', returned: '0' }] }).id);
    f.confirm('delivery', {
      customerId: f.customer.id,
      lines: [
        { orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '20' },
        { orderId: order2.id, orderLineId: order2.lines[0].id, stockId: stock2.id, quantity: '10' },
      ],
    });
    assert.deepEqual([f.ops.repo.balance(f.finished.id), f.ops.repo.balance(stock2.id)], [80000, 0]);
    assert.equal(f.store.order(order2.id)?.status, '已发货');
    assert.equal(f.store.order(order.id)?.lines[0].remainingQuantity, 80);
  } finally {
    f.store.close();
  }
});

test('完工登记选的生产任务对不上时，说清是哪里不对、下一步怎么办', () => {
  const f = fixture();
  try {
    const production = (taskId: number) => f.production('10', { taskId, materials: [{ stockId: f.raw.id, issued: '10', returned: '0' }] });
    const cancelled = f.draft('task', { productId: f.product.id, quantity: '100', unit: '只', orderIds: [] });
    f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：不做了', acknowledged: true }, clerk);
    assert.throws(() => production(cancelled.id), new RegExp('所选生产任务 ' + cancelled.number + '已取消，不能登记完工，请重新选择生产任务。'));
    const other = f.store.saveProduct(productSchema.parse({ name: '虚构另一种纸箱' }));
    const otherTask = f.draft('task', { productId: other.id, quantity: '100', unit: '只', orderIds: [] });
    assert.throws(
      () => production(otherTask.id),
      new RegExp('所选生产任务 ' + otherTask.number + ' 做的是别的产品，和本次完工的产品不同，请重新选择生产任务。'),
    );
    const arrival = f.arrive('虚构送货单-任务校验', '10');
    assert.throws(() => production(arrival.id), /所选的不是生产任务，请重新选择生产任务。/);
    const task = f.task('100');
    assert.equal(production(task.id).taskId, task.id);
    assert.equal(count(f.store.db, "SELECT count(*) AS n FROM flow_documents WHERE kind='production'"), 1);
  } finally {
    f.store.close();
  }
});
