// 助手订单导入各部分单独测：直接 import order-import-*.ts 的函数调用，不经过聊天和模型回复。
// 整条聊天流程的测试在 assistant-order-workflow.test.ts。
import { sales } from '../../server/sales/index.js';
import { test } from 'node:test';
import { productSchema } from '../../shared/core/domain.js';
import { executeImports, importCard } from '../../server/assistant/order-import-card.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOrderWorkflowFixture } from '../support/assistant-workflow-fixture.js';
import { imageFixture, xlsxFixture } from '../support/import-fixtures.js';
import { AssistantOrderWorkflow } from '../../server/assistant/order-workflow.js';
import type { WorkflowContext } from '../../server/assistant/order-import-state.js';
import { prepare, recognize } from '../../server/assistant/order-import-prepare.js';
import { attach, fromInbox, list, start } from '../../server/assistant/order-import-intake.js';
import { onTask } from '../../server/assistant/order-import-edits.js';
import { WORKFLOW_DIRECT } from '../../server/assistant/chat/workflow-direct.js';
import { orderImportTools } from '../../server/assistant/tools/order-import.js';
import { InboxService } from '../../server/inbox/index.js';
import { AppError } from '../../server/core/index.js';
import { actor, grant } from '../support/actor-fixture.js';

const who = { ...actor, permissions: grant('business:edit', 'import:execute') };

async function setup() {
  const f = createOrderWorkflowFixture();
  let w = (await f.imports.upload(imageFixture(), '虚构订单.png', true)).workspace;
  w = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, who);
  const wf = new AssistantOrderWorkflow(f.store, f.imports, f.execution, f.manager.attachments);
  const thread = f.manager.create(who);
  const events: { event: string; data: unknown }[] = [];
  const ctx = (over: Partial<WorkflowContext> = {}): WorkflowContext => ({
    threadId: thread.id,
    actor: who,
    requestId: randomUUID(),
    files: [],
    check: () => who,
    signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }),
    ...over,
  });
  return { f, w, wf, thread, ctx, events };
}

test('order-import-state、intake：关联已有工作区建一个任务、重复关联不新增；列表不识别；到货单不能当订单开始', async () => {
  const { f, w, wf, thread, ctx } = await setup();
  try {
    assert.deepEqual(wf.view(thread.id, who), { tasks: [] });
    assert.throws(() => wf.selected(ctx()), /当前会话尚未关联该订单任务/);
    await assert.rejects(start(wf, {}, ctx()), /请选择当前会话可访问的订单附件/);
    const before = f.recognitionCalls();
    const listed = await list(wf, {}, ctx());
    assert.ok(listed.active.some((x) => x.id === w.id));
    assert.deepEqual(listed.archived, [], '归档的只给本机最高管理员看');
    const first = await attach(wf, { workspaceId: w.id }, ctx());
    const again = await attach(wf, { workspaceId: w.id }, ctx());
    assert.equal(again.task.id, first.task.id);
    assert.equal(wf.state(thread.id, who).tasks.length, 1);
    assert.equal(wf.selected(ctx()).task.id, first.task.id);
    assert.equal(first.workspace.id, w.id);
    assert.equal(f.recognitionCalls(), before);
    await assert.rejects(start(wf, { recognitionType: 'arrival' }, ctx()), /请改用 arrival.recognize/);
  } finally {
    f.close();
  }
});

test('从收件箱转进来的订单文件，order_import.start 不带参数：识别这一份，识别次数加 1，任务有识别结果', async () => {
  const { f, wf, ctx } = await setup();
  try {
    const inbox = new InboxService(f.store);
    const item = inbox.ingest({
      channel: 'manual',
      externalId: 'fictional-inbox-start-1',
      kind: 'image',
      receivedAt: '2026-11-05T10:00:00Z',
      file: { name: '收件待识别订单.jpg', mime: 'image/jpeg', bytes: new Uint8Array(imageFixture(true)) },
    });
    await fromInbox(wf, { inboxId: item.id, expectedVersion: item.version }, ctx());
    const before = f.recognitionCalls();
    const done = await start(wf, {}, ctx());
    assert.equal(f.recognitionCalls(), before + 1);
    assert.equal(done.task.state, 'awaiting_confirmation');
    assert.ok(done.workspace.draft);
    assert.match(done.message, /本批共 1 份订单文件/);
  } finally {
    f.close();
  }
});

test('taskIds 点名非当前且已有识别结果的任务：不重新识别，识别份数记 0，回执写明没有重新识别且不含提交识别', async () => {
  const { f, w, wf, thread, ctx } = await setup();
  try {
    const attached = await attach(wf, { workspaceId: w.id }, ctx());
    const otherWs = (await f.imports.upload(imageFixture(true), '当前另一份.jpg', true)).workspace;
    const otherTask = await attach(wf, { workspaceId: otherWs.id }, ctx());
    assert.equal(wf.state(thread.id, who).activeId, otherTask.task.id);
    const before = f.recognitionCalls();
    const done = await start(wf, { taskIds: [attached.task.id] }, ctx());
    assert.equal(f.recognitionCalls(), before);
    assert.equal(done.task.id, attached.task.id);
    assert.equal(done.task.state, 'awaiting_confirmation');
    assert.ok(done.workspace.draft);
    assert.match(done.message, /已有识别结果，没有重新识别/);
    assert.doesNotMatch(done.message, /提交识别/);
    assert.equal(done.recognizedCount, 0);
  } finally {
    f.close();
  }
});

test('上次识别中断（存为 recognizing 且不在运行中）的任务：start 不带参数不重新识别，retry 可重新识别', async () => {
  const { f, wf, thread, ctx } = await setup();
  try {
    const pending = (await f.imports.upload(imageFixture(true), '中断待重试.jpg', true)).workspace;
    const attached = await attach(wf, { workspaceId: pending.id }, ctx());
    const state = wf.state(thread.id, who);
    state.tasks[0].state = 'recognizing';
    wf.save(ctx(), state);
    const before = f.recognitionCalls();
    const done = await start(wf, {}, ctx());
    assert.equal(f.recognitionCalls(), before);
    assert.match(done.message, /上次识别已中断.*重试/);
    assert.doesNotMatch(done.message, /提交识别/);
    const retried = await onTask(wf, 'order_import.retry', {}, ctx());
    assert.equal(f.recognitionCalls(), before + 1);
    assert.equal(retried.task.id, attached.task.id);
    assert.ok(retried.workspace.draft);
  } finally {
    f.close();
  }
});

test('当前任务关联后被改成到货单：start 不带参数直接报到货单错误，不吞错、不跳页，识别次数不变', async () => {
  const { f, wf, ctx, events } = await setup();
  try {
    const pending = (await f.imports.upload(imageFixture(true), '后来改到货.jpg', true)).workspace;
    await attach(wf, { workspaceId: pending.id }, ctx());
    f.imports.setMode(pending.id, { expectedRevision: pending.revision, mode: 'arrival' });
    events.length = 0;
    const before = f.recognitionCalls();
    await assert.rejects(start(wf, {}, ctx()), /该任务已切换为到货单/);
    assert.equal(f.recognitionCalls(), before);
    assert.equal(events.length, 0);
  } finally {
    f.close();
  }
});

test('一批任务里有一份被改成到货单、一份正常：start 回执逐份写明被拒原因与识别结果', async () => {
  const { f, wf, ctx } = await setup();
  try {
    const arrivalWs = (await f.imports.upload(imageFixture(), '切换到货.png', true)).workspace;
    const normalWs = (await f.imports.upload(imageFixture(true), '正常待识别.jpg', true)).workspace;
    const arrivalTask = (await attach(wf, { workspaceId: arrivalWs.id }, ctx())).task;
    const normalTask = (await attach(wf, { workspaceId: normalWs.id }, ctx())).task;
    f.imports.setMode(arrivalWs.id, { expectedRevision: arrivalWs.revision, mode: 'arrival' });
    const before = f.recognitionCalls();
    const done = await start(wf, { taskIds: [arrivalTask.id, normalTask.id] }, ctx());
    assert.equal(f.recognitionCalls(), before + 1);
    assert.match(done.message, /切换到货\.png：该任务已切换为到货单/);
    assert.match(done.message, /正常待识别\.jpg：识别完成/);
    assert.doesNotMatch(done.message, /。[。；]/, '被拒原因自带的句号不和分隔符连在一起');
  } finally {
    f.close();
  }
});

test('第一份目标被拒、后面的识别了：回执主体、当前任务和跳页都是识别了的那份', async () => {
  const { f, wf, thread, ctx, events } = await setup();
  try {
    const arrivalWs = (await f.imports.upload(imageFixture(), '先被拒.png', true)).workspace;
    const normalWs = (await f.imports.upload(imageFixture(true), '后识别.jpg', true)).workspace;
    const arrivalTask = (await attach(wf, { workspaceId: arrivalWs.id }, ctx())).task;
    const normalTask = (await attach(wf, { workspaceId: normalWs.id }, ctx())).task;
    f.imports.setMode(arrivalWs.id, { expectedRevision: arrivalWs.revision, mode: 'arrival' });
    events.length = 0;
    const done = await start(wf, { taskIds: [arrivalTask.id, normalTask.id] }, ctx());
    assert.equal(done.task.id, normalTask.id);
    assert.equal(wf.state(thread.id, who).activeId, normalTask.id);
    const jumps = events.filter((e) => e.event === 'effect' && JSON.stringify(e.data).includes('"navigate"'));
    assert.ok(jumps.length);
    assert.ok(jumps.every((e) => JSON.stringify(e.data).includes(normalWs.id)));
  } finally {
    f.close();
  }
});

test('工作区正被页面或别的会话识别、只有这一份：没调模型，原样报忙，不说已提交识别', async () => {
  const { f, wf, ctx } = await setup();
  try {
    const pending = (await f.imports.upload(imageFixture(true), '页面在识别.jpg', true)).workspace;
    await attach(wf, { workspaceId: pending.id }, ctx());
    f.imports.busy.set(pending.id, new AbortController());
    const before = f.recognitionCalls();
    await assert.rejects(start(wf, {}, ctx()), /该工作区正在调用 AI/);
    assert.equal(f.recognitionCalls(), before);
  } finally {
    f.close();
  }
});

test('一份工作区正忙、一份正常：识别份数只算正常那份，回执写明忙的那份被拒的原因', async () => {
  const { f, wf, ctx } = await setup();
  try {
    const busyWs = (await f.imports.upload(Buffer.concat([imageFixture(true), Buffer.from([1])]), '正忙.jpg', true)).workspace;
    const normalWs = (await f.imports.upload(imageFixture(true), '正常.jpg', true)).workspace;
    const busyTask = (await attach(wf, { workspaceId: busyWs.id }, ctx())).task;
    const normalTask = (await attach(wf, { workspaceId: normalWs.id }, ctx())).task;
    f.imports.busy.set(busyWs.id, new AbortController());
    const before = f.recognitionCalls();
    const done = await start(wf, { taskIds: [busyTask.id, normalTask.id] }, ctx());
    assert.equal(f.recognitionCalls(), before + 1);
    assert.equal(done.recognizedCount, 1);
    assert.match(done.message, /正忙\.jpg：该工作区正在调用 AI/);
  } finally {
    f.close();
  }
});

test('order_import.start 的 does 只看这次真识别的份数，不看回执里的字', () => {
  const does = WORKFLOW_DIRECT['order_import.start'].does;
  assert.equal(typeof does, 'function');
  if (typeof does !== 'function') return;
  assert.equal(does({ recognizedCount: 0, message: '待提交识别订单.png：已有识别结果' }), '没有重新识别订单文件');
  assert.equal(does({ recognizedCount: 1, message: '' }), '识别订单文件');
});

test('attachmentIds 与 taskIds 合并去重后超过 6 份上限：在上传附件前报错，一份都不识别，会话不多出任务', async () => {
  const { f, wf, thread, ctx } = await setup();
  try {
    const taskIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ws = (await f.imports.upload(Buffer.concat([imageFixture(), Buffer.from([i])]), `任务${i}.png`, true)).workspace;
      taskIds.push((await attach(wf, { workspaceId: ws.id }, ctx())).task.id);
    }
    const files = [];
    for (let i = 0; i < 3; i++) {
      files.push(
        await f.manager.attachments.upload(
          thread.id,
          Buffer.concat([imageFixture(true), Buffer.from([i])]),
          `附件${i}.jpg`,
          randomUUID(),
          who,
        ),
      );
    }
    const before = f.recognitionCalls();
    await assert.rejects(
      start(wf, { attachmentIds: files.map((x) => x.id), taskIds }, ctx({ files })),
      /一次最多识别 6 份订单文件/,
    );
    assert.equal(f.recognitionCalls(), before);
    assert.equal(wf.state(thread.id, who).tasks.length, 4);
  } finally {
    f.close();
  }
});

test('taskIds 里有同账号另一会话或别的账号会话的真实任务：报错，一份都不识别，本会话不多出任务', async () => {
  const { f, w, wf, thread, ctx } = await setup();
  try {
    const otherThread = f.manager.create(who);
    const sameUserOtherTask = (await attach(wf, { workspaceId: w.id }, ctx({ threadId: otherThread.id }))).task;
    const otherUser = { ...who, id: 'other-user', username: 'other' };
    const otherUserThread = f.manager.create(otherUser);
    const otherUserTask = (
      await attach(wf, { workspaceId: w.id }, ctx({ threadId: otherUserThread.id, actor: otherUser, check: () => otherUser }))
    ).task;
    const file = await f.manager.attachments.upload(thread.id, xlsxFixture(), '不该识别.xlsx', randomUUID(), who);
    const before = f.recognitionCalls();
    for (const badId of [sameUserOtherTask.id, otherUserTask.id]) {
      await assert.rejects(
        start(wf, { attachmentIds: [file.id], taskIds: [badId] }, ctx({ files: [file] })),
        /不属于当前会话/,
      );
      assert.equal(f.recognitionCalls(), before);
      assert.equal(wf.state(thread.id, who).tasks.length, 0);
    }
  } finally {
    f.close();
  }
});

test('两份内容相同的聊天附件一起传给 start：按任务编号去重后只算 1 份，回执不重复列两遍', async () => {
  const { f, wf, thread, ctx } = await setup();
  try {
    const bytes = imageFixture(true);
    const a = await f.manager.attachments.upload(thread.id, bytes, '相同甲.jpg', randomUUID(), who);
    const b = await f.manager.attachments.upload(thread.id, bytes, '相同乙.jpg', randomUUID(), who);
    const before = f.recognitionCalls();
    const done = await start(wf, { attachmentIds: [a.id, b.id] }, ctx({ files: [a, b] }));
    assert.equal(f.recognitionCalls(), before + 1);
    assert.match(done.message, /本批共 1 份订单文件/);
    assert.equal(done.message.split('。')[0].includes('；'), false);
  } finally {
    f.close();
  }
});

test('没有附件、本会话也没有任何任务：报错并写明先上传附件或用 from_inbox、attach 放入本会话，识别次数不变', async () => {
  const { f, wf, ctx } = await setup();
  try {
    const before = f.recognitionCalls();
    await assert.rejects(
      start(wf, {}, ctx()),
      /请选择当前会话可访问的订单附件.*order_import\.from_inbox.*order_import\.attach/,
    );
    assert.equal(f.recognitionCalls(), before);
  } finally {
    f.close();
  }
});

test('同时给 attachmentIds 和 taskIds：参数结构收下，两份都识别各一次，识别份数记 2', async () => {
  const { f, wf, thread, ctx } = await setup();
  try {
    const pending = (await f.imports.upload(imageFixture(true), '待识别工作区.jpg', true)).workspace;
    const attached = await attach(wf, { workspaceId: pending.id }, ctx());
    const file = await f.manager.attachments.upload(thread.id, xlsxFixture(), '聊天附件订单.xlsx', randomUUID(), who);
    const tool = orderImportTools.find((t) => t.name === 'order_import.start');
    assert.ok(tool);
    assert.deepEqual(tool.schema.parse({ attachmentIds: [file.id], taskIds: [attached.task.id] }), {
      attachmentIds: [file.id],
      taskIds: [attached.task.id],
      recognitionType: 'order',
    });
    const before = f.recognitionCalls();
    const done = await start(wf, { attachmentIds: [file.id], taskIds: [attached.task.id] }, ctx({ files: [file] }));
    assert.equal(f.recognitionCalls(), before + 2);
    assert.equal(done.tasks.length, 2);
    assert.deepEqual(done.tasks.map((t) => t.state), ['awaiting_confirmation', 'awaiting_confirmation']);
    assert.match(done.message, /本批共 2 份订单文件.*提交识别/);
    assert.equal(done.recognizedCount, 2);
  } finally {
    f.close();
  }
});

test('order-import-prepare：已有识别结果时 recognize 不再调模型，直接生成待确认的正式导入预览', async () => {
  const { f, w, wf, ctx, events } = await setup();
  try {
    await attach(wf, { workspaceId: w.id }, ctx());
    const before = f.recognitionCalls();
    const c = ctx();
    const { state, task } = wf.selected(c);
    await recognize(wf, c, state, task);
    assert.equal(f.recognitionCalls(), before);
    assert.equal(task.state, 'awaiting_confirmation');
    assert.ok(task.preview?.previewDigest);
    assert.equal(task.previewRequest, c.requestId);
    // 再预览一次：换成这一轮的请求编号，存回会话
    const c2 = ctx();
    await prepare(wf, c2, state, task);
    assert.equal(wf.state(c2.threadId, who).tasks[0].previewRequest, c2.requestId);
    assert.equal(events.length, 0);
  } finally {
    f.close();
  }
});

test('order-import-card：卡片上客户和每行产品都写明用已有档案还是新建，新建的下面列出相近的已有档案（照导入方案给的列）', async () => {
  const { f, w, wf, ctx } = await setup();
  try {
    const buyer = sales(f.store).customers()[0];
    const old = sales(f.store).createProduct(productSchema.parse({ name: '聊天纸箱甲', length: 300, width: 200, height: 150, dimensionUnit: 'mm' }));
    // 和第 2 行同名、尺寸不同的老产品（同一客户下）：第 2 行要新建时它是“已有同名的产品”
    sales(f.store).createProduct(productSchema.parse({ name: '聊天纸箱乙', length: 210, width: 150, height: 100, dimensionUnit: 'mm', customerId: buyer.id }));
    await attach(wf, { workspaceId: w.id }, ctx());
    await onTask(wf, 'order_import.match', {}, ctx());
    await onTask(wf, 'order_import.match', { line: 1, productId: old.id }, ctx());
    await onTask(wf, 'order_import.match', { line: 2, createNew: true }, ctx());
    const lines = (await importCard(wf, ctx(), {})).summary.map((l) => l.label + '：' + l.value);
    assert.ok(lines.includes('客户：聊天验收客户（用已有档案：聊天验收客户）'));
    assert.ok(lines.includes('第 1 行：聊天纸箱甲 300×200×150，100 只，单价 1.2345（用已有档案：聊天纸箱甲）'));
    const second = lines.indexOf('第 2 行：聊天纸箱乙 200×150×100，100 只，单价 1.2345（新建）');
    assert.ok(second > 0);
    // 已有同名的那个老产品紧跟在这一行下面，带名称和尺寸；同一个档案不重复列两遍
    assert.equal(lines[second + 1], '第 2 行已有同名的产品：聊天纸箱乙（210 × 150 × 100 mm）。确认即表示这是另一个产品。');
    assert.equal(lines.filter((l) => l.includes('聊天纸箱乙（210 × 150 × 100 mm）')).length, 1);
    assert.ok(!lines.some((l) => l.includes('相近的已有客户')), '用已有档案的不列相近的');
    // 客户改成一个没有档案的名字：写明新建，下面列出相近的已有客户
    const now = f.imports.get(w.id);
    f.imports.edit(w.id, { expectedRevision: now.revision, operations: [{ op: 'set-header', field: 'buyerName', value: '聊天验收客户二厂', reason: '虚构修改' }] }, 'ai', who);
    await onTask(wf, 'order_import.match', { createNew: true }, ctx());
    const again = (await importCard(wf, ctx(), {})).summary.map((l) => l.label + '：' + l.value);
    const customer = again.indexOf('客户：聊天验收客户二厂（新建）');
    assert.ok(customer > 0);
    assert.equal(again[customer + 1], '相近的已有客户：聊天验收客户');
    assert.equal(sales(f.store).orders().length, 0, '出卡片不建订单');
  } finally {
    f.close();
  }
});

test('order-import-edits、order-import-card：没失败不重试；匹配已有客户后刷新预览；正式导入先出卡片内容、确认后只导一次', async () => {
  const { f, w, wf, ctx } = await setup();
  try {
    await attach(wf, { workspaceId: w.id }, ctx());
    await assert.rejects(onTask(wf, 'order_import.retry', {}, ctx()), /当前任务没有失败/);
    const matched = await onTask(wf, 'order_import.match', {}, ctx());
    assert.equal(matched.workspace.mapping?.customer.mode, 'existing');
    assert.match(matched.message, /^档案匹配已保存。/);
    // 出卡片：只算不写，卡片上逐行列出实际会建什么
    const card = await importCard(wf, ctx(), {});
    assert.equal(sales(f.store).orders().length, 0);
    assert.match(card.label, /^正式导入订单：/);
    assert.match(card.label, /（聊天验收客户）$/, '标题带客户名');
    assert.ok(card.summary.some((l) => l.label === '客户' && l.value === '聊天验收客户（用已有档案：聊天验收客户）'), '客户写明用已有档案');
    assert.ok(card.summary.some((l) => /^第 1 行$/.test(l.label) && /^聊天纸箱甲 .*100 只，单价 1\.2345.*（新建）$/.test(l.value)), '每行品名、数量、单价、是不是新建');
    assert.ok(card.summary.some((l) => l.label === '交货日期'));
    assert.ok(card.summary.some((l) => l.label === '客户') && card.summary.some((l) => l.label === '合计'));
    const done = await executeImports(wf, ctx(), card.args.imports);
    assert.ok(done.order?.id);
    assert.equal(sales(f.store).orders().length, 1);
    // 已经导入过：不再出卡片，同一张卡片再确认一次也不重复建
    await assert.rejects(importCard(wf, ctx(), {}), /已经导入过，不会重复导入/);
    await assert.rejects(executeImports(wf, ctx(), card.args.imports));
    assert.equal(sales(f.store).orders().length, 1);
    await assert.rejects(onTask(wf, 'order_import.edit', { expectedRevision: 1, operations: [] }, ctx()), /已经正式导入，识别结果不能再改/);
  } finally {
    f.close();
  }
});

test('order-import-edits：带旧修订号改识别结果——人在页面改的是别的字段就照改；改的正是人刚改过的字段就拒绝，不覆盖人的修改', async () => {
  const { f, w, wf, ctx } = await setup();
  try {
    assert.ok(w.draft, '识别出了内容');
    const [first, second] = w.draft.lines.map((l) => l.id);
    const seen = (await attach(wf, { workspaceId: w.id }, ctx())).workspace.revision;
    const setLine = (lineId: string, field: string, value: string) => ({ op: 'set-line' as const, lineId, field, value, reason: '虚构修改' });
    const byHand = (op: ReturnType<typeof setLine>) =>
      f.imports.edit(w.id, { expectedRevision: f.imports.get(w.id).revision, operations: [op] }, 'manual', who);
    byHand(setLine(first, 'quantity', '150'));
    const merged = await onTask(wf, 'order_import.edit', { expectedRevision: seen, operations: [setLine(second, 'quantity', '250')] }, ctx());
    assert.deepEqual(merged.workspace.draft?.lines.map((l) => l.fields.quantity.value), ['150', '250'], '人改的那行留着，助手改的另一行也改上');
    const again = merged.workspace.revision;
    byHand(setLine(first, 'quantity', '160'));
    await assert.rejects(
      onTask(wf, 'order_import.edit', { expectedRevision: again, operations: [setLine(first, 'quantity', '999')] }, ctx()),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'business-conflict',
    );
    assert.equal(f.imports.get(w.id).draft?.lines[0].fields.quantity.value, '160');
  } finally {
    f.close();
  }
});
