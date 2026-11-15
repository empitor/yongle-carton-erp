// AI 接入的对话调用（填表、助手对话）和传输工具：请求长什么样、报错怎么说、密钥不外流。假 DeepSeek，不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAiSettings, fakeKey, forcedFunction, httpError, replyFinish, replyNative, replyText } from './fake-deepseek.js';
import { Deadline, readJson, readSse } from '../server/ai/transport.js';
import { AiConnectionError, deepSeekError } from '../server/ai/errors.js';
import { publicWebUrl } from '../server/ai/web.js';
import { userIdFor } from '../server/ai/chat-exchange.js';
import { SseParser } from '../shared/core/sse.js';
import { z } from 'zod';
import type { ToolChatMessage } from '../server/ai/chat-tools.js';
import type { ProviderTokenUsage } from '../server/ai/usage.js';
import type { ProviderDiagnostic } from '../server/ai/protocol-diagnostics.js';

const user = (text: string) => [{ role: 'user' as const, content: text }];
/** 识别“填表”用的一张虚构的表 */
const form = { name: 'fill', description: '虚构的表', parameters: { type: 'object', properties: {} } };

test('填表：固定地址和模型、关思考、点名调这一个工具、默认流式；流式和非流式都能拿到完整结果和用量；不跟随跳转', async () => {
  const usages: ProviderTokenUsage[] = [],
    redirects: string[] = [];
  const { settings, fake } = fakeAiSettings({
    chat: (body) => (forcedFunction(body) !== undefined ?{ 客户: '虚构客户' } : replyText('【小甬】\n虚构回复')),
    wrap: (t) => (request) => (redirects.push(request.redirect), t(request)),
  });
  try {
    const result = await settings.fillForm(user('你好'), form, undefined, { onUsage: (u) => usages.push(u) });
    assert.deepEqual(result, { 客户: '虚构客户' });
    const call = fake.chatCalls()[0];
    assert.equal(call.url.href, 'https://api.deepseek.com/chat/completions');
    assert.equal(call.headers.get('authorization'), 'Bearer ' + fakeKey);
    assert.equal(call.body.model, 'deepseek-flash');
    assert.deepEqual(call.body.thinking, { type: 'disabled' });
    assert.deepEqual(call.body.tool_choice, { type: 'function', function: { name: 'fill' } });
    assert.equal('response_format' in call.body, false);
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.stream_options, { include_usage: true });
    assert.equal(call.body.max_tokens, 16000);
    // 非流式：正文前面带保活空行也能读，用量一样报
    assert.deepEqual(await settings.fillForm(user('你好'), form, undefined, { stream: false, onUsage: (u) => usages.push(u) }), { 客户: '虚构客户' });
    assert.equal(fake.chatCalls()[1].body.stream, false);
    // 假 DeepSeek 两种都回 120 进、30 出，其中 64 命中缓存
    const expected = { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 64, reasoningTokens: 0 };
    assert.deepEqual(usages, [expected, expected]);
    // 跟随跳转会把密钥头带到别的主机：请求一律不跟随，上游回 3xx 也不跟
    assert.deepEqual([...new Set(redirects)], ['error']);
    fake.next('/chat/completions', new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
    await assert.rejects(settings.fillForm(user('你好'), form), (e: unknown) => {
      assert.ok(e instanceof AiConnectionError);
      assert.match(e.message, /跳转，为保护密钥没有跟随/);
      assert.ok(!e.message.includes(fakeKey));
      return true;
    });
    // 助手的对话：账号编号只发摘要
    await settings.completeChatTools(user('你好'), [], undefined, { userKey: 'fictional-user' });
    const thirdCall = fake.chatCalls().at(-1);
    assert.ok(thirdCall);
    const third = thirdCall.body;
    assert.equal(third.user_id, userIdFor('fictional-user'));
    assert.ok(third.user_id);
    assert.ok(!third.user_id.includes('fictional-user'), '账号编号只发摘要');
  } finally {
    settings.close();
  }
});

test('对话失败按原因给中文提示：截断、审核、资源不足、没按表交回、回显密钥、流中途断开', async () => {
  const replies: unknown[] = [];
  const { settings, fake } = fakeAiSettings({ chat: () => replies.shift() });
  const fails = async (reply: unknown, pattern: RegExp, code = 'response') => {
    replies.push(reply);
    await assert.rejects(settings.fillForm(user('x'), form), (e: unknown) => {
      assert.ok(e instanceof AiConnectionError);
      assert.equal(e.code, code, e.message);
      assert.match(e.message, pattern);
      return true;
    });
  };
  try {
    await fails(replyFinish('length', '{"a":'), /截断/);
    await fails(replyFinish('content_filter'), /安全审核/, 'content_filter');
    await fails(replyFinish('insufficient_system_resource', '{'), /资源紧张/, 'upstream');
    await fails(replyNative({ content: '{}', toolCalls: [{ name: 'x', arguments: '{}' }], finish: 'stop' }), /没有按表交回/);
    await fails(replyText('不是填好的表，是一段话'), /没有按表交回/);
    await fails(replyText('   '), /没有按表交回/);
    await fails({ leak: fakeKey }, /不安全|敏感凭据/);
    fake.next('/chat/completions', fake.brokenStream([': keep-alive\n\n', 'data: {"choices":[{"delta":{"content":"{"}}]}\n\n'], 1));
    await assert.rejects(settings.fillForm(user('x'), form), (e: unknown) => {
      assert.ok(e instanceof AiConnectionError);
      return e.code === 'response' && /中途断开/.test(e.message);
    });
    // 截断时把用量和收到的字数记进诊断
    replies.push(replyFinish('length', '{"partial":'));
    await assert.rejects(settings.fillForm(user('x'), form), (e: unknown) => {
      assert.ok(e instanceof AiConnectionError);
      assert.ok(e.diagnostic);
      assert.equal(e.diagnostic.reason, 'length');
      assert.equal(e.diagnostic.outputTokens, 30);
      assert.ok(e.diagnostic.receivedChars);
      assert.ok(e.diagnostic.receivedChars > 0);
      return true;
    });
  } finally {
    settings.close();
  }
});

test('报错对照：状态码换成中文，不透传上游原文；429 和 503 都算限流（排队重试见 ai-work-queue.test.ts）', async () => {
  const { settings, fake } = fakeAiSettings();
  try {
    for (const [status, code, pattern] of [
      [401, 'authentication', /密钥不对/],
      [402, 'quota', /余额不足/],
      [500, 'upstream', /内部出错/],
      [400, 'validation', /不接受/],
    ] as const) {
      fake.next('/chat/completions', httpError(status, { error: { message: 'upstream said ' + fakeKey } }).response());
      await assert.rejects(settings.fillForm(user('x'), form), (e: unknown) => {
        assert.ok(e instanceof AiConnectionError);
        assert.equal(e.code, code);
        assert.match(e.message, pattern);
        assert.ok(!e.message.includes(fakeKey) && !e.message.includes('upstream said'));
        return true;
      });
    }
    assert.equal(deepSeekError(429, null, 'chat').code, 'rate_limit');
    assert.equal(deepSeekError(503, null, 'chat').code, 'rate_limit');
    assert.match(deepSeekError(400, { error: { message: 'maximum context length exceeded' } }, 'chat').message, /上限/);
    assert.match(deepSeekError(400, null, 'upload').message, /读不了这个文件/);
    assert.match(deepSeekError(413, null, 'asr').message, /太大/);
    assert.match(deepSeekError(504, null, 'upload').message, /超时/);
  } finally {
    settings.close();
  }
});

test('对话里引用的文件失效：认出三种 400 文案并取出点名的文件编号；上传 400 按个数、存储、读不了分开说并带上限', () => {
  const said = (message: string, op: 'chat' | 'upload' = 'chat') => deepSeekError(400, { error: { message } }, op);
  for (const text of [
    'file_ids do not exist or are not created under your account: file-api-a1, file-api-b2-x, file-api-a1',
    'file data not found for file_id file-api-a1 and file-api-b2-x',
    'messages[0].content[1].source.file_id: invalid file_id file-api-a1; file-api-b2-x',
  ]) {
    const e = said(text);
    assert.equal(e.code, 'unreadable');
    assert.deepEqual(e.invalidFileIds, ['file-api-a1', 'file-api-b2-x'], '去重');
    assert.match(e.message, /附件.*失效/);
    assert.ok(!e.message.includes('file-api'), '不透传上游原文');
  }
  assert.equal(said('invalid request').invalidFileIds, undefined, '别的 400 不算');
  assert.equal(said('file data not found for file_id file-api-a1', 'upload').invalidFileIds, undefined, '只认对话请求');
  const count = said('User file count limit exceeded (current: 999, limit: 1000)', 'upload');
  assert.equal(count.code, 'quota');
  assert.match(count.message, /文件个数到了上限（上限 1000 个）.*到期会自动删掉/);
  assert.match(said('User storage quota exceeded, limit 10.0GB', 'upload').message, /总大小到了上限（上限 10\.0 GB）/);
  assert.match(said('User storage quota exceeded', 'upload').message, /总大小到了上限，这份没传上去/, '没给数字就不说');
  assert.match(said('The image is too large to process', 'upload').message, /图片太大，处理不了/);
  assert.match(said('password-protected PDF', 'upload').message, /可能加了密码、已损坏/);
});

test('没填密钥时所有调用都说清楚，不发请求', async () => {
  const { settings, fake } = fakeAiSettings({ saveKey: false });
  try {
    for (const job of [
      () => settings.fillForm(user('x'), form),
      () => settings.speechToText(Buffer.alloc(100)),
      () => settings.webSearch({ query: '纸箱', count: 10 }),
      () => settings.balance(),
      () => settings.withUploadedFiles([{ name: 'a.png', data: Buffer.from('x'), purpose: 'user_data' }], async () => 1),
    ])
      await assert.rejects(job(), (e: unknown) => {
        assert.ok(e instanceof AiConnectionError);
        return e.code === 'key_required' && /还没填写 DeepSeek 密钥/.test(e.message);
      });
    assert.equal(fake.calls.length, 0);
  } finally {
    settings.close();
  }
});

test('读网页只收公网 http/https 地址', () => {
  assert.equal(publicWebUrl(' https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  for (const bad of [
    'ftp://example.com/',
    'file:///c:/x',
    'https://user:pw@example.com/',
    'http://localhost/',
    'http://127.0.0.1/',
    'http://192.168.1.10/',
    'http://[::1]/',
    'http://intranet/',
    'http://erp.local/',
    'https://example.com:8443/',
    'not a url',
  ])
    assert.throws(() => publicWebUrl(bad), /网址|只能读/, bad);
});

test('传输工具：读 JSON 跳过保活空行、超大停下；SSE 跳过注释、按字节拆开也拼得回、没结束的收尾报错；本地超时和调用方取消分开报', async () => {
  const enc = new TextEncoder();
  const chunked = (...parts: string[]) =>
    new Response(new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(enc.encode(p))), c.close()) }));
  /** 一直不回、直到被中止的请求 */
  const hanging = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  let d = new Deadline(5000);
  assert.deepEqual(await readJson(chunked('\n\n', '{"ok":true}'), 1000, d), { ok: true });
  await assert.rejects(readJson(chunked('x'.repeat(5000)), 1000, d), /过大/);
  const events: string[] = [];
  await readSse(chunked(': keep-alive\n\ndata: {"n":1}\n\n', 'data: [DONE]\n\n'), (e) => events.push(e.data), 10000, d);
  assert.deepEqual(events, ['{"n":1}', '[DONE]']);
  // 页面和传输共用的解析（shared/core/sse.ts）：按字节分块、中文和表情、多行 data、CRLF 都能拼回完整事件
  const parsed: string[] = [],
    parser = new SseParser((e) => parsed.push(e.data)),
    decoder = new TextDecoder();
  for (const byte of Buffer.from(': heartbeat\r\n\r\nevent: progress\r\ndata: {"text":\r\ndata: "纸箱📦"}\r\n\r\n'))
    parser.push(decoder.decode(Uint8Array.of(byte), { stream: true }));
  parser.push(decoder.decode());
  parser.finish();
  assert.deepEqual(parsed.map((data) => z.object({ text: z.string() }).parse(JSON.parse(data) as unknown).text), ['纸箱📦']);
  const broken = new SseParser(() => {});
  broken.push('data: {}');
  assert.throws(() => broken.finish());
  d.close();
  d = new Deadline(10);
  await assert.rejects(hanging(d.signal).catch((e: unknown) => Promise.reject(d.error(e))), /超过 0 秒|已停止/);
  d.close();
  const outer = new AbortController();
  d = new Deadline(5000, outer.signal);
  const cancelled = hanging(d.signal).catch((e: unknown) => Promise.reject(d.error(e)));
  outer.abort();
  await assert.rejects(cancelled, (e: unknown) => {
    assert.ok(e instanceof AiConnectionError);
    return e.code === 'busy' && /已取消/.test(e.message);
  });
  d.close();
});
test('没给工具的对话收到工具调用时严格拒绝；诊断不含原始参数', async () => {
  const diagnostics: ProviderDiagnostic[] = [];
  for (const stream of [true, false]) {
    const { settings } = fakeAiSettings({ chat: () => replyNative({ content: '{"message":"ok"}', toolCalls: [{ name: 'x', arguments: '{}' }] }) });
    try {
      await assert.rejects(
        () => settings.completeChatTools(privateMessages, [], undefined, { stream, onDiagnostic: (d) => diagnostics.push(d) }),
        /没有请求的工具调用/,
      );
    } finally {
      settings.close();
    }
    const last = diagnostics.at(-1);
    assert.ok(last);
    assert.ok(last.response);
    assert.equal(last.response.toolCalls, true);
    assert(!JSON.stringify(diagnostics).includes('测试专用隐私正文'));
  }
});
const privateMessages: ToolChatMessage[] = [
  { role: 'system', content: '返回json对象，不执行任何操作' },
  { role: 'user', content: '测试专用隐私正文，不得记录' },
];
