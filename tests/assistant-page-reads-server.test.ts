// 助手页面按结构认服务端发来的数据（src/assistant/chat-events.ts 的回复事件、assistant-api.ts 的上传和语音回答、
// shared/assistant 的导出文件结构）：喂的都是内存里的助手服务真实产生的（模型用替身），经 JSON 来回一次，和浏览器收到的一样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { exportFileSchema } from '../shared/assistant/index.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { transcribePcm } from '../server/assistant/speech/service.js';
import { routeChatEvent, type ChatEventHandlers } from '../src/assistant/chat-stream.js';
import { readExportFile } from '../src/assistant/chat-events.js';
import { chatAttachmentSchema, speechReplySchema } from '../src/assistant/assistant-api.js';
import { readEventStream } from '../src/ui/event-stream.js';
import { actor, assistantFixture, confirmCard, flowFixture } from './assistant-fixture.js';
import { createOrderWorkflowFixture, importer } from './assistant-workflow-fixture.js';
import { setup } from './document-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { startHttp } from './http-fixture.js';
import { replyNative } from './fake-deepseek.js';

/** 服务端推给页面的样子：经 JSON 来回（值是 undefined 的键丢掉），和页面从事件流读到的一样 */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const call = (name: string, args: Record<string, unknown>, message = '') => ({ message, toolCalls: [{ name, args }] });

/** 把一轮里服务端发的事件全交给页面的分派（routeChatEvent），记下每个处理收到了什么；认不出会抛错 */
function routeAll(events: readonly (readonly [string, unknown])[]) {
  const got: Record<string, unknown[]> = {};
  const keep =
    (name: string) =>
    (...args: unknown[]) => {
      (got[name] ??= []).push(args.length > 1 ? args : args[0]);
    };
  const on: ChatEventHandlers = {
    pageCommand: keep('pageCommand'),
    effect: keep('effect'),
    speaker: keep('speaker'),
    draft: keep('draft'),
    said: keep('said'),
    reasoning: keep('reasoning'),
    modelProgress: keep('modelProgress'),
    progress: keep('progress'),
    result: keep('result'),
    error: keep('error'),
  };
  for (const [event, data] of events) routeChatEvent(event, wire(data), on);
  return got;
}
const effectTypes = (got: Record<string, unknown[]>) =>
  (got.effect ?? []).map((e) => z.looseObject({ type: z.string().optional() }).parse(e).type);

test('页面认得服务端发的说话人、先说的话、正文、思考、进度和命令进度', async () => {
  const f = assistantFixture([
    { speaker: 'le', ...call('records.search', { module: 'products', filters: { q: '虚构' } }, '我先查一下虚构纸箱。') },
    replyNative({ reasoning: '虚构的思考内容', content: '【小勒】查好了。' }),
  ]);
  try {
    await f.say(f.manager.create(actor).id, '查一下虚构纸箱');
    const got = routeAll(f.events);
    assert.deepEqual([...new Set(got.speaker)], ['le'], '每一轮先告诉页面是谁在说');
    assert.ok(got.said?.length && got.draft?.length && got.progress?.length && got.modelProgress?.length);
    assert.ok(got.reasoning?.length, '思考内容交给了思考那一块');
  } finally {
    f.close();
  }
});

test('页面认得服务端发的“业务变了、刷新”和“打开页面”两种效果', async () => {
  const f = flowFixture();
  try {
    const customer = f.store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
      product = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
    const order = f.store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-25',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: [{ productId: product.id, productName: product.name, quantity: 100, unit: '只', unitPriceCents: 100 }],
      }),
    );
    f.replies.push(call('records.propose_save', { module: 'orders', id: order.id, patch: { deliveryDate: '2027-01-02' } }), call('ui.open', { module: 'orders' }));
    await f.say(f.manager.create(actor).id, '把这张订单交期改成2027-01-02，再打开订单页');
    assert.deepEqual(effectTypes(routeAll(f.events)), ['business', 'navigate']);
  } finally {
    f.close();
  }
});

test('页面认得识别订单时服务端发的“跳到识别任务”效果', async () => {
  const f = createOrderWorkflowFixture(undefined, { agent: { autoConfirm: true } });
  try {
    const attachment = await f.manager.attachments.upload(f.thread.id, imageFixture(), '客户采购订单.png', randomUUID(), importer);
    await f.send('帮我识别这张客户采购订单', [attachment.id]);
    assert.ok(effectTypes(routeAll(f.events.map((e) => [e.event, e.data] as const))).includes('navigate'));
  } finally {
    f.close();
  }
});

test('导出单据：直接导出的下载效果、消息里的导出文件、导出卡片执行结果里的文件，页面都按同一份结构认得', async () => {
  const a = assistantFixture(),
    f = setup(a.store);
  try {
    const t = a.manager.create(actor);
    a.replies.push(call('documents.export', f.exp('purchase', f.purchase.id, { markOrdered: false })), { message: '文件已导出。', toolCalls: [] });
    const events: [string, unknown][] = [];
    const view = await a.manager.chat(t.id, a.input('把这张采购单导出来', randomUUID()), actor, 'test', (event, data) => {
      events.push([event, data]);
      const file = z.looseObject({ type: z.string().optional(), file: exportFileSchema.optional() }).parse(data).file;
      if (event === 'effect' && file) {
        f.docs.delivered(file.exportId, actor);
        f.docs.complete(file.exportId, file.sha256, actor);
      }
    }, () => actor);
    assert.deepEqual(effectTypes(routeAll(events)), ['download']);
    const exported = view.messages.at(-1)?.exports ?? [];
    assert.equal(exported.length, 1);
    assert.ok(exportFileSchema.safeParse(wire(exported[0])).success, '消息里的导出文件');
    a.replies.push(call('documents.export', f.exp('purchase', f.purchase.id)), { message: '请确认。', toolCalls: [] });
    const carded = await a.manager.chat(t.id, a.input('导出并标记已订货', randomUUID()), actor, 'test', () => {}, () => actor);
    const done = z.looseObject({ file: z.unknown() }).parse(await confirmCard(a, carded, 0, actor, 'test'));
    assert.equal(readExportFile(wire(done.file)).markOrdered, true, '卡片执行结果里的文件');
  } finally {
    a.close();
  }
});

test('服务端说这一轮失败（error 事件）：页面读事件流时交给出错那一块，再按服务端的说法报错', async () => {
  const f = assistantFixture(),
    h = await startHttp(f.store, { aiSettings: f.settings, assistant: f.manager });
  try {
    const t = z.object({ id: z.string() }).parse(await (await h.send('/assistant/threads', {}, h.cookie)).json());
    // 正文缺 requestId：服务端拒收，事件流以 error 结束
    const response = await h.send('/assistant/threads/' + t.id + '/chat', { text: '虚构问题' }, h.cookie);
    const events: [string, unknown][] = [];
    await assert.rejects(readEventStream(response, (event, data) => events.push([event, data]), '虚构的中断说明'));
    const got = routeAll(events);
    assert.equal(got.error?.length, 1);
    assert.equal(typeof got.error?.[0], 'string');
  } finally {
    await h.close();
    f.close();
  }
});

test('上传附件的回答、语音识别的回答：页面按结构认得服务端交回的', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    const saved = await f.manager.attachments.upload(t.id, imageFixture(), '虚构订单.png', randomUUID(), actor);
    assert.equal(chatAttachmentSchema.parse(wire(saved)).id, saved.id);
    const speech = await transcribePcm({ speechToText: async () => ({ text: ' 虚构的话 ', durationMs: 500 }) }, Buffer.alloc(16000), actor.id);
    assert.equal(speechReplySchema.parse(wire(speech)).text, '虚构的话');
  } finally {
    f.close();
  }
});
