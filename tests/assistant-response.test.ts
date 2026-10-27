import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { makeSettings, actor } from './assistant-fixture.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { AssistantManager, assistantDefaultPreset } from '../server/assistant/manager.js';
import { normalizeAssistantReply } from '../server/assistant/reply.js';
import { productSchema } from '../shared/domain.js';
type Handler = (req: any) => any;
const assistantText = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});
const respond =
  (text: string): Handler =>
  () => ({
    status: 200,
    body: { status: 'completed', output: [assistantText(text)] },
  });
const streamResponses =
  (parts: string[], terminal: 'completed' | 'incomplete'): Handler =>
  (req) => {
    for (const part of parts)
      req.onSseEvent?.({
        event: 'response.output_text.delta',
        data: JSON.stringify({ type: 'response.output_text.delta', delta: part }),
      });
    if (terminal === 'completed')
      req.onSseEvent?.({
        event: 'response.completed',
        data: JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', output: [assistantText(parts.join(''))] },
        }),
      });
    else
      req.onSseEvent?.({
        event: 'response.incomplete',
        data: JSON.stringify({ type: 'response.incomplete' }),
      });
    return { status: 200, body: null, streamed: true };
  };
const chatBody =
  (content: string): Handler =>
  () => ({
    status: 200,
    body: { choices: [{ finish_reason: 'stop', message: { content } }] },
  });
const chatTruncated =
  (content: string): Handler =>
  (req) => {
    req.onSseEvent?.({
      event: 'message',
      data: JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }),
    });
    req.onSseEvent?.({
      event: 'message',
      data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    });
    return { status: 200, body: null, streamed: true };
  };
function fixture(
  handlers: Handler[],
  apiStyle: 'responses' | 'chat-completions' = 'responses',
  setup?: (store: Store) => void,
) {
  const requests: any[] = [];
  let index = 0;
  const settings = makeSettings(async (req) => {
    requests.push(req);
    return handlers[Math.min(index++, handlers.length - 1)](req);
  }, apiStyle);
  const store = new Store(':memory:');
  setup?.(store);
  const prompts = new PromptPresetManager(':memory:', assistantDefaultPreset);
  const manager = new AssistantManager(store, settings, prompts);
  return {
    store,
    settings,
    manager,
    requests,
    chat: (thread: any, text: string) =>
      manager.chat(
        thread.id,
        { requestId: randomUUID(), text, consent: true, profile: settings.view().active },
        actor,
        's',
        () => {},
        () => actor,
      ),
    close() {
      store.close();
      settings.close();
      prompts.close();
    },
  };
}
const auditCount = (store: Store) =>
  Number(store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n);

test('普通聊天：缺少 toolCalls 的文字回复正常展示，不调用工具、不写业务', async () => {
  const f = fixture([
    respond(JSON.stringify({ message: '这个错误通常是因为到货批次和库存数量单位不一致。' })),
  ]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '为什么这里会出现这个错误？');
    const last = r.messages.at(-1)!;
    assert.equal(last.role, 'assistant');
    assert.match(last.text, /单位不一致/);
    assert.deepEqual(last.events, []);
    assert.deepEqual(last.plans, []);
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('额外字段与别名字段按纯文字处理，诊断只记录键名不落原文', async () => {
  const businessValue = '虚构客户甲的内部备注不应出现在诊断日志';
  const f = fixture([
    respond(
      JSON.stringify({
        answer: '这里的数据来自采购到货批次。',
        reasoning: businessValue,
        suggestions: ['继续查看'],
      }),
    ),
  ]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '解释一下这条数据');
    const last = r.messages.at(-1)!;
    assert.match(last.text, /采购到货批次/);
    assert.deepEqual(last.events, []);
    const rows = f.store.db
      .prepare("SELECT document d FROM assistant_audit WHERE tool='assistant.reply'")
      .all();
    assert(rows.some((row) => String(row.d).includes('"answer"')));
    assert(!rows.some((row) => String(row.d).includes(businessValue)));
  } finally {
    f.close();
  }
});

test('纯文本非 JSON 回复安全降级展示，不执行任何操作', async () => {
  const f = fixture([respond('这是一段普通文字回答，不是 JSON 对象。')]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '解释一下这个错误');
    const last = r.messages.at(-1)!;
    assert.match(last.text, /普通文字回答/);
    assert.match(last.text, /未完整结束或格式异常/);
    assert.equal(last.degraded, 'invalid-json');
    assert.equal(last.error, undefined);
    assert.deepEqual(last.plans, []);
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('降级展示不会把自然语言里的 JSON 示例误当信封而丢失原文', async () => {
  const content = '你可以先检查这段数据：{"orderId": 1, "quantity": 10}，再核对单位。';
  const f = fixture([respond(content)]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '这段数据正常吗？');
    const last = r.messages.at(-1)!;
    assert.match(last.text, /orderId/);
    assert.match(last.text, /再核对单位/);
    assert.equal(last.replyMode, 'text');
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('流式响应未完成时保留已接收文字并标注，不写入业务', async () => {
  const f = fixture([
    streamResponses(['出现这个错误是因为', '上一批到货的纸板还没有确认入库。'], 'incomplete'),
  ]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '为什么报错？');
    const last = r.messages.at(-1)!;
    assert.match(last.text, /上一批到货/);
    assert.match(last.text, /未完整结束或格式异常/);
    assert.equal(last.degraded, 'incomplete');
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('未知工具名被拒绝执行，不产生方案或业务写入', async () => {
  const f = fixture([
    respond(
      JSON.stringify({
        message: '我先删除这条订单。',
        toolCalls: [{ name: 'execute_sql', args: { sql: 'DELETE FROM orders' } }],
      }),
    ),
  ]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '删除订单');
    const last = r.messages.at(-1)!;
    assert.deepEqual(last.plans, []);
    assert(last.events.some((e: any) => e.state === '未执行' && /未注册/.test(e.message)));
    assert.match(last.text, /未执行成功/);
    assert.deepEqual(f.store.products(), []);
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('已注册工具的参数不是对象时拒绝执行', async () => {
  const f = fixture([
    respond(
      JSON.stringify({ message: '查询', toolCalls: [{ name: 'records.search', args: 'bad' }] }),
    ),
  ]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '查客户');
    const last = r.messages.at(-1)!;
    assert.deepEqual(last.plans, []);
    assert(last.events.some((e: any) => e.state === '未执行' && /参数不是对象/.test(e.message)));
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('已注册工具参数非法时由工具校验拒绝，不进入业务准备', async () => {
  const f = fixture([
    respond(
      JSON.stringify({
        message: '查询',
        toolCalls: [{ name: 'records.search', args: { module: 'not-a-module' } }],
      }),
    ),
  ]);
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '查客户');
    const last = r.messages.at(-1)!;
    assert.deepEqual(last.plans, []);
    assert(
      last.events.some((e: any) => e.state === '未执行' && /字段不完整|不合法/.test(e.message)),
    );
    assert.equal(auditCount(f.store), 0);
  } finally {
    f.close();
  }
});

test('合法查询与待审核修改继续走原有工具和人工确认链路', async () => {
  let productId = 0;
  const f = fixture(
    [
      respond(
        JSON.stringify({
          message: '正在查询产品。',
          toolCalls: [
            { name: 'records.search', args: { module: 'products', filters: { q: '虚构' } } },
          ],
        }),
      ),
      respond(JSON.stringify({ message: '找到虚构纸箱A。' })),
      () => ({
        status: 200,
        body: {
          status: 'completed',
          output: [
            assistantText(
              JSON.stringify({
                message: '准备修改备注方案。',
                toolCalls: [
                  {
                    name: 'records.propose_save',
                    args: {
                      module: 'products',
                      id: productId,
                      patch: { requirements: '人工确认后更新' },
                      previewOnly: true,
                    },
                  },
                ],
              }),
            ),
          ],
        },
      }),
    ],
    'responses',
    (store) => {
      productId = store.saveProduct(productSchema.parse({ name: '虚构纸箱A' })).id;
    },
  );
  try {
    const t = f.manager.create(actor);
    const query = await f.chat(t, '查找虚构产品');
    const queryLast = query.messages.at(-1)!;
    assert.match(queryLast.text, /找到虚构纸箱A/);
    assert(queryLast.events.some((e: any) => e.state === '已查询实时数据'));
    assert(queryLast.links.length > 0);
    assert.equal(auditCount(f.store), 0);

    const proposal = await f.chat(t, '修改这个产品的加工要求，先生成预览方案');
    const plan = proposal.messages.at(-1)!.plans[0];
    assert(
      plan,
      JSON.stringify(
        proposal.messages.map((m: any) => ({
          role: m.role,
          text: m.text,
          plans: m.plans?.length,
          events: m.events,
        })),
      ),
    );
    assert.equal(f.store.product(productId)!.requirements, '');
    assert.equal(auditCount(f.store), 0);
    f.manager.execute(plan.id, { acknowledged: true }, actor, 's');
    assert.equal(f.store.product(productId)!.requirements, '人工确认后更新');
    assert.equal(f.store.products().length, 1);
  } finally {
    f.close();
  }
});

test('历史 assistant 消息以信封 JSON 回放，后续轮次仍要求结构化回复', async () => {
  const f = fixture([
    respond(JSON.stringify({ message: '第一次回答' })),
    respond(JSON.stringify({ message: '第二次回答' })),
  ]);
  try {
    const t = f.manager.create(actor);
    await f.chat(t, '第一个问题');
    await f.chat(t, '第二个问题');
    const input = f.requests[1].body.input as any[];
    assert(String(input[0].content).includes('历史 assistant 条目'));
    assert(String(input[0].content).includes('只输出JSON'));
    const history = input.filter((m: any) => m.role === 'assistant');
    assert(history.some((m: any) => String(m.content).includes('"toolCalls":[]')));
    assert(history.some((m: any) => String(m.content).includes('第一次回答')));
  } finally {
    f.close();
  }
});

test('聊天补全协议下的纯文本回复同样安全降级，不出现订单专用提示', async () => {
  const f = fixture([chatBody('这是聊天补全返回的普通说明。')], 'chat-completions');
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '解释一下');
    const last = r.messages.at(-1)!;
    assert.match(last.text, /普通说明/);
    assert(!/订单|草稿/.test(last.text));
    assert.equal(last.degraded, 'invalid-json');
  } finally {
    f.close();
  }
});

test('聊天补全流截断时保留已接收文字并标注未完整', async () => {
  const f = fixture([chatTruncated('部分聊天补全回答')], 'chat-completions');
  try {
    const t = f.manager.create(actor);
    const r = await f.chat(t, '请解释');
    const last = r.messages.at(-1)!;
    assert.match(last.text, /部分聊天补全回答/);
    assert.match(last.text, /未完整结束或格式异常/);
    assert.equal(last.degraded, 'truncated');
  } finally {
    f.close();
  }
});

test('回复归一化：纯文字、别名、额外字段、空值与超限都安全处理', () => {
  const plain = normalizeAssistantReply({ message: '你好' });
  assert.equal(plain.message, '你好');
  assert.equal(plain.mode, 'text');
  assert.deepEqual(plain.toolCalls, []);
  const text = normalizeAssistantReply('纯文本');
  assert.equal(text.mode, 'text');
  assert.equal(text.message, '纯文本');
  const fenced = normalizeAssistantReply('```json\n{"message":"围栏内"}\n```');
  assert.equal(fenced.message, '围栏内');
  const alias = normalizeAssistantReply({ answer: '别名' });
  assert.equal(alias.message, '别名');
  const extra = normalizeAssistantReply({ message: 'hi', extra: 1 });
  assert.equal(extra.message, 'hi');
  assert.equal(extra.mode, 'text');
  const empty = normalizeAssistantReply({});
  assert.equal(empty.mode, 'empty');
  assert.equal(normalizeAssistantReply([]).mode, 'empty');
  assert.equal(normalizeAssistantReply(null).mode, 'empty');
  assert.equal(normalizeAssistantReply(42).mode, 'empty');
  const long = normalizeAssistantReply({ message: 'x'.repeat(20000) });
  assert.equal(long.message.length, 16000);
  assert(long.issues.some((i) => i.includes('截断')));
  const unknown = normalizeAssistantReply({
    message: 'x',
    toolCalls: [{ name: 'execute_sql', args: {} }],
  });
  assert.equal(unknown.toolCalls.length, 0);
  assert.equal(unknown.rejected.length, 1);
  const badArgs = normalizeAssistantReply({
    message: 'x',
    toolCalls: [{ name: 'records.search', args: 'bad' }],
  });
  assert.equal(badArgs.rejected.length, 1);
  const tooMany = normalizeAssistantReply({
    message: 'x',
    toolCalls: [1, 2, 3, 4].map(() => ({ name: 'records.search', args: {} })),
  });
  assert.equal(tooMany.toolCalls.length, 3);
  assert.equal(tooMany.rejected.length, 1);
  const objectMessage = normalizeAssistantReply({ message: { a: 1 } });
  assert.equal(objectMessage.message, '{"a":1}');
});
