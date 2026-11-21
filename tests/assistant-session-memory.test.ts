// 助手的会话内上下文：历史原样回放、前缀逐字节不变、太长时压成摘要、
// 单个工具结果截到上限、卡片后来怎么样了、长期记忆的位置。用假 DeepSeek 记下每次请求，断言请求里带着什么；只用内存库和虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { estimateTokens } from '../server/assistant/chat/session-limits.js';
import { capToolResult, pageHint } from '../server/assistant/chat/tool-result-cap.js';
import { LONG_TERM_HEAD } from '../server/assistant/chat/long-term-memory.js';
import type { AgentOptions } from '../server/assistant/chat/agent-config.js';
import { customerSchema } from '../shared/core/index.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { assistantFixture } from './assistant-fixture.js';
import { messageText } from './fake-deepseek.js';
import type { ChatBody, WireMessage } from './fake-deepseek-wire.js';
import { actor } from './actor-fixture.js';
import { readAs } from './read-result.js';

const call = (name: string, args: unknown) => ({ message: '', toolCalls: [{ name, args }] });
const answer = (message: string) => ({ message, toolCalls: [] });

function setup(replies: unknown[], agent: AgentOptions = {}) {
  const bodies: ChatBody[] = [];
  const f = assistantFixture([], {
    agent,
    chat: (body) => {
      bodies.push(structuredClone(body));
      return replies.shift() ?? answer('好的。');
    },
  });
  const thread = f.manager.create(actor) as { id: string };
  return { store: f.store, manager: f.manager, thread, bodies, say: (text: string, extra: Record<string, unknown> = {}) => f.say(thread.id, text, extra), close: f.close };
}
/** 每次请求末尾那条任务状态是临时接上的，去掉它就是这次请求的“前缀” */
const prefixOf = (body: ChatBody) => body.messages.slice(0, -1);
/** 最后一次请求的消息 */
function lastMessages(bodies: ChatBody[]) {
  const last = bodies.at(-1);
  assert.ok(last, '没有发过请求');
  return last.messages;
}
/** 内容是文字、并以这句开头的消息 */
const startsWith = (m: WireMessage, head: string) => typeof m.content === 'string' && m.content.startsWith(head);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

test('隔了几轮问“刚才那个再看看”：第一轮查到的编号和内容原样在请求里；每次请求的前缀都是上一次的原样延续', async () => {
  const f = setup([
    call('records.get', { module: 'customers', id: 1 }),
    answer('查到了，客户编号 1 是虚构客户甲。'),
    answer('你好。'),
    answer('今天是工作日。'),
    answer('还是虚构客户甲，电话没填。'),
  ]);
  try {
    f.store.saveCustomer(customerSchema.parse({ name: '虚构客户甲' }));
    await f.say('看一下客户编号1');
    await f.say('你好');
    await f.say('今天忙不忙');
    await f.say('刚才那个客户再看看');
    const messages = lastMessages(f.bodies);
    const asked = messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    const askedCall = asked?.tool_calls?.[0];
    assert.ok(asked && askedCall, '请求里没有调命令的那条助手消息');
    assert.equal(askedCall.function?.name, 'records__get');
    assert.ok(asked.reasoning_content !== undefined, '思考内容原样回传');
    const result = messages.find((m) => m.role === 'tool' && m.tool_call_id === askedCall.id);
    assert.match(messageText(result), /虚构客户甲/);
    assert.match(messageText(result), /"id":1/);
    // 第一次请求以后，每次请求去掉末尾任务状态，都是下一次请求的开头（逐字节相同）：能命中上下文缓存
    for (let i = 0; i + 1 < f.bodies.length; i++) {
      const before = prefixOf(f.bodies[i]);
      assert.ok(same(f.bodies[i + 1].messages.slice(0, before.length), before), `第 ${i + 1} 次和第 ${i + 2} 次请求的前缀不一致`);
      assert.ok(same(f.bodies[i + 1].tools, f.bodies[0].tools), '工具清单每次一样');
    }
    // 页面上看不到存下来的原样记录
    const view = f.manager.view(f.thread.id, actor);
    assert.ok(view.messages.every((m) => field(m, 'turn') === undefined));
  } finally {
    f.close();
  }
});

test('单个工具结果超过上限：截最长的列表，写明给了几条、共几条、怎么翻页；没有列表的截文字', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, name: '虚构记录' + (i + 1), notes: '虚构备注' }));
  const hint = pageHint({ type: 'object', properties: { offset: { type: 'integer' } } });
  const capped = capToolResult({ total: 3000, results: rows }, hint, 2000);
  assert.ok(estimateTokens(JSON.stringify(capped)) <= 2000);
  const { results } = readAs(capped, { results: z.array(z.unknown()) });
  const note = results.at(-1);
  assert.ok(typeof note === 'string', '列表末尾是一句说明');
  assert.match(note, /共 3000 条/);
  assert.match(note, /offset/);
  assert.equal(field(results[0], 'id'), 1);
  const text = capToolResult({ 正文: '虚构'.repeat(20000) }, pageHint({}), 1000);
  assert.ok(estimateTokens(JSON.stringify(text)) <= 1000);
  assert.match(readAs(text, { 说明: z.string() }).说明, /只给出前面一部分/);
  assert.deepEqual(capToolResult({ ok: true }, hint), { ok: true }, '没超的原样');
});

test('卡片后来怎么样了：上一轮出的卡片过期了，下一轮的上下文里写明', async () => {
  const f = setup([call('records.propose_save', { module: 'customers', patch: { name: '虚构预览客户' } })]);
  try {
    await f.say('只预览：新建客户 虚构预览客户');
    f.store.db.prepare('UPDATE assistant_previews SET expires_at=1').run();
    await f.say('刚才那张卡片呢');
    const context = lastMessages(f.bodies).findLast((m) => m.role === 'user' && startsWith(m, '服务器当前上下文'));
    assert.match(messageText(context), /"cards":\[\{"previewId":"[^"]+","label":"[^"]*","state":"过期了，没有执行"\}\]/);
  } finally {
    f.close();
  }
});

test('长期记忆在固定的系统提示词和日期之后、会话历史之前，开头写明是数据和偏好', async () => {
  const f = setup([answer('第一句。'), answer('第二句。')]);
  try {
    f.manager.registry.memory.add(actor.id, '虚构偏好：回答简短', 'manual');
    await f.say('你好');
    await f.say('再来');
    const messages = lastMessages(f.bodies);
    const roles = messages.map((m) => (m.role === 'system' ? messageText(m).slice(0, 8) : m.role));
    const memory = messages.findIndex((m) => m.role === 'system' && startsWith(m, LONG_TERM_HEAD));
    const date = messages.findIndex((m) => m.role === 'system' && startsWith(m, '当前日期'));
    const firstUser = messages.findIndex((m) => m.role === 'user');
    assert.ok(date > 0 && memory === date + 1 && firstUser === memory + 1, JSON.stringify(roles));
  } finally {
    f.close();
  }
});
