// 助手对话的自动重发和空闲超时（server/ai/chat-retry.ts、transport.ts 的 Deadline）：
// 连不上、断线、5xx、空回复、长时间没有新内容原样再发，最多 5 次；别的错不重发；用户停止就不再发；识别类不重发。
// 等时限的几条用 node:test 的假计时器推时间，不真等。假 DeepSeek，不发真实请求。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHttp, fakeAiSettings, fakeKey, httpError, replyCutOff, replyFinish, replyNative } from './fake-deepseek.js';
import { CHAT_FIRST_CONTENT_TIMEOUT_MS, CHAT_IDLE_TIMEOUT_MS, CHAT_RETRY, retryDelay } from '../server/ai/chat-retry.js';
import { AiConnectionError } from '../server/ai/errors.js';
import type { ChatTool, ToolChatMessage } from '../server/ai/chat-tools.js';
import type { ChatMessage } from '../server/ai/chat.js';

const tools: ChatTool[] = [
  { type: 'function', function: { name: 'records__search', description: '虚构查询', parameters: { type: 'object', properties: {} } } },
];
const user: ToolChatMessage[] = [{ role: 'user', content: '虚构问题' }];
const ok = replyNative({ content: '【小甬】\n虚构回答。' });
/** 按顺序给出每次请求的回复；用完了都回正常回答 */
const scripted = (replies: unknown[]) => fakeAiSettings({ chat: () => replies.shift() ?? ok });
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof AiConnectionError, String(error));
  assert.equal(error.code, expected);
  return true;
};

test('重发前等多久：500 毫秒起、每次乘 2、最多 10 秒，上下浮动一成；真实时限是第一个内容之前 10 分钟、之后 300 秒', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryDelay(n, () => 0.5)), [500, 1000, 2000, 4000, 8000, 10_000]);
  assert.equal(retryDelay(1, () => 0), 450);
  assert.equal(retryDelay(1, () => 1), 550);
  // 按 DeepSeek 的限速说明定的：排队时最长 10 分钟只发保活行
  assert.deepEqual([CHAT_FIRST_CONTENT_TIMEOUT_MS, CHAT_IDLE_TIMEOUT_MS], [600_000, 300_000]);
});

test('连不上、断线、5xx、空回复：原样再发，直到拿到完整回复；每次重发前告诉调用方', async () => {
  const unreachable = new FakeHttp(() => {
    throw new TypeError('fetch failed');
  });
  const { settings, fake } = scripted([unreachable, replyCutOff('【小甬】\n虚构半'), httpError(500), httpError(502), replyNative({ content: '' })]);
  try {
    const retries: [number, string, string | undefined][] = [];
    const result = await settings.completeChatTools(user, tools, undefined, {
      onRetry: (attempt, error) => retries.push([attempt, error.code, error.responseNote?.kind]),
    });
    assert.equal(result.content, '【小甬】\n虚构回答。', '没有拿半截文字当回复');
    assert.deepEqual(retries, [
      [1, 'network', undefined],
      [2, 'response', 'incomplete'],
      [3, 'upstream', undefined],
      [4, 'upstream', undefined],
      [5, 'response', 'empty'],
    ]);
    const bodies = fake.chatCalls().map((c) => JSON.stringify(c.body));
    assert.equal(bodies.length, 6);
    assert.equal(new Set(bodies).size, 1, '每次发的请求一模一样');
  } finally {
    settings.close();
  }
});

test('一直不行：重发满 5 次以后把最后一次的错误照实报出来', async () => {
  const { settings, fake } = fakeAiSettings({ chat: () => httpError(500) });
  try {
    await assert.rejects(() => settings.completeChatTools(user, tools), code('upstream'));
    assert.equal(fake.chatCalls().length, 1 + CHAT_RETRY.retries);
  } finally {
    settings.close();
  }
});

test('不该重发的不重发：密钥不对、余额不足、请求不合规、输出被截断', async () => {
  for (const [reply, expected] of [
    [httpError(401), 'authentication'],
    [httpError(402), 'quota'],
    [httpError(400), 'validation'],
    [replyFinish('length', '虚构半句'), 'response'],
  ] as const) {
    const { settings, fake } = scripted([reply]);
    try {
      await assert.rejects(() => settings.completeChatTools(user, tools), code(expected));
      assert.equal(fake.chatCalls().length, 1, expected);
    } finally {
      settings.close();
    }
  }
});

test('用户点了停止：不再重发', async () => {
  const stop = new AbortController();
  const { settings, fake } = fakeAiSettings({ chat: () => httpError(500) });
  try {
    await assert.rejects(() => settings.completeChatTools(user, tools, stop.signal, { onRetry: (attempt) => attempt === 2 && stop.abort() }));
    assert.equal(fake.chatCalls().length, 2);
  } finally {
    settings.close();
  }
});

test('识别类请求不自动重发：断流、参数校验、服务出错、网关超时都只发一次；诊断里没有消息正文和密钥', async () => {
  const form = { name: 'fill', description: '虚构的表', parameters: { type: 'object', properties: {} } };
  const messages: ChatMessage[] = [
    { role: 'system', content: '返回json对象，不执行任何操作' },
    { role: 'user', content: '测试专用隐私正文，不得记录' },
  ];
  const events: unknown[] = [];
  const { settings, fake } = scripted([replyCutOff('{"虚构":'), httpError(400), httpError(500), httpError(504)]);
  try {
    for (const expected of ['response', 'validation', 'upstream', 'timeout']) {
      const before = fake.chatCalls().length;
      await assert.rejects(() => settings.fillForm(messages, form, undefined, { onDiagnostic: (d) => events.push(d) }), code(expected));
      assert.equal(fake.chatCalls().length, before + 1, expected + ' 不重发');
    }
    assert.ok(events.length > 0);
    assert.ok(!JSON.stringify(events).includes('测试专用隐私正文'));
    assert.ok(!JSON.stringify(events).includes(fakeKey));
  } finally {
    settings.close();
  }
});

// ---- 空闲超时：假计时器推时间 ----

// 假的正文流停住不动时，没有任何真实的读写挂着，整条等待链（请求、流、等结果的函数）会被当成垃圾回收，
// 中止信号就传不到流上、测试永远等不到结果；真实的 fetch 有连接挂着，不会这样。所以把请求留在模块级的变量里。
const held: Request[] = [];
const encoder = new TextEncoder();
const chunk = (delta: unknown, finish: string | null = null) =>
  encoder.encode('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
/** 流的脚本：数字是发几行保活注释（每 10 毫秒一行）；{ delta } 是一块增量；'stall' 停住不动；'close' 不发结束块就关。走完发结束块 */
type Step = number | { delta: unknown } | 'stall' | 'close';
function sse(request: Request, steps: Step[]) {
  held.push(request);
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let aborted = false;
        // 和真实的 fetch 一样：请求被中止时正文流报错
        request.signal.addEventListener('abort', () => ((aborted = true), controller.error(new DOMException('aborted', 'AbortError'))), { once: true });
        for (const step of steps) {
          if (aborted || step === 'stall') return;
          if (step === 'close') return controller.close();
          if (typeof step !== 'number') controller.enqueue(chunk(step.delta));
          else
            for (let i = 0; i < step && !aborted; i++) {
              controller.enqueue(encoder.encode(': keep-alive\n\n'));
              await new Promise((r) => setTimeout(r, 10));
            }
        }
        if (!aborted) controller.enqueue(chunk({}, 'stop')), controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
/** 每次请求按 plan(第几次) 给流 */
function streaming(plan: (call: number) => Step[]) {
  let calls = 0;
  const { settings } = fakeAiSettings({ wrap: () => async (request) => sse(request, plan(++calls)) });
  return { settings, calls: () => calls };
}
/** 开假计时器，每 10 毫秒推一次，直到 promise 有结果 */
async function drive<T>(t: TestContext, run: () => Promise<T>, limitMs = 20_000): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  let settled = false;
  const promise = run();
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let ms = 0; ms < limitMs && !settled; ms += 10) {
    await flush();
    t.mock.timers.tick(10);
  }
  await flush();
  return promise;
}
const twoStage = { idleTimeoutMs: 60, firstContentTimeoutMs: 300 };

test('只有保活行、超过第一段时限还没内容：保活行骗不过，等满第一段（不是按内容后的 60 毫秒）才断开重发，报“没有新内容”', async (t) => {
  const stop = new AbortController();
  const s = streaming(() => [100_000]);
  try {
    const retries: [number, string, string][] = [];
    await assert.rejects(
      drive(t, () =>
        s.settings.completeChatTools(user, tools, stop.signal, {
          ...twoStage,
          // 只看第一次：每次都是同一段代码
          onRetry: (attempt, error) => (retries.push([Date.now(), error.code, error.message]), attempt === 1 && stop.abort()),
        }),
      ),
    );
    assert.equal(retries.length, 1);
    const first = retries[0];
    assert.ok(first);
    const [at, errorCode, message] = first;
    assert.ok(at >= 300 && at < 400, '断开时间 ' + at);
    assert.equal(errorCode, 'timeout');
    assert.match(message, /没有新内容/);
    assert.equal(s.calls(), 1);
  } finally {
    s.settings.close();
  }
});

test('排队时只有保活行、比内容开始后的空闲时限久但没到第一段时限：不断开，内容来了正常答完', async (t) => {
  // 保活行发 15 行（约 150 毫秒，比 60 毫秒长、比 300 毫秒短）再出内容
  const s = streaming(() => [15, { delta: { content: '【小甬】\n虚构排队后的回答。' } }]);
  try {
    const result = await drive(t, () => s.settings.completeChatTools(user, tools, undefined, twoStage));
    assert.equal(result.content, '【小甬】\n虚构排队后的回答。');
    assert.equal(s.calls(), 1, '排队等内容时没有自己断开重排');
  } finally {
    s.settings.close();
  }
});

test('空闲超时只看真正的内容：保活行之间夹着思考和正文的增量，隔得不超过时限就不断', async (t) => {
  // 每 60 毫秒来一块内容（时限 150 毫秒），中间都是保活行，总共 240 毫秒，比时限长
  const deltas = [{ reasoning_content: '想' }, { reasoning_content: '一下' }, { content: '【小甬】\n虚构' }, { content: '回答。' }];
  const s = streaming(() => deltas.flatMap((delta): Step[] => [6, { delta }]));
  try {
    const result = await drive(t, () => s.settings.completeChatTools(user, tools, undefined, { idleTimeoutMs: 150 }));
    assert.equal(result.content, '【小甬】\n虚构回答。');
    assert.equal(s.calls(), 1, '没有被当成空闲断开');
  } finally {
    s.settings.close();
  }
});

test('内容开始以后停住超过空闲时限：照旧断开重发（不按第一段的长时限等）', async (t) => {
  const s = streaming((n) => (n === 1 ? [{ delta: { content: '【小甬】\n' } }, 'stall'] : [{ delta: { content: '【小甬】\n虚构回答。' } }]));
  try {
    let retriedAt = 0;
    const result = await drive(t, () => s.settings.completeChatTools(user, tools, undefined, { ...twoStage, onRetry: () => (retriedAt = Date.now()) }));
    assert.equal(result.content, '【小甬】\n虚构回答。');
    assert.equal(s.calls(), 2);
    assert.ok(retriedAt >= 60 && retriedAt < 300, '停住约 60 毫秒就断开：' + retriedAt);
  } finally {
    s.settings.close();
  }
});

test('连接直接断了：不等时限，立刻按重发规则重发', async (t) => {
  const s = streaming((n) => (n === 1 ? [1, 'close'] : [{ delta: { content: '【小甬】\n虚构回答。' } }]));
  try {
    let retriedAt = -1;
    const result = await drive(t, () => s.settings.completeChatTools(user, tools, undefined, { ...twoStage, onRetry: () => (retriedAt = Date.now()) }));
    assert.equal(result.content, '【小甬】\n虚构回答。');
    assert.equal(s.calls(), 2);
    assert.ok(retriedAt >= 0 && retriedAt < 60, '断了就重发，没等时限：' + retriedAt);
  } finally {
    s.settings.close();
  }
});
