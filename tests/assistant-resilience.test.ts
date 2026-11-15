// 助手一轮对话扛得住中断：发话中途断线自动原样重发、一直不行就明说失败（不拿半截文字当回复）、
// 单个命令超时中止后告诉模型、每一步当时就存、进程中断后再开这个会话接得上（没开始的、查到一半的、结果不明的各有说法）、
// 同一请求编号重发直接给上次的结果。假 DeepSeek、内存库、虚构数据，不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CHAT_RETRY } from '../server/ai/chat-retry.js';
import { AiConnectionError } from '../server/ai/errors.js';
import { RESTARTED_TEXT } from '../server/assistant/chat/finish-run.js';
import { INTERRUPTED, NOT_RUN_NOTE, SHOWN_NOTE } from '../server/assistant/chat/session-history.js';
import type { AgentOptions } from '../server/assistant/chat/agent-config.js';
import { z } from 'zod';
import { actor, assistantFixture, flowFixture, lastCard, readAs, scriptModel } from './assistant-fixture.js';
import { messageText, replyCutOff, toolResultSent } from './fake-deepseek.js';
import type { ChatBody } from './fake-deepseek-wire.js';
import type { AiTransport } from '../server/ai/transport.js';
import { count } from '../server/core/index.js';
import { field } from '../server/assistant/chat/result-fields.js';

const answer = (message: string) => ({ message, toolCalls: [] });
const calls = (...list: [string, unknown][]) => ({ message: '', toolCalls: list.map(([name, args]) => ({ name, args })) });
// 够长，流式时前面一段会先交给页面
const HALF = '虚构客户一共有三家，分别是虚构甲纸品、虚构乙包装和虚构丙贸易，其中两家这个月有订单，另外一';

/** 读网页（假 DeepSeek 的 /tools/fetch）一直不回来，直到被中止；started、aborted 由测试按需接上 */
type HangingFetch = { started?: () => void; aborted?: () => void };
const hangFetch = (hooks: HangingFetch) => (next: AiTransport): AiTransport => {
  // 留住挂着的请求：Request 的 signal 跟着外面的中止信号走，但只是弱引用；挂着的这条等待链没人引用，
  // 请求对象一被回收，中止就传不到这里（机器忙、回收早时“收到中止”会偶尔落空，还要等 90 秒的时限才放开）
  const held: Request[] = [];
  return (request) => {
    if (!new URL(request.url).pathname.endsWith('/tools/fetch')) return next(request);
    held.push(request);
    hooks.started?.();
    return new Promise((_, reject) =>
      request.signal.addEventListener('abort', () => {
        hooks.aborted?.();
        reject(new Error('aborted'));
      }),
    );
  };
};

/** 一个会话的夹具：模型按 replies 回答，排完了说“好的。”；读网页一直挂着（connectWeb() 接上后才用得到） */
function setup(replies: unknown[], agent: AgentOptions = {}) {
  const fetchHooks: HangingFetch = {};
  const f = assistantFixture([], { agent, chat: () => replies.shift() ?? answer('好的。'), wrap: hangFetch(fetchHooks) });
  const thread = f.manager.create(actor) as { id: string };
  return {
    thread,
    store: f.store,
    fake: f.fake,
    events: f.events,
    get manager() {
      return f.manager;
    },
    restart: f.restart,
    close: f.close,
    say: (text: string) => f.say(thread.id, text),
    view: () => f.manager.view(thread.id, actor),
    fetchHooks,
    /** 让当前助手的联网读取走这个夹具的假 DeepSeek */
    connectWeb: () => f.manager.tools.connect({ ai: f.settings }),
    audit: (tool: string) =>
      f.store.db
        .prepare('SELECT state,document FROM assistant_audit WHERE tool=? ORDER BY id')
        .all(tool)
        .map((r): Record<string, unknown> => ({ state: String(r.state), ...z.record(z.string(), z.unknown()).parse(JSON.parse(String(r.document))) })),
  };
}
/** 最近一次发给模型的请求里，这一轮（最后一句用户的话之前的历史）各个工具结果的内容，按先后 */
const toolResults = (body: ChatBody) => body.messages.filter((m) => m.role === 'tool').map((m): unknown => JSON.parse(messageText(m)));

test('发话中途断线：自动原样重发，页面上那半截字清掉，最后的回复是完整的那一条', async () => {
  const f = setup([replyCutOff('【小甬】\n' + HALF), answer('虚构客户有三家。')]);
  try {
    const view = await f.say('有几家客户');
    const reply = view.messages.at(-1);
    assert.ok(reply, '有回复');
    assert.equal(reply.text, '虚构客户有三家。');
    assert.equal(reply.error, undefined);
    const drafts = f.events.filter(([e]) => e === 'draft').map(([, d]) => z.string().parse(d.text));
    const cleared = drafts.indexOf('');
    assert.ok(cleared > 0 && drafts[cleared - 1] && HALF.startsWith(drafts[cleared - 1]), '先收到半截，重发前清空');
    assert.equal(drafts.at(-1), '虚构客户有三家。');
    assert.deepEqual(
      f.events.filter(([e, d]) => e === 'progress' && d.stage === 'retrying').map(([, d]) => d.attempt),
      [1],
    );
    assert.deepEqual(f.audit('assistant.retry'), [{ state: 'response', attempt: 1, round: 1, note: 'incomplete' }]);
    const sent = f.fake.chatCalls().map((c) => JSON.stringify(c.body));
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1], '重发的请求和第一次一模一样');
  } finally {
    f.close();
  }
});

test('一直断线：重发满次数后明说失败，半截文字不当回复、不进历史', async () => {
  const f = setup(Array.from({ length: 1 + CHAT_RETRY.retries }, () => replyCutOff('【小甬】\n' + HALF)));
  try {
    await assert.rejects(f.say('有几家客户'), /中途断开/);
    assert.equal(f.fake.chatCalls().length, 1 + CHAT_RETRY.retries);
    const last = f.view().messages.at(-1);
    assert.ok(last, '有回复');
    assert.equal(last.error, true);
    assert.match(last.text, /中途断开/);
    assert.equal(last.text.includes(HALF), false);
    await f.say('再试一次');
    assert.equal(JSON.stringify(f.fake.chatCalls().at(-1)?.body).includes(HALF), false, '半截文字没有进会话历史');
  } finally {
    f.close();
  }
});

test('空回复：当成没收到，重发一次', async () => {
  const f = setup([answer(''), answer('虚构客户有三家。')]);
  try {
    const view = await f.say('有几家客户');
    assert.equal(view.messages.at(-1)?.text, '虚构客户有三家。');
    assert.equal(f.fake.chatCalls().length, 2);
    assert.deepEqual(f.audit('assistant.retry').map((a) => a.note), ['empty']);
  } finally {
    f.close();
  }
});

test('单个命令超过限时：中止它，把超时告诉模型，这一轮接着办', async () => {
  const f = setup([calls(['web.read', { url: 'https://example.com/slow' }]), answer('这个网页太慢，没读成。')], {
    session: { toolTimeoutMs: 30 },
  });
  try {
    let aborted = false;
    f.fetchHooks.aborted = () => {
      aborted = true;
    };
    f.connectWeb();
    const view = await f.say('读一下 https://example.com/slow');
    assert.equal(aborted, true, '命令收到了中止信号');
    const result = readAs(toolResultSent(f.fake.chatCalls(), 'web.read'), { ok: z.unknown(), message: z.string() });
    assert.equal(result.ok, false);
    assert.match(result.message, /太久没有做完，已经中止/);
    const last = view.messages.at(-1);
    assert.equal(last?.text, '这个网页太慢，没读成。');
    assert.equal(last?.facts?.failed.length, 1);
  } finally {
    f.close();
  }
});

test('用户点停止：正在查的那个调用收到中止；下一轮里写明查询中断、没拿到结果', async () => {
  const f = setup([calls(['web.read', { url: 'https://example.com/slow' }])]);
  let aborted = false;
  try {
    f.fetchHooks.started = () => setImmediate(() => f.manager.cancel(f.thread.id, actor));
    f.fetchHooks.aborted = () => {
      aborted = true;
    };
    f.connectWeb();
    await assert.rejects(f.say('读一下 https://example.com/slow'), /已停止/);
    assert.equal(aborted, true, '联网读取收到了中止');
    await f.say('算了');
    const lastCall = f.fake.chatCalls().at(-1);
    assert.ok(lastCall, '又问了模型');
    assert.deepEqual(toolResults(lastCall.body), [{ ok: false, ...INTERRUPTED.read }]);
  } finally {
    f.close();
  }
});

test('进程中断后恢复：做完的结果还在，卡在半路的写入写明结果不明，没轮到的写明没有执行；会话里补一句，下一轮接得上', async () => {
  // 开自动确认：第二个调用出了卡片立刻执行，让执行卡住不回来，当作进程在写入的半路断了
  const f = setup(
    [
      calls(
        ['records.search', { module: 'customers' }],
        ['records.propose_save', { module: 'customers', patch: { name: '虚构中断客户' } }],
        ['records.search', { module: 'products' }],
      ),
    ],
    { autoConfirm: true },
  );
  try {
    let release!: (e: Error) => void;
    f.manager.previews.commit = () => new Promise((_, reject) => (release = reject));
    const first = f.manager;
    const stuck = f.say('查一下客户，再建一个虚构中断客户').catch(() => {});
    // 等到第二个调用开始执行（这时第一步的结果已经落盘）
    for (let i = 0; i < 200 && !f.events.some(([e, d]) => e === 'tool' && d.name === 'records.propose_save'); i++)
      await new Promise((r) => setTimeout(r, 5));
    const run = () => {
      const row = f.store.db.prepare('SELECT state,document FROM assistant_runs').get();
      assert.ok(row, '有运行记录');
      return row;
    };
    assert.equal(run().state, 'running');

    f.restart();
    assert.equal(run().state, 'failed');
    assert.equal(readAs(JSON.parse(String(run().document)), { message: z.unknown() }).message, RESTARTED_TEXT);
    const shown = f.view().messages.at(-1);
    assert.ok(shown, '会话里补了一句');
    assert.equal(shown.role, 'assistant');
    assert.equal(shown.text, RESTARTED_TEXT);
    assert.equal(shown.error, true);

    // 再开这个会话接着说：请求能过假 DeepSeek 的核对（每个调用都有结果），内容分三种
    const view = await f.say('刚才做到哪了');
    assert.equal(view.messages.at(-1)?.text, '好的。');
    const call = f.fake.chatCalls().at(-1);
    assert.ok(call, '又问了模型');
    const body = call.body;
    const results = toolResults(body);
    assert.equal(results.length, 3);
    assert.ok(field(results[0], 'ok') !== false && JSON.stringify(results[0]).includes('"module":"customers"'), '第一个调用的结果原样留着');
    assert.deepEqual(results[1], { ok: false, ...INTERRUPTED.write });
    assert.deepEqual(results[2], { ok: false, state: 'not_run', message: NOT_RUN_NOTE });
    assert.ok(body.messages.some((m) => m.role === 'system' && m.content === SHOWN_NOTE + RESTARTED_TEXT), '模型也看得到这一轮断在半路');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) AS n FROM customers'), 0, '没有默默重做');

    // 收场：让卡住的那一轮停下（清掉它的计时器）
    first.cancel(f.thread.id, actor);
    release(new Error('stopped'));
    await stuck;
  } finally {
    f.close();
  }
});

test('进程中断时已经出了、还没显示给人的确认卡片：恢复时作废，下一轮模型知道它没有执行', async () => {
  const f = setup([
    calls(['records.propose_save', { module: 'customers', patch: { name: '虚构中断客户' } }], ['web.read', { url: 'https://example.com/slow' }]),
  ]);
  try {
    f.connectWeb();
    const first = f.manager;
    const stuck = f.say('建一个虚构中断客户，再读 https://example.com/slow').catch(() => {});
    for (let i = 0; i < 200 && !f.events.some(([e, d]) => e === 'tool' && d.name === 'web.read'); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(Object.values(f.manager.previews.states(f.thread.id)), ['waiting']);

    f.restart();
    assert.deepEqual(Object.values(f.manager.previews.states(f.thread.id)), ['cancelled']);
    await f.say('刚才那张卡片呢');
    const sent = JSON.stringify(f.fake.chatCalls().at(-1)?.body.messages);
    assert.ok(sent.includes('已作废，没有执行'), '卡片作废写进了下一轮的上下文');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) AS n FROM customers'), 0);
    first.cancel(f.thread.id, actor);
    await stuck;
  } finally {
    f.close();
  }
});

test('流程类卡片执行还没回来时再点确认：不再执行，告诉人结果不明；执行完再点只拿回原来的结果；执行没成的卡片也不再执行', async (t) => {
  const f = setup([
    calls(['inbox.add', { text: '虚构收件一' }]),
    answer('出了卡片。'),
    calls(['inbox.add', { text: '虚构收件二' }]),
    answer('出了卡片。'),
  ]);
  try {
    let runs = 0;
    let finish!: (value: unknown) => void, fail!: (error: Error) => void;
    t.mock.method(f.manager.extras, 'call', () => {
      runs++;
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    });
    const confirm = (id: string) => Promise.resolve().then(() => f.manager.execute(id, { acknowledged: true }, actor, 's'));
    const tick = () => new Promise((r) => setImmediate(r));
    const state = (index: number) => f.view().messages.filter((m) => m.plans?.length)[index].plans?.[0].state;

    const one = lastCard(await f.say('放进收件箱：虚构收件一'));
    const first = confirm(one.id);
    await tick();
    assert.equal(runs, 1);
    // 执行还没回来：再点一次、再点“不执行”都不行
    await assert.rejects(confirm(one.id), /已经发出去了，结果不明/);
    assert.throws(() => f.manager.reject(one.id, actor, 's'), /结果不明/);
    assert.equal(runs, 1, '没有再执行一遍');
    assert.equal(state(0), 'unknown');
    finish({ id: 1, message: '虚构：已放进收件箱' });
    assert.deepEqual(await first, { id: 1, message: '虚构：已放进收件箱' });
    assert.equal(state(0), 'executed');
    assert.deepEqual(await confirm(one.id), { id: 1, message: '虚构：已放进收件箱' }, '执行过的再点只拿回原结果');
    assert.equal(runs, 1);

    // 执行没成：卡片记下原因，不再执行；下一轮模型知道
    const two = lastCard(await f.say('再放一条：虚构收件二'));
    const failing = confirm(two.id);
    await tick();
    fail(new Error('虚构：收件箱写不进去'));
    await assert.rejects(failing, /收件箱写不进去/);
    await assert.rejects(confirm(two.id), /上次执行没有成功/);
    assert.equal(runs, 2);
    assert.equal(state(1), 'failed');
    await f.say('刚才那张怎么样了');
    assert.ok(JSON.stringify(f.fake.chatCalls().at(-1)?.body.messages).includes('执行没有成功，这张卡片不会再执行'));
  } finally {
    f.close();
  }
});

test('流程类卡片执行到一半进程断了：重启后再点确认不再执行，卡片写明结果不明', async (t) => {
  const f = setup([calls(['inbox.add', { text: '虚构收件三' }]), answer('出了卡片。')]);
  try {
    let runs = 0;
    t.mock.method(f.manager.extras, 'call', () => {
      runs++;
      return new Promise(() => {});
    });
    const card = lastCard(await f.say('放进收件箱：虚构收件三'));
    void Promise.resolve(f.manager.execute(card.id, { acknowledged: true }, actor, 's')).catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 1);
    f.restart();
    t.mock.method(f.manager.extras, 'call', () => void runs++);
    assert.throws(() => f.manager.execute(card.id, { acknowledged: true }, actor, 's'), /结果不明/);
    assert.equal(runs, 1);
    assert.equal(f.view().messages.at(-1)?.plans?.[0].state, 'unknown');
  } finally {
    f.close();
  }
});

test('同一请求编号重发：不再问模型、直接给上次的结果；同一编号换了内容拒绝', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      input = f.input('你好', randomUUID());
    await f.manager.chat(t.id, input, actor, 's', () => {}, () => actor);
    const count = f.calls();
    await f.manager.chat(t.id, input, actor, 's', () => {}, () => actor);
    assert.equal(f.calls(), count);
    await assert.rejects(() => f.manager.chat(t.id, { ...input, text: '不同内容' }, actor, 's', () => {}, () => actor), /凭据/);
  } finally {
    f.close();
  }
});

test('写入执行后模型接口断了：已经执行的照实记在这一轮的事实里；同一请求重发不再问模型、不重复创建', async () => {
  const f = flowFixture();
  try {
    const t = f.manager.create(actor);
    let n = 0;
    scriptModel(f.settings, () => {
      if (++n === 1) return calls(['records.propose_save', { module: 'customers', patch: { name: '中断测试客户' } }]);
      throw new AiConnectionError('network', '虚构连接中断');
    });
    const input = f.input('创建中断测试客户', randomUUID());
    await assert.rejects(() => f.manager.chat(t.id, input, actor, 's', () => {}, () => actor), /虚构连接中断/);
    const last = f.manager.view(t.id, actor).messages.at(-1);
    assert.ok(last, '有回复');
    assert.equal(f.store.customers().length, 1);
    assert.equal(last.error, true);
    assert.equal(last.facts?.executed.length, 1);
    await f.manager.chat(t.id, input, actor, 's', () => {}, () => actor);
    assert.equal(n, 2, '重发同一请求直接给上次的结果');
    assert.equal(f.store.customers().length, 1);
  } finally {
    f.close();
  }
});

// 假的正文流一直不结束时，留住请求对象：没人引用的话整条等待链会被回收，中止信号传不到流上（见 tests/deepseek-chat-retry.test.ts 的说明）
const heldRequests: Request[] = [];
test('模型那边只发保活行、迟迟不来内容：整轮的总时限到了照样停下，回复写明超时，不再重发', async () => {
  let sent = 0;
  const keepAliveOnly = async (request: Request) => {
    sent++;
    heldRequests.push(request);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setInterval(() => controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')), 10);
          request.signal.addEventListener(
            'abort',
            () => {
              clearInterval(timer);
              controller.error(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  // 空闲时限用默认的 300 秒（到不了），整轮总时限调成 150 毫秒
  const f = assistantFixture([], { budget: { timeoutMs: 150 }, wrap: () => keepAliveOnly });
  try {
    const thread = f.manager.create(actor);
    await assert.rejects(f.say(thread.id, '你好'), /这一轮超时了/);
    const last = f.manager.view(thread.id, actor).messages.at(-1);
    assert.ok(last, '有回复');
    assert.equal(last.text, '这一轮超时了，已经停下。');
    assert.equal(last.error, true);
    assert.equal(sent, 1, '整轮到时限以后不再重发');
  } finally {
    f.close();
  }
});
