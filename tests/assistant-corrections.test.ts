// 助手改已生效的单据（server/assistant/tools/corrections.ts、flow-docs.ts 的 flow.edit_info）：
// 更正送货单、更正完工单出卡片（写明哪张、每行更正前后、库存和订单已发或任务已入库的净变化），没人点不改库，
// 点了原单已更正、新单更正自它；出卡片后数据变了确认被拒；没权限的账号被拒。只改说明的 flow.edit_info 不动库存。内存库、虚构数据。
import { pageActor, actor, superActor } from './actor-fixture.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, confirmCard, lastCard } from './assistant-fixture.js';
import { deliveryCorrectionSetup } from './delivery-correction-fixture.js';
import { businessFixture } from './flow-fixture.js';
import { stockItemBatches } from '../server/flow/stock-batches.js';
import { UNLISTED } from '../server/assistant/tools/card-summary.js';
import type { Store } from '../server/core/db.js';
import { AppError } from '../server/core/errors.js';
import type { Actor } from '../server/core/index.js';
import type { PlanCard } from '../shared/assistant/index.js';

const call = (name: string, args: Record<string, unknown>) => ({ message: '', toolCalls: [{ name, args }] });
const viewer = pageActor({ id: 'fictional-viewer', name: '虚构只读', permissions: [] as string[] });
/** 卡片标题加逐行内容；卡片没有逐行内容就让测试失败 */
const text = (plan: PlanCard) => {
  assert.ok(plan.summary, plan.tool + ' 的卡片没有逐行内容');
  return plan.label + '\n' + plan.summary.map((l) => l.label + '：' + l.value).join('\n');
};

/** 助手接在测试自己的库上；库由测试的底子关，这里只关助手自己的几样 */
function assistantOn(t: TestContext, store: Store) {
  const f = assistantFixture([], { store });
  t.after(() => {
    f.manager.registry.close();
    f.settings.close();
    f.prompts.close();
  });
  return f;
}

/** 成品库存 600 只，订单第一行发 600 只（送货中） */
function shippedDelivery(t: TestContext) {
  const d = deliveryCorrectionSetup(t, '600');
  const doc = d.ship([[d.order, 0, '600']]);
  return { ...d, doc, f: assistantOn(t, d.store) };
}

test('助手更正送货单：卡片写明哪张、每行更正前后、库存和订单已发净变化；没点不改，点了原单已更正、新单更正自它', async (t) => {
  const { f, flow, doc, order, balance, shipped } = shippedDelivery(t);
  const thread = f.manager.create(actor).id;
  f.replies.push(call('delivery.correct', { id: doc.id, expectedVersion: doc.version, reason: '虚构：仓库点数点错了', lines: [{ index: 0, quantity: '550' }] }));
  const v = await f.say(thread, '送货单 ' + doc.number + ' 实际只发了 550 只，仓库点数点错了');
  const card = lastCard(v);
  assert.equal(card.tool, 'delivery.correct');
  assert.equal(card.label, '更正送货单：送货单 ' + doc.number + '（虚构客户）');
  const shown = text(card);
  assert.ok(!shown.includes(UNLISTED), shown);
  for (const line of [
    '状态：送货中 → 已更正',
    '第 1 行：虚构外箱 600 只 → 550 只',
    '订单 ' + order.number + ' 已发：虚构外箱 600 只 → 550 只（订购 1000 只）',
    '送货金额：600.00 元 → 550.00 元',
    '库存：虚构外箱：0 只 → 50 只（加 50 只）',
    '原因：虚构：仓库点数点错了',
  ])
    assert.ok(shown.includes(line), line + '\n' + shown);
  assert.match(shown, /连带：新建：送货单（虚构客户）：虚构外箱 550 只/);
  // 没点确认：库存、订单已发、原单都不动
  assert.deepEqual([balance(), String(shipped(order, 0)), flow.get(doc.id).status], [0, '600', 'confirmed']);

  await confirmCard(f, v, 0, actor, 's');
  const old = flow.get(doc.id),
    replacement = flow.get(Number(old.replacedBy), 'delivery');
  assert.equal(old.status, 'reversed');
  assert.equal(replacement.correctionOf, doc.id);
  assert.equal(replacement.status, 'confirmed');
  assert.deepEqual(replacement.lines.map((l) => l.quantity), ['550']);
  assert.deepEqual([balance(), String(shipped(order, 0))], [50000, '550']);
});

test('助手更正送货单：出卡片后库存被人动过，确认被拒、什么都不改；命令和单据种类对不上直接说该用哪个', async (t) => {
  const { f, flow, doc, ops, item, balance } = shippedDelivery(t);
  const thread = f.manager.create(actor).id;
  f.replies.push(call('delivery.correct', { id: doc.id, expectedVersion: doc.version, reason: '虚构：点错', lines: [{ index: 0, quantity: '550' }] }));
  const v = await f.say(thread, '送货单改成 550 只');
  const it = ops.repo.items(true, item.id)[0];
  ops.move(item.id, { action: 'in', quantity: '10', date: '2026-11-03', notes: '虚构补入库', acknowledged: true, requestId: randomUUID(), expectedVersion: it.version }, actor);
  await assert.rejects(async () => confirmCard(f, v, 0, actor, 's'));
  assert.equal(flow.get(doc.id).status, 'confirmed');
  assert.equal(flow.get(doc.id).replacedBy ?? null, null);
  assert.equal(balance(), 10000);
  assert.throws(
    () => f.manager.tools.prepare('production.correct', { id: doc.id, expectedVersion: doc.version, reason: '虚构', goodQuantity: '1' }, superActor(), 's'),
    /这是送货单，请用更正送货单（delivery\.correct）/,
  );
});

test('没权限的账号：只读账号出不了更正和改说明的方案；更正完工单只给超级管理员账号，业务员看不到、调不了', async (t) => {
  const { f, doc } = shippedDelivery(t);
  const input = { id: doc.id, expectedVersion: doc.version, reason: '虚构', lines: [{ index: 0, quantity: '550' }] };
  assert.throws(() => f.manager.tools.prepare('delivery.correct', input, viewer, 's'), /权限/);
  assert.throws(() => f.manager.tools.prepare('flow.edit_info', { id: doc.id, notes: '虚构' }, viewer, 's'), /权限/);
  const tool = (who: Actor) => {
    const found = f.manager.registry.view(who).tools.find((x) => x.name === 'production.correct');
    assert.ok(found, '工具清单里有更正完工单');
    return found;
  };
  assert.equal(tool(actor).usable, false);
  assert.equal(tool(superActor()).permitted, true);
  const handlers = { read: () => null, business: () => null, workflow: () => null };
  const sample = { id: doc.id, expectedVersion: doc.version, reason: '虚构', goodQuantity: '1' };
  await assert.rejects(() => f.manager.registry.dispatch('production.correct', sample, actor, handlers), (e: unknown) => e instanceof AppError && e.status === 403);
});

/** 纸板 100 张、任务 1000 只、已入库的完工单 1000 只（领 100 张纸板） */
function completed(t: TestContext) {
  const b = businessFixture();
  t.after(() => b.store.close());
  b.arrival('100');
  const task = b.task('1000');
  const done = b.confirm('production', {
    taskId: task.id,
    productId: b.product.id,
    finishedStockId: b.finished.id,
    goodQuantity: '1000',
    operator: '虚构员工',
    materials: [{ stockId: b.raw.id, issued: '100', returned: '0' }],
  });
  return { b, task, done, f: assistantOn(t, b.store) };
}

test('助手更正完工单（超级管理员）：卡片写合格、领料、任务已入库前后和成品、纸板库存；点了才改', async (t) => {
  const { b, task, done, f } = completed(t),
    boss = superActor();
  const balances = () => [b.ops.repo.balance(b.finished.id), b.ops.repo.balance(b.raw.id)];
  f.replies.push(call('production.correct', { id: done.id, expectedVersion: done.version, reason: '虚构：多点了一箱', goodQuantity: '900', materials: [{ index: 0, issued: '90' }] }));
  const v = await f.say(f.manager.create(boss).id, '完工单 ' + done.number + ' 合格其实是 900 只，纸板领了 90 张', {}, boss);
  const card = lastCard(v);
  assert.equal(card.label, '更正完工单：完工单 ' + done.number);
  const shown = text(card);
  assert.ok(!shown.includes(UNLISTED), shown);
  for (const line of [
    '合格：1000 只 → 900 只',
    '报废：0 只（不变）',
    '领料第 1 行（虚构纸板）：领用 100 张 → 90 张，退料 0 张（不变）',
    '生产任务 ' + task.number + ' 已入库：1000 只 → 900 只（计划 1000 只）',
    '库存：虚构纸箱：1000 只 → 900 只（减 100 只）',
    '库存：虚构纸板：0 张 → 10 张（加 10 张）',
  ])
    assert.ok(shown.includes(line), line + '\n' + shown);
  assert.deepEqual(balances(), [1000000, 0], '没点不改');
  await confirmCard(f, v, 0, boss, 's');
  const old = b.flow.get(done.id);
  assert.equal(old.status, 'reversed');
  assert.equal(b.flow.get(Number(old.replacedBy), 'production').goodQuantity, '900');
  assert.equal(b.flow.get(Number(old.replacedBy)).correctionOf, done.id);
  assert.deepEqual(balances(), [900000, 10000]);
});

test('改送货单的说明（flow.edit_info）：卡片逐项写改前改后，点了才改，库存流水不动；送货单没有的项拒收', async (t) => {
  const { f, flow, doc, moves } = shippedDelivery(t);
  const before = moves();
  f.replies.push(call('flow.edit_info', { id: doc.id, notes: '虚构：放门卫', address: '虚构新地址 8 号' }));
  const v = await f.say(f.manager.create(actor).id, '送货单 ' + doc.number + ' 备注写放门卫，地址改成虚构新地址 8 号');
  const card = lastCard(v);
  assert.match(card.label, new RegExp('^编辑送货单的说明（不动库存和金额）：送货单 ' + doc.number));
  const shown = text(card);
  assert.match(shown, /备注：未填写 → 虚构：放门卫/);
  assert.match(shown, /地址：.* → 虚构新地址 8 号/);
  assert.equal(flow.get(doc.id).notes ?? '', '', '没点不改');
  await confirmCard(f, v, 0, actor, 's');
  assert.deepEqual([flow.get(doc.id).notes, flow.get(doc.id, 'delivery').address, flow.get(doc.id).status], ['虚构：放门卫', '虚构新地址 8 号', 'confirmed']);
  assert.deepEqual(moves(), before, '不动库存流水');
  assert.throws(() => f.manager.tools.prepare('flow.edit_info', { id: doc.id, operator: '虚构' }, actor, 's'), /送货单没有“操作人”这一项可改/);
});

test('改完工单的批次备注（flow.edit_info）：卡片写明哪张完工单、备注改前改后；没点不改，点了才改，流水和批次数量不动', async (t) => {
  const { b, done, f } = completed(t);
  const moves = () => b.store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all();
  const batch = () => {
    const found = stockItemBatches(b.store, b.finished.id).open.find((x) => x.documentId === done.id);
    assert.ok(found, '这张完工单的批次在');
    return found;
  };
  const before = { moves: moves(), batch: batch() };
  f.replies.push(call('flow.edit_info', { id: done.id, notes: '虚构：这批用的进口纸，压线有点浅' }));
  const v = await f.say(f.manager.create(actor).id, '完工单 ' + done.number + ' 这一批的批次备注写上：这批用的进口纸，压线有点浅');
  const card = lastCard(v);
  assert.equal(card.label, '编辑完工单的说明（不动库存和金额）：完工单 ' + done.number);
  assert.match(text(card), /备注：未填写 → 虚构：这批用的进口纸，压线有点浅/);
  assert.equal(b.flow.get(done.id).notes ?? '', '', '没点不改');
  await confirmCard(f, v, 0, actor, 's');
  assert.equal(b.flow.get(done.id).notes, '虚构：这批用的进口纸，压线有点浅');
  assert.equal(batch().notes, '虚构：这批用的进口纸，压线有点浅');
  assert.deepEqual(moves(), before.moves, '不动库存流水');
  assert.deepEqual({ ...batch(), notes: before.batch.notes, documentVersion: before.batch.documentVersion }, before.batch, '批次数量不动');
});
