// 助手看页面（page.observe）的桥接：命令绑在这一轮的账号、登录会话、浏览器和请求上，页面回执对上才算完成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssistantPageBridge } from '../server/assistant/page-bridge.js';
import { actor, flowFixture, readAs } from './assistant-fixture.js';
import { startHttp } from './http-fixture.js';

test('页面回执要对上账号、登录会话、浏览器才收；收过的、停止以后的迟到回执都拒绝；没连着页面直接说看不到', async () => {
  const bridge = new AssistantPageBridge(),
    clientId = randomUUID(),
    threadId = randomUUID(),
    requestId = randomUUID(),
    controller = new AbortController();
  let command: unknown;
  const ctx = { actor, binding: '真实会话', clientId, threadId, requestId, check: () => actor, signal: controller.signal, emit: (_: string, data: unknown) => (command = data) };
  const call = bridge.observe({}, ctx);
  const snapshot = { route: '#orders', capturedAt: new Date().toISOString(), title: '客户订单', text: '虚构订单', selected: [], dialogs: [], tables: [], feedback: [], truncated: false };
  const { commandId } = readAs(command, { commandId: z.string() });
  const reply = { commandId, clientId, threadId, requestId, result: { ok: true, message: '已读取', snapshot } };
  assert.throws(() => bridge.complete(reply, { ...actor, id: '其他账号' }, ctx.binding), /真实登录会话/);
  assert.throws(() => bridge.complete(reply, actor, '另一登录会话'), /真实登录会话/);
  assert.throws(() => bridge.complete({ ...reply, clientId: randomUUID() }, actor, ctx.binding), /真实登录会话/);
  bridge.complete(reply, actor, ctx.binding);
  assert.equal((await call).snapshot?.title, '客户订单');
  assert.throws(() => bridge.complete(reply, actor, ctx.binding), /失效/);
  const pending = bridge.observe({}, ctx);
  controller.abort();
  await assert.rejects(() => pending, /已停止/);
  await assert.rejects(() => bridge.observe({}, { ...ctx, clientId: undefined, signal: new AbortController().signal }), /没有连着 ERP 页面/);
});

test('经接口交回的页面回执格式不对时 400', async () => {
  const f = flowFixture(),
    h = await startHttp(f.store, { assistant: f.manager, aiSettings: f.settings });
  try {
    assert.equal((await h.send('/assistant/page/results', { commandId: randomUUID() }, h.cookie)).status, 400);
  } finally {
    await h.close();
    f.close();
  }
});
