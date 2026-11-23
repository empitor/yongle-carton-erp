// 原生工具调用的对话（server/ai/chat-tools.ts）直接拿假传输函数测，不经过设置管理器、不起整个系统
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDeepSeek, fakeKey, nativeRequestError, replyNative } from '../support/fake-deepseek.js';
import { completeChatForm, completeChatTools, toolChatBody, type ChatTool, type ToolChatMessage } from '../../server/ai/chat-tools.js';
import { AiConnectionError } from '../../server/ai/errors.js';
import type { AiTransport } from '../../server/ai/transport.js';
import type { ChatBody } from '../support/fake-deepseek-wire.js';
import type { ProviderTokenUsage } from '../../server/ai/usage.js';

const tools: ChatTool[] = [
  { type: 'function', function: { name: 'records__search', description: '虚构查询', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'ask_user', description: '问用户', parameters: { type: 'object', properties: {} } } },
];
const user: ToolChatMessage[] = [{ role: 'user', content: '虚构问题' }];
/** 按给定的块回一条 SSE 流；每块是 choices[0] 的 delta，最后一块带 finish 和 usage */
const sse = (deltas: unknown[], finish: string | null, usage?: unknown): AiTransport => async () =>
  new Response(
    [
      ...deltas.map((delta) => 'data: ' + JSON.stringify({ id: 'chatcmpl-x', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n'),
      ...(finish ? ['data: ' + JSON.stringify({ id: 'chatcmpl-x', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + '\n\n', 'data: [DONE]\n\n'] : []),
    ].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const rejects = async (run: () => Promise<unknown>, pattern: RegExp, code?: string) => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AiConnectionError, String(error));
    assert.match(error.message, pattern);
    if (code) assert.equal(error.code, code);
    return true;
  });
};

test('思考档位映射成请求字段：关 → thinking disabled；低/高/最高 → enabled + reasoning_effort；默认高', () => {
  assert.deepEqual(toolChatBody(user, tools, { thinking: 'off' }).thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in toolChatBody(user, tools, { thinking: 'off' }), false);
  for (const level of ['low', 'high', 'max'] as const) {
    const body = toolChatBody(user, tools, { thinking: level });
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal('reasoning_effort' in body ? body.reasoning_effort : undefined, level);
  }
  const body = toolChatBody(user, tools);
  assert.equal('reasoning_effort' in body ? body.reasoning_effort : undefined, 'high');
  assert.equal('tool_choice' in body ? body.tool_choice : undefined, 'auto');
  assert.equal('max_tokens' in body, false);
  assert.equal(toolChatBody(user, tools, { maxOutputTokens: 10_000_000 }).max_tokens, 393_216);
  const noToolsChoice = toolChatBody(user, tools, { toolChoice: 'none' });
  assert.equal('tool_choice' in noToolsChoice ? noToolsChoice.tool_choice : undefined, 'none');
  assert.equal('tool_choice' in toolChatBody(user, []), false, '没有工具就不带 tool_choice');
  assert.deepEqual(body.stream_options, { include_usage: true });
  // 工具名不合官方规则、重名：请求前就拦
  const bad = (name: string) => [{ ...tools[0], function: { ...tools[0].function, name } }];
  assert.throws(() => toolChatBody(user, bad('records.search')), /不合 DeepSeek 的规则/);
  assert.throws(() => toolChatBody(user, bad('x'.repeat(129))), /不合 DeepSeek 的规则/);
  assert.throws(() => toolChatBody(user, [tools[0], tools[0]]), /重复/);
});


// 填表请求的模型、思考、tool_choice、流式见 deepseek-client.test.ts 第一条
test('识别的填表：用户元信息标记（latest_reminder）原样发出去', async () => {
  const fake = fakeDeepSeek({ chat: () => ({ ok: true }) });
  const form = { name: 'fill', description: '虚构的表', parameters: { type: 'object', properties: {} } };
  await completeChatForm(fakeKey, [{ role: 'latest_reminder', content: '2026-11-13,星期五,,Web,中文' }, { role: 'user', content: '虚构' }], form, fake.transport);
  const call = fake.chatCalls()[0];
  assert.ok(call);
  assert.equal(call.body.messages[0].role, 'latest_reminder');
});

test('流式拼接：思考分片、正文分片、两个并行工具调用的参数交错到达；用量单独报思考 token', async () => {
  const transport = sse(
    [
      { role: 'assistant', content: '' },
      { reasoning_content: '先查' },
      { reasoning_content: '订单，' },
      { reasoning_content: '再问用户。' },
      { content: '【小甬】\n我' },
      { content: '先查一下。' },
      { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'records__search', arguments: '{"q":' } }] },
      { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'ask_user', arguments: '{"questions"' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"虚构订单"}' } }] },
      { tool_calls: [{ index: 1, function: { arguments: ':[]}' } }] },
    ],
    'tool_calls',
    { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_cache_hit_tokens: 60, completion_tokens_details: { reasoning_tokens: 12 } },
  );
  const reasoningParts: string[] = [],
    textParts: string[] = [],
    stages: string[] = [];
  let usage: ProviderTokenUsage | undefined, lastReasoningChars = 0;
  const result = await completeChatTools(fakeKey, user, tools, transport, {
    onReasoningDelta: (t) => reasoningParts.push(t),
    onTextDelta: (t) => textParts.push(t),
    onUsage: (u) => (usage = u),
    onProgress: (p) => {
      stages.push(p.stage);
      if (p.reasoningChars) lastReasoningChars = p.reasoningChars;
    },
  });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.reasoning, '先查订单，再问用户。');
  assert.equal(reasoningParts.join(''), result.reasoning);
  assert.equal(result.content, '【小甬】\n我先查一下。');
  assert.equal(textParts.join(''), result.content);
  assert.deepEqual(result.toolCalls, [
    { id: 'call_a', type: 'function', function: { name: 'records__search', arguments: '{"q":"虚构订单"}' } },
    { id: 'call_b', type: 'function', function: { name: 'ask_user', arguments: '{"questions":[]}' } },
  ]);
  assert.deepEqual(result.assistantMessage, {
    role: 'assistant',
    content: result.content,
    reasoning_content: result.reasoning,
    tool_calls: result.toolCalls,
  });
  assert.ok(usage);
  assert.equal(usage.reasoningTokens, 12);
  assert.equal(usage.cachedInputTokens, 60);
  assert.ok(stages.includes('thinking') && stages.indexOf('thinking') < stages.indexOf('receiving'));
  assert.equal(lastReasoningChars, result.reasoning.length);
});

test('整包回复（不流式）和只有工具调用、没有正文的回复', async () => {
  const fake = fakeDeepSeek({ chat: () => replyNative({ reasoning: '虚构思考', toolCalls: [{ name: 'records__search', arguments: { q: 1 } }] }) });
  const result = await completeChatTools(fakeKey, user, tools, fake.transport, { stream: false });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.assistantMessage.content, null);
  assert.equal(result.assistantMessage.reasoning_content, '虚构思考');
  const firstCall = result.toolCalls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.function.arguments, '{"q":1}');
});

// 截断、断流、不带工具的对话收到工具调用，和填表走同一段代码，见 deepseek-client.test.ts
test('报错映射：说调工具却没给、工具调用不完整、参数和思考里出现密钥、思考内容没回传', async () => {
  await rejects(() => completeChatTools(fakeKey, user, tools, sse([{ content: '虚构' }], 'tool_calls')), /却没有给出工具调用/, 'response');
  await rejects(
    () => completeChatTools(fakeKey, user, tools, sse([{ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }], 'tool_calls')),
    /工具调用不完整/,
  );
  await rejects(
    () =>
      completeChatTools(
        fakeKey,
        user,
        tools,
        sse([{ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'records__search', arguments: JSON.stringify({ k: fakeKey }) } }] }], 'tool_calls'),
      ),
    /不安全/,
  );
  await rejects(() => completeChatTools(fakeKey, user, tools, sse([{ reasoning_content: '想到 ' + fakeKey }], 'stop')), /不安全/);
  // 官方对没回传思考内容回 400：给人看的话说清楚是程序问题
  const fake = fakeDeepSeek();
  const history: ToolChatMessage[] = [
    ...user,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'records__search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true}' },
  ];
  await rejects(() => completeChatTools(fakeKey, history, tools, fake.transport), /思考内容没有按 DeepSeek 的规定回传/, 'validation');
});

test('多轮：把助手消息原样追加、每个调用回一条 tool 结果，下一次请求能过；脚本回答自动翻成原生回复', async () => {
  let round = 0;
  const fake = fakeDeepSeek({
    chat: () =>
      ++round === 1
        ? { speaker: 'le', message: '我先查。', toolCalls: [{ name: 'records.search', args: { q: '虚构' } }] }
        : { speaker: 'yong', message: '查到了。', toolCalls: [] },
  });
  const messages: ToolChatMessage[] = [...user];
  const first = await completeChatTools(fakeKey, messages, tools, fake.transport);
  assert.equal(first.content, '【小勒】\n我先查。');
  const firstCall = first.toolCalls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.function.name, 'records__search');
  assert.deepEqual(JSON.parse(firstCall.function.arguments), { q: '虚构' });
  assert.ok(first.reasoning, '开了思考，假服务回了思考内容');
  messages.push(first.assistantMessage, { role: 'tool', tool_call_id: firstCall.id, content: '{"ok":true}' });
  const second = await completeChatTools(fakeKey, messages, tools, fake.transport);
  assert.equal(second.content, '【小甬】\n查到了。');
  assert.deepEqual(second.toolCalls, []);
  const secondCall = fake.chatCalls()[1];
  assert.ok(secondCall);
  assert.deepEqual(secondCall.body.messages[1], first.assistantMessage, '思考内容和工具调用原样回传');
});

test('假服务按官方规则拒绝的请求：思考模式下 tool_choice 不是 auto/none、tool 结果对不上、工具名不合规', () => {
  const body = (extra: Partial<ChatBody>): ChatBody => ({ model: 'deepseek-flash', tools, messages: user, ...extra });
  const rejected = (extra: Partial<ChatBody>, pattern: RegExp) => {
    const error = nativeRequestError(body(extra));
    assert.ok(error);
    assert.match(error, pattern);
  };
  rejected({ tool_choice: 'required' }, /auto or none/);
  rejected({ tool_choice: { type: 'function', function: { name: 'ask_user' } } }, /auto or none/);
  assert.equal(nativeRequestError(body({ tool_choice: 'required', thinking: { type: 'disabled' } })), null);
  rejected({ messages: [...user, { role: 'tool', tool_call_id: 'nope', content: '' }] }, /matching/);
  rejected({ tools: [{ type: 'function', function: { name: 'a.b' } }] }, /Invalid function name/);
  assert.equal(nativeRequestError(body({ tools: [{ type: 'deepseek_web_search' }, ...tools] })), null, '内置联网工具不算函数');
});

test('正文和思考里出现密钥：整条回复拒绝，流给页面的字里拼不出密钥——密钥被拆在两块之间也一样（尾巴扣住不先吐）', async () => {
  const head = fakeKey.slice(0, 8),
    tail = fakeKey.slice(8);
  for (const field of ['content', 'reasoning_content'] as const)
    for (const parts of [['虚构正文 ' + fakeKey], ['虚构正文 ' + head, tail + ' 后文']]) {
      const shown: string[] = [];
      await rejects(
        () =>
          completeChatTools(fakeKey, user, tools, sse(parts.map((p) => ({ [field]: p })), 'stop'), {
            onTextDelta: (d) => shown.push(d),
            onReasoningDelta: (d) => shown.push(d),
          }),
        /不安全|敏感凭据/,
      );
      assert.ok(!shown.join('').includes(head), field + ' 流出了密钥开头：' + shown.join(''));
    }
});
