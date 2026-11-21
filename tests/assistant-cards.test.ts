// 助手的确认卡片（界限 2“改数据必须人点确认”的展开）：一句话出几张卡片、一次动多条、流程类写入的卡片写明动的是什么、
// 点了“不执行”就作废、确认或拒绝之后把结果交回模型接着办。六条界限各一组在 assistant-boundaries.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assistantFixture, confirmCard, lastCard } from './assistant-fixture.js';
import { messageText } from './fake-deepseek.js';
import type { ChatCall } from './fake-deepseek-wire.js';
import { AppError } from '../server/core/errors.js';
import { count } from '../server/core/index.js';
import { MarkService } from '../server/business/product-marks.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { updateDocumentInfo } from '../server/flow/index.js';
import { flowFixture, clerk } from './flow-fixture.js';
import { correctionFixture } from './receive-fixture.js';
import { createOrderWorkflowFixture, importer } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { actor, superActor } from './actor-fixture.js';
import { readAs } from './read-result.js';

const call = (name: string, args: Record<string, unknown> = {}, message = '') => ({ message, toolCalls: [{ name, args }] });
/** 发给模型的第 at 次请求（负数从后数）里，最后一条以 prefix 开头的“用户”消息：服务器写的卡片结果 */
function serverNote(requests: ChatCall[], at: number, prefix: string) {
  const request = requests.at(at);
  assert.ok(request, '没有第 ' + at + ' 次请求');
  return request.body.messages.findLast((m) => m.role === 'user' && messageText(m).startsWith(prefix));
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==', 'base64');

test('一次动多条、一句话出几张卡片：每张都要点；拒绝的作废，再点确认也不执行', async () => {
  const f = assistantFixture();
  try {
    const a = f.store.saveCustomer(customerSchema.parse({ name: '虚构批量甲' })),
      b = f.store.saveCustomer(customerSchema.parse({ name: '虚构批量乙' }));
    f.replies.push(
      {
        message: '',
        toolCalls: [
          { name: 'records.propose_batch_lifecycle', args: { module: 'customers', action: 'archive', ids: [a.id, b.id] } },
          { name: 'records.propose_save', args: { module: 'customers', patch: { name: '虚构批量丙' } } },
        ],
      },
      { message: '出了两张卡片：归档两位客户、新建一位客户。' },
    );
    const t = f.manager.create(actor);
    const v = await f.say(t.id, '把甲和乙归档，再新建丙');
    const plans = v.messages.at(-1)?.plans ?? [];
    assert.equal(plans.length, 2, JSON.stringify(v.messages.at(-1)?.facts?.failed));
    assert.equal(f.store.archived('customers', a.id), false);
    assert.equal(f.store.customers().length, 2);
    // 第一张（一次动两条）点确认：两条一起归档
    await confirmCard(f, v, 0, actor, 's');
    assert.equal(f.store.archived('customers', a.id), true);
    assert.equal(f.store.archived('customers', b.id), true);
    // 第二张点“不执行”：作废，之后再点确认也没用
    assert.deepEqual(f.manager.reject(plans[1].id, actor, 's'), { rejected: true });
    assert.throws(() => f.manager.execute(plans[1].id, { acknowledged: true }, actor, 's'), /作废/);
    assert.equal(f.store.customers(true).some((c) => c.name === '虚构批量丙'), false);
    assert.deepEqual(f.manager.view(t.id, actor).messages.at(-1)?.plans?.map((p) => p.state), ['executed', 'cancelled']);
    assert.throws(() => f.manager.reject(plans[0].id, actor, 's'), /已经执行过/);
  } finally {
    f.close();
  }
});
test('流程类写入也只出卡片：挂唛头、移除唛头、放进收件箱、删聊天记录、改提示词；卡片上逐行写明动的是什么', async () => {
  const f = assistantFixture();
  try {
    f.manager.connectExtras({ marks: new MarkService(f.store) });
    const boss = superActor();
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构界限纸箱' }));
    const t = f.manager.create(boss);
    const file = await f.manager.attachments.upload(t.id, png, '虚构唛头.png', randomUUID(), boss);
    const other = f.manager.create(boss);
    f.store.db.prepare('UPDATE assistant_threads SET title=? WHERE id=?').run('虚构旧会话', other.id);
    const preset = f.prompts.view().presets[0],
      entry = preset.entries[0];
    f.replies.push(
      {
        message: '',
        toolCalls: [
          { name: 'marks.add', args: { productId: product.id } },
          { name: 'inbox.add', args: { text: '虚构客户来电：周五要货' } },
          { name: 'chat.delete', args: { threadIds: [other.id] } },
          { name: 'prompts.propose', args: { module: 'assistant', presetId: preset.id, entryId: entry.id, expectedRevision: f.prompts.view().revision, content: entry.content + '\n回答先说结论。' } },
        ],
      },
      { message: '四张卡片都出好了。' },
    );
    const v = await f.manager.chat(t.id, { ...f.input('把唛头挂到虚构界限纸箱，记一条来电，删掉旧会话，提示词加一句', randomUUID()), attachmentIds: [file.id] }, boss, 's', () => {}, () => boss);
    const plans = v.messages.at(-1)?.plans;
    assert.ok(plans);
    assert.deepEqual(plans.map((p) => p.tool), ['marks.add', 'inbox.add', 'chat.delete', 'prompts.propose']);
    // 一样都还没做
    const marks = new MarkService(f.store);
    assert.equal(marks.list(product.id).length, 0);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM inbox_items'), 0);
    assert.ok(f.manager.view(other.id, boss));
    assert.equal(f.prompts.view().presets[0].entries[0].content, entry.content);
    // 卡片上逐行写明：哪个产品、哪份文件、哪个会话、提示词改之前和改之后
    const lines = (i: number) => Object.fromEntries(plans[i].summary?.map((l) => [l.label, l.value]) ?? []);
    assert.deepEqual(lines(0), { 产品: '虚构界限纸箱', 文件: '虚构唛头.png' });
    assert.deepEqual(lines(1), { 文字: '虚构客户来电：周五要货' });
    assert.deepEqual(lines(2), { '会话 1': '虚构旧会话' });
    assert.equal(lines(3)['改之前'], entry.content);
    assert.equal(lines(3)['改之后'], entry.content + '\n回答先说结论。');
    // 逐张点确认：做的就是卡片上写的
    for (let i = 0; i < 4; i++) await f.manager.execute(plans[i].id, { acknowledged: true }, boss, 's');
    assert.equal(marks.list(product.id)[0].fileName, '虚构唛头.png');
    assert.equal(String(f.store.db.prepare('SELECT text FROM inbox_items').get()?.text), '虚构客户来电：周五要货');
    assert.throws(() => f.manager.view(other.id, boss), /不存在/);
    assert.equal(f.prompts.view().presets[0].entries[0].content, entry.content + '\n回答先说结论。');
    // 移除唛头同样先出卡片
    const mark = marks.list(product.id)[0];
    f.replies.push(call('marks.remove', { id: mark.id, expectedVersion: mark.version }), { message: '出了移除的卡片。' });
    const v2 = await f.say(t.id, '把这份唛头拿掉', {}, boss);
    assert.equal(marks.list(product.id).length, 1);
    assert.match(lastCard(v2).label, /^移除唛头：虚构唛头\.png/);
    await confirmCard(f, v2, 0, boss, 's');
    assert.equal(marks.list(product.id).length, 0);
    // 改提示词只给超级管理员：普通管理员的清单里没有，卡片也点不了
    assert.throws(() => f.manager.promptEdit.propose({ module: 'assistant', presetId: preset.id, entryId: entry.id, expectedRevision: f.prompts.view().revision, content: '虚构' }, actor), /超级管理员/);
  } finally {
    f.close();
  }
});
test('卡片确认或拒绝之后接着办：结果交回模型（不显示成用户说的话），这一轮的事实里记“已执行”；同一张卡片只交一次', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    f.replies.push(call('records.propose_save', { module: 'customers', patch: { name: '虚构接着办客户' } }), { message: '出了新建客户的卡片，确认后我接着建订单。' });
    const v = await f.say(t.id, '新建客户虚构接着办客户，然后查一下他有没有订单');
    const plan = lastCard(v);
    // 还没点确认就发“接着办”：拒绝
    await assert.rejects(() => f.say(t.id, '', { card: { id: plan.id, decision: 'confirmed' } }), /还没有执行/);
    const saved = readAs(await confirmCard(f, v, 0, actor, 's'), { id: z.number() });
    f.replies.push(call('records.search', { module: 'orders', filters: { customerId: saved.id } }), { message: '客户建好了，他还没有订单。' });
    const next = await f.say(t.id, '', { card: { id: plan.id, decision: 'confirmed' } });
    // 模型收到的是服务器写的卡片结果，带实际执行结果
    const note = serverNote(f.requests, -2, '服务器：用户在确认卡片上点了确认');
    assert.ok(note, '卡片结果交给了模型');
    assert.match(messageText(note), /虚构接着办客户/);
    const reply = next.messages.at(-1);
    assert.ok(reply, '有回复');
    assert.equal(reply.text, '客户建好了，他还没有订单。');
    assert.deepEqual(reply.facts?.executed, [{ label: plan.label }]);
    assert.equal(reply.facts?.reads, 1);
    // 那条“接着办”不显示成用户消息
    assert.deepEqual(next.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
    await assert.rejects(() => f.say(t.id, '', { card: { id: plan.id, decision: 'confirmed' } }), /已经交给助手/);
    // 拒绝：模型被告知没有执行
    f.replies.push(call('records.propose_save', { module: 'customers', patch: { name: '虚构被拒客户' } }), { message: '出了卡片。' });
    const v2 = await f.say(t.id, '再建一个虚构被拒客户');
    const rejected = lastCard(v2);
    await assert.rejects(() => f.say(t.id, '', { card: { id: rejected.id, decision: 'rejected' } }), /还没有/);
    f.manager.reject(rejected.id, actor, 's');
    f.replies.push({ message: '好的，这位先不建。要改什么告诉我。' });
    const after = await f.say(t.id, '', { card: { id: rejected.id, decision: 'rejected' } });
    assert.match(messageText(serverNote(f.requests, -1, '服务器：用户在确认卡片上')), /点了拒绝，没有执行/);
    assert.deepEqual(after.messages.at(-1)?.facts?.executed, []);
    assert.equal(f.store.customers().some((c) => c.name === '虚构被拒客户'), false);
  } finally {
    f.close();
  }
});

test('一句话给两种产品安排生产：一条命令（items）一张卡片，确认后建出两张任务', async () => {
  const f = assistantFixture();
  try {
    const p1 = f.store.saveProduct(productSchema.parse({ name: '虚构排产甲' })),
      p2 = f.store.saveProduct(productSchema.parse({ name: '虚构排产乙' }));
    const task = (productId: number, quantity: string) => ({ date: '2026-11-14', productId, quantity, unit: '只', orderIds: [] });
    const t = f.manager.create(superActor());
    f.replies.push(call('records.propose_save', { module: 'production_tasks', items: [task(p1.id, '100'), task(p2.id, '200')] }), { message: '出了一张卡片。' });
    const v = await f.say(t.id, '甲排 100 只、乙排 200 只', {}, superActor());
    const plans = v.messages.at(-1)?.plans ?? [];
    assert.equal(plans.length, 1, '两种产品一张卡片');
    const lines = (plans[0].summary ?? []).map((l) => l.label + '：' + l.value).join('\n');
    assert.match(lines, /新建：生产任务：虚构排产甲 100 只/);
    assert.match(lines, /新建：生产任务：虚构排产乙 200 只/);
    const before = f.manager.tools.flow.list('task').length;
    await confirmCard(f, v, 0, superActor(), 's');
    assert.equal(f.manager.tools.flow.list('task').length, before + 2);
  } finally {
    f.close();
  }
});

test('出卡片以后数据变了：确认时照旧拦下，说清哪条变了；卡片作废，交回助手的是“按最新数据重新出一张”', async () => {
  const f = assistantFixture();
  try {
    const c = f.store.saveCustomer(customerSchema.parse({ name: '虚构过期客户' }));
    const t = f.manager.create(actor);
    f.replies.push(call('records.propose_save', { module: 'customers', id: c.id, patch: { phone: '111' } }), { message: '出了卡片。' });
    const v = await f.say(t.id, '把虚构过期客户的电话改成 111');
    const plan = lastCard(v);
    // 出卡片以后有人在页面上改了这位客户
    const shown = f.store.customer(c.id);
    assert.ok(shown);
    f.store.saveCustomer(customerSchema.parse({ name: '虚构过期客户', notes: '页面上刚改过' }), c.id, shown.version);
    await assert.rejects(() => confirmCard(f, v, 0, actor, 's'), (e: unknown) => e instanceof AppError && e.code === 'card-stale' && /虚构过期客户 变了/.test(e.message) && /重新出一张/.test(e.message));
    assert.equal(f.store.customer(c.id)?.phone, '', '没有执行');
    f.replies.push({ message: '数据变了，我按最新的重新出一张。' });
    await f.say(t.id, '', { card: { id: plan.id, decision: 'rejected' } });
    const note = serverNote(f.requests, -1, '服务器：');
    assert.match(messageText(note), /用户点了确认，但没有执行.*虚构过期客户 变了.*重新出一张/);
    // 这张作废的卡片：再点确认、再点不执行都不行，结果也只交给助手一次；存下的那条不显示的消息写的是“数据变了作废”，不是“点了拒绝”
    assert.throws(() => f.manager.execute(plan.id, { acknowledged: true }, actor, 's'), /已经作废/);
    assert.equal(f.manager.view(t.id, actor).messages.find((m) => m.plans?.length)?.plans?.[0].state, 'cancelled');
    await assert.rejects(f.say(t.id, '', { card: { id: plan.id, decision: 'rejected' } }), /已经交给助手了/);
    const hidden = f.store.db.prepare("SELECT text FROM assistant_messages WHERE thread_id=? AND json_extract(document,'$.card.id')=?").get(t.id, plan.id);
    assert.equal(hidden?.text, '（在确认卡片上点了确认，但数据已经变了，卡片作废）');
  } finally {
    f.close();
  }
});

test('数据管理命令一次改几条：一张卡片，确认后按原单位换算长宽高', async () => {
  const f = assistantFixture();
  try {
    const owner = localAdministratorActor(superActor());
    const products = [0, 1, 2].map((i) => f.store.saveProduct(productSchema.parse({ name: '虚构尺寸' + i, length: 30, width: 20, height: 10, dimensionUnit: 'cm' })));
    f.replies.push(
      call('management.execute', {
        requestId: randomUUID(),
        module: 'products',
        action: 'update',
        items: products.map((p) => ({ id: p.id, version: p.version })),
        patch: { dimensionUnit: 'mm' },
        reason: '用户要求这几个产品改毫米',
      }),
    );
    const v = await f.say(f.manager.create(owner).id, '把这三个产品的尺寸单位改为毫米，保持真实尺寸', {}, owner);
    assert.deepEqual(v.messages.at(-1)?.plans?.map((p) => p.label), ['数据管理：修改产品 3 条：产品 虚构尺寸0 等 3 条']);
    assert(f.store.products().every((p) => p.dimensionUnit === 'cm'), '没点不改');
    await confirmCard(f, v, 0, owner, 's');
    assert(f.store.products().every((p) => p.dimensionUnit === 'mm' && p.length === 300 && p.width === 200 && p.height === 100));
  } finally {
    f.close();
  }
});

test('删聊天记录：全部连当前会话一起删时，卡片列出自己别的会话、写明清空当前会话，别的账号的会话不在里面；点了才删', async () => {
  const f = assistantFixture();
  try {
    const other = { ...actor, id: 'fictional-other-user' };
    const current = f.manager.create(actor),
      old = f.manager.create(actor),
      theirs = f.manager.create(other);
    for (const [id, title] of [[old.id, '虚构我的旧会话'], [theirs.id, '虚构别人的会话']])
      f.store.db.prepare('UPDATE assistant_threads SET title=? WHERE id=?').run(title, id);
    f.replies.push(call('chat.delete', { all: true, includeCurrent: true }), { message: '出了卡片。' });
    const v = await f.say(current.id, '把聊天记录全删了');
    const card = lastCard(v);
    assert.equal(card.label, '删除聊天记录：1 个会话，并清空当前会话');
    assert.deepEqual(card.summary, [
      { label: '会话 1', value: '虚构我的旧会话' },
      { label: '当前会话', value: '记录和附件全部清空' },
    ]);
    assert.ok(f.manager.view(old.id, actor), '没点不删');
    await confirmCard(f, v, 0, actor, 's');
    assert.throws(() => f.manager.view(old.id, actor), /不存在/);
    assert.equal(f.manager.view(current.id, actor).messages.length, 0);
    assert.ok(f.manager.view(theirs.id, other), '别人的会话还在');
  } finally {
    f.close();
  }
});

test('改提示词的卡片出了以后这条提示词被人改过：确认时拒绝，不覆盖人的修改', async () => {
  const f = assistantFixture();
  try {
    const boss = superActor();
    const state = f.prompts.view(),
      preset = state.presets[0],
      entry = preset.entries[0];
    f.replies.push(call('prompts.propose', { module: 'assistant', presetId: preset.id, entryId: entry.id, expectedRevision: state.revision, content: entry.content + '（虚构：先说结论。）' }));
    const v = await f.say(f.manager.create(boss).id, '提示词加一句先说结论', {}, boss);
    assert.equal(lastCard(v).tool, 'prompts.propose');
    const changed = { ...preset, entries: preset.entries.map((e) => (e.id === entry.id ? { ...e, content: '虚构：别人刚改过的内容' } : e)) };
    f.prompts.change('save', { expectedRevision: state.revision, preset: changed, activate: false });
    await assert.rejects(async () => confirmCard(f, v, 0, boss, 's'), (e: unknown) => e instanceof AppError && e.status === 409 && /出卡片之后被改过/.test(e.message));
    assert.equal(f.prompts.view().presets[0].entries[0].content, '虚构：别人刚改过的内容');
  } finally {
    f.close();
  }
});

test('改已入库到货单的备注和到货时间（flow.edit_info）：卡片写明哪张、改前改后；点了才改，不动库存；出卡片后被人改过就拒绝', async () => {
  const flow = flowFixture();
  const { arrivalId } = correctionFixture(flow, clerk);
  const f = assistantFixture([], { store: flow.store });
  try {
    const thread = f.manager.create(actor).id;
    const moves = () => flow.store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all();
    const before = moves();
    f.replies.push(call('flow.edit_info', { id: arrivalId, notes: '虚构：司机说下次走后门', actualTime: '14:30' }));
    const v = await f.say(thread, '把这张到货单备注改一下，下午两点半到的');
    const card = lastCard(v);
    const number = flow.flow.get(arrivalId).number;
    assert.match(card.label, new RegExp('^编辑到货单的说明（不动库存和金额）：到货单 ' + number));
    assert.deepEqual(card.summary?.slice(1, 3), [
      { label: '备注', value: '未填写 → 虚构：司机说下次走后门' },
      { label: '实际时间', value: '未填写 → 14:30' },
    ]);
    assert.equal(flow.flow.get(arrivalId).notes ?? '', '', '没点不改');
    await confirmCard(f, v, 0, actor, 's');
    assert.deepEqual([flow.flow.get(arrivalId).notes, flow.flow.get(arrivalId, 'arrival').actualTime], ['虚构：司机说下次走后门', '14:30']);
    assert.deepEqual(moves(), before, '不动库存流水');
    f.replies.push(call('flow.edit_info', { id: arrivalId, notes: '虚构：第二次改' }));
    const stale = await f.say(thread, '备注再改一下');
    const doc = flow.flow.get(arrivalId);
    updateDocumentInfo(flow.store, arrivalId, { notes: '虚构：页面上刚改的', expectedVersion: doc.version }, clerk);
    await assert.rejects(async () => confirmCard(f, stale, 0, actor, 's'));
    assert.equal(flow.flow.get(arrivalId).notes, '虚构：页面上刚改的');
  } finally {
    f.close();
  }
});

test('识别工作区的卡片：每份写文件名和它真实的识别状态（识别好的写“待核对”，没识别的写“待识别”）', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const owner = localAdministratorActor(superActor());
    let done = (await f.imports.upload(imageFixture(), '虚构已识别.png', true)).workspace;
    done = await f.imports.analyze(done.id, { expectedRevision: done.revision }, undefined, importer);
    const fresh = (await f.imports.upload(imageFixture(true), '虚构没识别.jpg', true)).workspace;
    assert.equal(f.imports.load(done.id).task?.state, 'ready');
    assert.equal(f.imports.load(fresh.id).task?.state, 'uploaded');
    const plan = f.manager.tools.prepare('management.workspaces', { action: 'archive', requestId: randomUUID(), items: [{ id: done.id }, { id: fresh.id }] }, owner, 's');
    assert.deepEqual(plan.summary, [
      { label: '文件', value: '虚构已识别.png（待核对）' },
      { label: '文件', value: '虚构没识别.jpg（待识别）' },
    ]);
  } finally {
    f.close();
  }
});
