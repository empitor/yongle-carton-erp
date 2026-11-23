// 聊天里识别导入客户订单：附件→识别→改→确认导入的整条流程、批量识别、各格式原件、型号匹配、改别人那份出卡片、
// 识别失败重试、权限隔离、到货模式不能当订单、收件箱转进对话、HTTP+SSE、多会话去重。
// 关联页面上已识别的工作区见 assistant-order-attach.test.ts。假 DeepSeek、临时目录、虚构数据。
import { sales } from '../../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackedOrderOf } from '../support/flow-fixture.js';
import { randomUUID } from 'node:crypto';
import { AssistantOrderWorkflow } from '../../server/assistant/order-workflow.js';
import { InboxService } from '../../server/inbox/service.js';
import { z } from 'zod';
import { confirmCard, lastCard } from '../support/assistant-fixture.js';
import { count as countOf } from '../../server/core/index.js';
import { productSchema } from '../../shared/core/domain.js';
import { imageFixture, docxFixture, xlsxFixture, pdfFixture } from '../support/import-fixtures.js';
import { createOrderWorkflowFixture, importer as actor } from '../support/assistant-workflow-fixture.js';
import { startHttp } from '../support/http-fixture.js';
import { SseParser } from '../../shared/core/sse.js';
import { FlowService } from '../../server/flow/index.js';
import { asList, field } from '../../server/assistant/chat/result-fields.js';
import { readAs } from '../support/read-result.js';
/** 工作流 call() 交回的结果（各命令不同）按路径取一项 */
const at = (value: unknown, ...path: (string | number)[]) => path.reduce<unknown>((v, k) => (typeof k === 'number' ? (asList(v) ?? [])[k] : field(v, k)), value);

// 测的是识别导入流程本身的规矩（开了自动确认；“不点确认就不落库”见 assistant-boundaries.test.ts）
const fixture = () => createOrderWorkflowFixture(undefined, { agent: { autoConfirm: true } });
const count = (f: ReturnType<typeof fixture>, sql: string) => countOf(f.store.db, sql);
/** 工作区的识别内容；还没识别就让测试失败 */
function draftOf<D>(w: { draft?: D | null }): D {
  assert.ok(w.draft, '工作区还没有识别内容');
  return w.draft;
}
const editLine = (f: ReturnType<typeof fixture>, lineOf: () => string, value: string, field = 'quantity') => () => ({
  message: '',
  toolCalls: [
    {
      name: 'order_import.edit',
      args: { expectedRevision: f.current().revision, operations: [{ op: 'set-line', lineId: lineOf(), field, value, reason: '虚构修改' }] },
    },
  ],
});

test('聊天附件识别→跨轮改同一份→确认导入；用量计入这一轮的预算；同一请求重发和再说一次都不重复导入', async () => {
  const f = fixture();
  try {
    const attachment = await f.manager.attachments.upload(f.thread.id, imageFixture(), '客户采购订单.png', randomUUID(), actor);
    let view = await f.send('帮我识别这张客户采购订单', [attachment.id]);
    const task = view.orderWorkflow?.tasks[0],
      first = f.current();
    assert.ok(task, '会话里有订单导入任务');
    assert(first.draft);
    assert.equal(f.recognitionCalls(), 1);
    assert.equal(task.state, 'awaiting_confirmation');
    assert(f.events.some((e) => e.event === 'effect' && e.data.type === 'navigate' && String(e.data.url).includes(task.workspaceId)));
    // 识别那次的真实用量（假 DeepSeek 每次 150）和对话的用量记在同一份运行记录里
    const run = f.store.db.prepare('SELECT document FROM assistant_runs ORDER BY rowid DESC LIMIT 1').get();
    assert.ok(run, '有运行记录');
    const budget = readAs(JSON.parse(String(run.document)), {
      budget: z.looseObject({
        used: z.looseObject({ modelCalls: z.unknown() }),
        providerUsage: z.looseObject({ requests: z.unknown(), totalTokens: z.unknown() }),
      }),
    }).budget;
    assert.equal(budget.used.modelCalls, 3);
    assert.deepEqual([budget.providerUsage.requests, budget.providerUsage.totalTokens], [3, 450]);

    f.replies.push({ message: '读取', toolCalls: [{ name: 'order_import.get', args: {} }] }, editLine(f, () => draftOf(f.current()).lines[1].id, '300'));
    await f.send('把第二行数量改成300');
    assert.equal(f.current().id, first.id);
    assert.equal(draftOf(f.current()).lines[1].fields.quantity.value, '300');
    assert.equal(f.current().evaluation?.totalQuantity, '400');
    assert.equal(f.recognitionCalls(), 1);

    const nonce = randomUUID();
    view = await f.send('没问题，确认导入', [], nonce);
    const order = sales(f.store).orders()[0];
    assert.equal(order.lines[1].quantity, 300);
    assert.equal(order.lines[1].unitPriceExact, '1.2345');
    assert.equal(order.customerName, '聊天验收客户');
    assert.equal(order.currency, 'CNY');
    assert.match(view.messages.at(-1)?.facts?.executed[0].label ?? '', /^正式导入订单：/);
    assert.equal(new FlowService(f.store).views.purchases().length, 0);
    await f.send('没问题，确认导入', [], nonce);
    await f.send('没问题，确认导入');
    assert.equal(sales(f.store).orders().length, 1);
    assert.equal(f.recognitionCalls(), 1);
    assert.equal(count(f, 'SELECT COUNT(*) n FROM import_executions'), 1);
    assert.equal(count(f, 'SELECT COUNT(*) n FROM stock_movements'), 0);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    // 重开（新建一个流程对象）还认得：导入过的读回真实订单，不再是预览
    const reloaded = new AssistantOrderWorkflow(f.store, f.imports, f.execution, f.manager.attachments);
    assert.equal(reloaded.view(f.thread.id, actor).activeId, task.id);
    assert.equal(reloaded.view(f.thread.id, actor).tasks[0].state, 'imported');
    const real = await reloaded.call('order_import.get', {}, f.ctx());
    assert.deepEqual(at(real, 'order', 'lines'), trackedOrderOf(f.store, order.id).lines);
    assert(at(real, 'previewIsHistorical'));
    assert.equal(at(real, 'task', 'preview'), undefined);
  } finally {
    f.close();
  }
});

test('几份订单附件在同一次 order_import.start 里一起识别', async () => {
  const f = fixture();
  try {
    const a = await f.manager.attachments.upload(f.thread.id, imageFixture(), '订单甲.png', randomUUID(), actor);
    const b = await f.manager.attachments.upload(f.thread.id, imageFixture(true), '订单乙.jpg', randomUUID(), actor);
    f.replies.push(
      { message: '一次识别这两份订单', toolCalls: [{ name: 'order_import.start', args: { attachmentIds: [a.id, b.id] } }] },
      { message: '两份都识别好了。', toolCalls: [] },
    );
    const view = await f.send('把这两份订单一起识别', [a.id, b.id]);
    assert.equal(f.recognitionCalls(), 2);
    assert.deepEqual(view.orderWorkflow?.tasks.map((t) => t.state), ['awaiting_confirmation', 'awaiting_confirmation']);
    assert.deepEqual(view.orderWorkflow?.tasks.map((t) => t.fileName).sort(), ['订单乙.jpg', '订单甲.png']);
    assert.equal(sales(f.store).orders().length, 0);
  } finally {
    f.close();
  }
});

test('JPG、PDF、Word、Excel 附件原件原样交给识别', async () => {
  const f = fixture();
  try {
    for (const [name, bytes] of [
      ['订单.jpg', imageFixture(true)],
      ['订单.pdf', await pdfFixture()],
      ['订单.docx', docxFixture()],
      ['订单.xlsx', xlsxFixture()],
    ] as const) {
      const a = await f.manager.attachments.upload(f.thread.id, bytes, name, randomUUID(), actor);
      await f.send('帮我识别这个订单', [a.id]);
      assert((await f.imports.original(f.current().id)).bytes.equals(bytes));
    }
    assert.equal(f.recognitionCalls(), 4);
    assert.equal(sales(f.store).orders().length, 0);
  } finally {
    f.close();
  }
});

test('按客户料号匹配产品，之后改数量映射还在；料号对上两个产品时拒绝', async () => {
  const f = fixture();
  try {
    const product = sales(f.store).createProduct(productSchema.parse({ name: '型号产品', customerProductCode: 'A003' }));
    const a = await f.manager.attachments.upload(f.thread.id, xlsxFixture(), '采购订单.xlsx', randomUUID(), actor);
    await f.send('识别订单', [a.id]);
    const match = { message: '匹配', toolCalls: [{ name: 'order_import.match', args: { line: 2, productCode: 'A003' } }] };
    f.replies.push(match);
    await f.send('第二个产品对应系统中的A003型号');
    const line = draftOf(f.current()).lines[1];
    assert.deepEqual(f.current().mapping?.products[line.id], { mode: 'existing', id: product.id, version: product.version });
    f.replies.push(editLine(f, () => line.id, '300'));
    await f.send('第二行数量改成300');
    assert.equal(field(f.current().mapping?.products[line.id], 'id'), product.id);
    sales(f.store).createProduct(productSchema.parse({ name: '另一型号产品', customerProductCode: 'A003' }));
    f.replies.push(match);
    const result = await f.send('第二行对应A003型号');
    assert.match(result.messages.at(-1)?.text ?? '', /未唯一匹配/);
  } finally {
    f.close();
  }
});

test('改识别结果：这次对话里上传后识别的直接改；关联进来的别人那份只出确认卡片，人点了才改', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const a = await f.manager.attachments.upload(f.thread.id, xlsxFixture(), '采购订单.xlsx', randomUUID(), actor);
    await f.send('识别订单', [a.id]);
    const own = f.current();
    f.replies.push(editLine(f, () => draftOf(own).lines[0].id, '300'), { message: '改好了。' });
    let view = await f.send('第一行数量改成300');
    assert.equal(view.messages.at(-1)?.plans?.length, 0);
    assert.equal(draftOf(f.imports.get(own.id)).lines[0].fields.quantity.value, '300');
    // 别人在 AI 导入页面上传、识别的那份：关联进来可以看，改它只出卡片
    let theirs = (await f.imports.upload(imageFixture(), '别人的订单.png', true)).workspace;
    theirs = await f.imports.analyze(theirs.id, { expectedRevision: theirs.revision }, undefined, actor);
    f.replies.push(
      { message: '', toolCalls: [{ name: 'order_import.attach', args: { workspaceId: theirs.id } }] },
      editLine(f, () => draftOf(theirs).lines[0].id, '999'),
      { message: '请在卡片上确认。' },
    );
    view = await f.send('看看别人那份识别得怎么样');
    const card = lastCard(view);
    assert.equal(card.label, '改识别结果：别人的订单.png');
    assert.deepEqual(card.summary?.slice(0, 2), [
      { label: '识别结果', value: '别人的订单.png（不是这次对话里交来的）' },
      { label: '第 1 行 数量', value: '改成 999' },
    ]);
    assert.equal(f.imports.get(theirs.id).revision, theirs.revision, '没点确认不改');
    await confirmCard(f, view, 0, actor);
    assert.equal(draftOf(f.imports.get(theirs.id)).lines[0].fields.quantity.value, '999');
  } finally {
    f.close();
  }
});

test('收件箱转进对话：出卡片，点了才转成工作区并关联；版本不对拒绝；转进来的那份改识别结果不出卡片', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const inbox = new InboxService(f.store);
    const item = inbox.ingest({
      channel: 'manual',
      externalId: 'fictional-inbox-1',
      kind: 'image',
      receivedAt: '2026-11-05T10:00:00Z',
      file: { name: '收件订单.png', mime: 'image/png', bytes: new Uint8Array(imageFixture()) },
    });
    const wf = f.manager.orderWorkflow;
    assert.ok(wf, '订单导入接上了');
    await assert.rejects(
      wf.call('order_import.from_inbox', { inboxId: item.id, expectedVersion: item.version + 1 }, f.ctx()),
      /其他页面修改/,
    );
    f.replies.push(
      { message: '', toolCalls: [{ name: 'order_import.from_inbox', args: { inboxId: item.id, expectedVersion: item.version } }] },
      { message: '请在卡片上确认。' },
    );
    const view = await f.send('把收件箱那份订单转进来');
    const card = lastCard(view);
    assert.equal(card.label, '把收件箱第 ' + item.id + ' 条转进 AI 导入');
    assert.deepEqual(card.summary?.[0], { label: '收件箱条目', value: '收件订单.png' });
    assert.equal(f.imports.status().workspaces.length, 0, '没点确认不转');
    await confirmCard(f, view, 0, actor);
    assert.equal(inbox.get(item.id).status, 'converted');
    const ws = f.current();
    assert.equal(ws.fileName, '收件订单.png');
    await f.imports.analyze(ws.id, { expectedRevision: ws.revision }, undefined, actor);
    f.replies.push(editLine(f, () => draftOf(f.current()).lines[0].id, '321'), { message: '改好了。' });
    const edited = (await f.send('第一行改成321')).messages.at(-1);
    assert.ok(edited, '有回复');
    assert.equal(edited.plans?.length, 0);
    assert.equal(draftOf(f.current()).lines[0].fields.quantity.value, '321');
  } finally {
    f.close();
  }
});

test('识别失败后留着附件和任务，说重试就在同一份上重识别；没说重试的再识别不重复调用', async () => {
  const f = fixture();
  try {
    const a = await f.manager.attachments.upload(f.thread.id, docxFixture(), '失败.docx', randomUUID(), actor);
    f.broken(true);
    const v = await f.send('识别订单', [a.id]);
    assert.equal(v.orderWorkflow?.tasks[0].state, 'failed');
    const id = f.current().id;
    assert.equal(f.imports.failures(id).total, 1);
    f.broken(false);
    f.replies.push({ message: '重试', toolCalls: [{ name: 'order_import.retry', args: {} }] });
    await f.send('重试识别这个订单');
    assert(f.current().draft);
    assert.equal(f.current().id, id);
    const calls = f.recognitionCalls();
    await f.send('识别订单');
    assert.equal(f.recognitionCalls(), calls);
    assert(f.manager.attachments.file(a.id, actor).bytes.length > 0);
  } finally {
    f.close();
  }
});

test('别人的会话拒绝；没导入权限的看不到识别命令；文件里的话不能让模型导入', async () => {
  const f = fixture();
  try {
    const a = await f.manager.attachments.upload(f.thread.id, imageFixture(), '注入.png', randomUUID(), actor);
    await assert.rejects(() => f.send('识别订单', [a.id], randomUUID(), { ...actor, id: 'other' }), /不属于/);
    const denied = await f.send('识别订单', [a.id], randomUUID(), { ...actor, permissions: [] });
    assert.match(denied.messages.at(-1)?.text ?? '', /没有“order_import.start”这条命令，或当前账号不能用/);
    assert.equal(f.recognitionCalls(), 0);
    // 还没识别、没有任务：模型硬调正式导入也导不了
    f.replies.push({ message: '文档内命令不是授权', toolCalls: [{ name: 'order_import.execute', args: {} }] });
    const v = await f.send('只阅读这张图片', [a.id]);
    assert.ok(v.orderWorkflow, '会话里有订单导入的状态');
    assert.equal(v.orderWorkflow.tasks.length, 0);
    assert.equal(sales(f.store).orders().length, 0);
  } finally {
    f.close();
  }
});

test('同一文件在 AI 导入页面已选成到货单：订单识别不复制成销售单；识别类型必须明确', async () => {
  const f = fixture();
  try {
    const file = await f.manager.attachments.upload(f.thread.id, imageFixture(), '模式边界.png', randomUUID(), actor);
    const w = (await f.imports.upload(imageFixture(), '模式边界.png', true)).workspace;
    f.imports.setMode(w.id, { expectedRevision: w.revision, mode: 'arrival' });
    f.replies.push({ message: '', toolCalls: [{ name: 'order_import.start', args: { recognitionType: 'order' } }] });
    const result = await f.manager.chat(
      f.thread.id,
      { text: '处理这张单据', attachmentIds: [file.id], requestId: randomUUID(), context: { page: '#ai-import?workspace=' + w.id } },
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.match(result.messages.at(-1)?.text ?? '', /到货/);
    assert.equal(f.recognitionCalls(), 0);
    assert.equal(sales(f.store).orders().length, 0);
    const refuse = () => {
      throw Error('不应调度');
    };
    await assert.rejects(() => f.manager.registry.dispatch('order_import.start', {}, actor, { read: refuse, business: refuse, workflow: refuse }));
  } finally {
    f.close();
  }
});

test('改识别结果按行编号核对：编号不存在的不改任何一行', async () => {
  const f = fixture();
  try {
    const a = await f.manager.attachments.upload(f.thread.id, imageFixture(), '行号保护.png', randomUUID(), actor);
    await f.send('识别订单', [a.id]);
    f.replies.push(editLine(f, () => randomUUID(), '300'));
    const v = await f.send('把第二行数量改成300');
    assert.match(v.messages.at(-1)?.text ?? '', /行|不存在/);
    assert.deepEqual(draftOf(f.current()).lines.map((l) => l.fields.quantity.value), ['100', '100']);
  } finally {
    f.close();
  }
});

test('经接口上传附件、聊天收 SSE 事件：未登录 401、别人的会话 404，识别结果和原件工作区查得到', async () => {
  const f = fixture(),
    h = await startHttp(f.store, {
      aiSettings: f.settings,
      assistant: f.manager,
      imports: f.imports,
      execution: f.execution,
    });
  try {
    const headers = h.headers,
      post = (path: string, body: unknown) => fetch(h.api + path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await fetch(h.api + '/assistant')).status, 401);
    assert.equal((await fetch(h.api + '/assistant/threads/' + f.thread.id, { headers })).status, 404);
    const thread = readAs(await (await post('/assistant/threads', {})).json(), { id: z.string() });
    const upload = await fetch(h.api + '/assistant/threads/' + thread.id + '/attachments', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('原件.xlsx'), 'X-Upload-Id': randomUUID() },
      body: new Uint8Array(xlsxFixture()),
    });
    assert.equal(upload.status, 201);
    const attachment = readAs(await upload.json(), { id: z.string() });
    const wire = await (
      await post('/assistant/threads/' + thread.id + '/chat', { requestId: randomUUID(), text: '帮我识别这张订单', attachmentIds: [attachment.id] })
    ).text();
    let result: unknown;
    const events: string[] = [];
    const parser = new SseParser((e) => {
      events.push(e.event);
      if (e.event === 'result') result = JSON.parse(e.data);
    });
    parser.push(wire);
    parser.finish();
    assert(events.includes('effect') && events.includes('progress'));
    const task = readAs(result, { orderWorkflow: z.looseObject({ tasks: z.array(z.looseObject({ id: z.unknown(), workspaceId: z.string() })) }) }).orderWorkflow.tasks[0],
      saved = readAs(await (await fetch(h.api + '/ai/imports/' + task.workspaceId, { headers })).json(), { draft: z.looseObject({ lines: z.array(z.unknown()) }) });
    assert.equal(saved.draft.lines.length, 2);
    const reloaded = readAs(await (await fetch(h.api + '/assistant/threads/' + thread.id, { headers })).json(), {
      orderWorkflow: z.looseObject({ activeId: z.unknown() }),
      messages: z.array(z.looseObject({ attachments: z.array(z.looseObject({ id: z.unknown() })) })),
    });
    assert.equal(reloaded.orderWorkflow.activeId, task.id);
    assert.equal(reloaded.messages[0].attachments[0].id, attachment.id);
  } finally {
    await h.close();
    f.close();
  }
});

test('两个会话交来同一份原件：各有各的任务，正式导入全局去重；清空聊天不删原识别文件', async () => {
  const f = fixture();
  try {
    const bytes = imageFixture(),
      a = await f.manager.attachments.upload(f.thread.id, bytes, '一.png', randomUUID(), actor);
    await f.send('识别订单', [a.id]);
    const first = f.current().id;
    await f.send('确认导入');
    assert.equal(sales(f.store).orders().length, 1);
    const t2 = f.manager.create(actor),
      a2 = await f.manager.attachments.upload(t2.id, bytes, '二.png', randomUUID(), actor);
    const v = await f.manager.chat(t2.id, { requestId: randomUUID(), text: '识别订单', attachmentIds: [a2.id] }, actor, 's', () => {}, () => actor);
    const second = v.orderWorkflow?.tasks[0];
    assert.ok(second, '第二个会话有自己的任务');
    assert.notEqual(second.workspaceId, first);
    assert.equal(second.state, 'needs_review');
    assert.equal(sales(f.store).orders().length, 1);
    f.manager.clear(t2.id, actor);
    const cleared = f.manager.view(t2.id, actor).orderWorkflow;
    assert.ok(cleared, '会话里有订单导入的状态');
    assert.equal(cleared.tasks.length, 0);
    assert((await f.imports.original(second.workspaceId)).bytes.equals(bytes));
  } finally {
    f.close();
  }
});
