// 单张完工单（server/flow/service.ts 的保存、核对）：成品库存按产品对应，待入库的完工数算进任务视图，
// 超计划只提示、口径和登记完工一样。整批登记见 batch-completion.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProductionCompletion } from '../server/flow/batch-completion.js';
import { today } from '../shared/core/domain.js';
import { completionFixture as fixture } from './completion-fixture.js';
import { actor } from './actor-fixture.js';

test('单张完工不用选成品库存：保存时按产品对应（没有就新建），一个产品只用一个；传了别的产品的成品库存被拒', () => {
  const f = fixture();
  try {
    const [first, second] = f.tasks;
    const other = f.ops.saveItem({ name: '虚构乙成品', kind: 'finished', unit: '只', productId: second.productId }, actor);
    const save = (task: { id: number; productId: number }, patch: Record<string, unknown> = {}) =>
      f.flow.save(
        'production',
        {
          date: today(),
          taskId: task.id,
          productId: task.productId,
          goodQuantity: '1',
          operator: '虚构机长',
          materials: [{ stockId: f.raw.id, issued: '1', returned: '0' }],
          notes: '虚构批次备注',
          ...patch,
        },
        actor,
      );
    const draft = save(first);
    const stock = f.ops.repo.items().find((s) => s.kind === 'finished' && s.productId === first.productId);
    assert.ok(stock);
    assert.deepEqual([stock.name, draft.finishedStockId, draft.notes], ['虚构纸箱甲', stock.id, '虚构批次备注']);
    // 核对入库的预览：成品库存在保存时已经按产品建好，预览里就是它，写清现在多少、核对后多少（不说“新建”）
    const check = f.flow.preview(draft.id, actor);
    assert.deepEqual(
      check.changes.map((c) => [c.stockId, c.reason, c.currentUnits, c.afterUnits, c.target ?? null]),
      [
        [f.raw.id, '生产领料', 100_000, 99_000, null],
        [stock.id, '生产完工入库', 0, 1000, null],
      ],
    );
    assert.equal(save(first, { finishedStockId: stock.id }).finishedStockId, stock.id, '传了就是这个产品的那一个，照常');
    assert.equal(save(first).finishedStockId, stock.id, '第二张用同一个，不另建');
    assert.throws(() => save(first, { finishedStockId: other.id }), /入库的成品库存不是产品“虚构纸箱甲”的成品库存/);
    assert.equal(f.ops.repo.items(true).filter((s) => s.kind === 'finished').length, 2);
  } finally {
    f.store.close();
  }
});

test('生产任务视图带上待入库的完工数（pendingCompleted），和登记完工的剩余量同一口径；核对入库、取消以后不算', () => {
  const f = fixture();
  try {
    const id = f.tasks[0].id;
    const one = (good: string) => ({ ...f.input(), taskIds: [id], quantities: [{ taskId: id, goodQuantity: good, scrapQuantity: '0' }], pending: true });
    // 计划 3 只，先登记 1 只待入库：按主键读、列表、按编号列表都带上
    new ProductionCompletion(f.store).execute(one('1'), actor);
    assert.deepEqual([f.flow.get(id, 'task').completed, f.flow.get(id, 'task').pendingCompleted], ['0', '1']);
    assert.equal(f.flow.list('task').find((t) => t.id === id)?.pendingCompleted, '1');
    assert.equal(f.flow.list('task', false, undefined, [id])[0].pendingCompleted, '1');
    assert.equal(f.flow.get(f.tasks[1].id, 'task').pendingCompleted, '0');
    // 核对入库以后：算进已完工，不再算待入库
    const doc = f.flow.list('production').find((p) => p.taskId === id);
    assert.ok(doc);
    const check = f.flow.preview(doc.id, actor);
    f.flow.confirm(doc.id, { previewDigest: check.previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
    assert.deepEqual([f.flow.get(id, 'task').completed, f.flow.get(id, 'task').pendingCompleted], ['1', '0']);
    // 再登记 2 只待入库，然后取消这张完工单：取消的不算在等核对入库
    new ProductionCompletion(f.store).execute(one('2'), actor);
    assert.equal(f.flow.get(id, 'task').pendingCompleted, '2');
    const waiting = f.flow.list('production').find((p) => p.taskId === id && p.status === 'draft');
    assert.ok(waiting);
    f.flow.cancel(waiting.id, { version: waiting.version, reason: '虚构登记错了', acknowledged: true }, actor);
    assert.equal(f.flow.get(id, 'task').pendingCompleted, '0');
  } finally {
    f.store.close();
  }
});

test('单张完工和登记完工同一口径：改待入库完工单也拦未来日期；超计划只提示，“已完工”算上别的待入库完工单、不算这张自己', () => {
  const f = fixture();
  try {
    const id = f.tasks[0].id; // 计划 3 只，安排即下达
    const single = (good: string, extra: object = {}) => ({
      taskId: id,
      productId: f.tasks[0].productId,
      finishedStockId: null,
      date: today(),
      goodQuantity: good,
      scrapQuantity: '0',
      operator: '虚构生产人员',
      materials: [{ stockId: f.raw.id, issued: '1', returned: '0' }],
      ...extra,
    });
    // 单张存 2 只待入库：没超计划，不提示
    const a = f.flow.save('production', single('2'), actor);
    assert.equal(a.status, 'draft');
    assert.deepEqual(f.flow.preview(a.id, actor).warnings, []);
    const tomorrow = today(new Date(Date.now() + 86400000));
    assert.throws(() => f.flow.save('production', { ...single('2', { date: tomorrow }), version: a.version }, actor, a.id), /完工日期不能晚于今天/);
    // 再单张存 2 只：已核对入库 0 + 别的待入库 2 + 本次 2 > 计划 3，保存照常（只提示不拦），核对入库时提示算上待入库的
    const b = f.flow.save('production', single('2'), actor);
    assert.equal(b.status, 'draft');
    const warned = f.flow.preview(b.id, actor).warnings;
    assert.equal(warned.length, 1);
    assert.match(warned[0], /超过生产计划数量（生产任务 .+ 计划 3 只，已核对入库 0 只，另有 2 只已登记、待核对入库）/);
    // 第一张自己核对入库：不把它自己再算一遍待入库（提示里“另有 2 只”是 b）
    const aCheck = f.flow.preview(a.id, actor);
    assert.match(aCheck.warnings[0], /已核对入库 0 只，另有 2 只已登记、待核对入库/);
    f.flow.confirm(a.id, { previewDigest: aCheck.previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
    // a 入库后：已核对入库 2 + b 自己 2 > 3，提示里没有别的待入库
    assert.match(f.flow.preview(b.id, actor).warnings[0], /已核对入库 2 只）/);
    // 取消 b 以后，存 1 只正好做完，不提示
    f.flow.cancel(b.id, { version: f.flow.get(b.id).version, reason: '虚构登记错了', acknowledged: true }, actor);
    const c = f.flow.save('production', single('1'), actor);
    assert.deepEqual(f.flow.preview(c.id, actor).warnings, []);
  } finally {
    f.store.close();
  }
});
