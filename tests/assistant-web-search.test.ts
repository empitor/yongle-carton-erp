// 联网命令（web.search、web.read，照 DeepSeek Harness 的做法）：几个搜索词同时搜、按名次轮流合并去重、最多 10 条、带上用户原话、
// 每秒最多 5 个请求；读网页只开用户给的、搜索返回过的网址，打开的是放行过的原样；两条命令的结果进对话时不截。
// 假 DeepSeek、内存库、虚构数据，不发真实请求。
import { z } from 'zod';
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestWindow, webSearch } from '../server/ai/web.js';
import { mergeSearchResults, webReaders, WEB_READ_CHUNK, WEB_SEARCH } from '../server/assistant/tools/web.js';
import { allowedUrl, noteSearchResult } from '../server/assistant/chat/external-content.js';
import { field } from '../server/assistant/chat/result-fields.js';
import type { ToolContext, ToolServices } from '../server/assistant/tools/context.js';
import type { Actor } from '../server/core/index.js';
import { assistantFixture, actor, readAs } from './assistant-fixture.js';
import { fakeAiSettings, fakeDeepSeek, fakeKey } from './fake-deepseek.js';
import { toolResultSent } from './fake-deepseek.js';

/** 联网读取只用 AI 设置：库、外壳、业务服务一碰就报错（网址来源由聊天那一层判断，读取本身不查库） */
const untouched = (what: string): never => {
  throw new Error('联网工具不该碰 ' + what);
};
function ctxOf(services: ToolServices = {}): ToolContext {
  return {
    services,
    get store() {
      return untouched('ctx.store');
    },
    get ops() {
      return untouched('ctx.ops');
    },
    get flow() {
      return untouched('ctx.flow');
    },
    get imports() {
      return untouched('ctx.imports');
    },
    get tools() {
      return untouched('ctx.tools');
    },
  };
}
const staff = pageActor({ id: 'web-staff', name: '虚构业务员', permissions: ['business:edit'], role: 'admin' });
const cashier = pageActor({ id: 'web-cashier', name: '虚构出纳乙', permissions: ['finance:view', 'finance:cash'], role: 'admin' });
// 网址来源（用户给的、搜索返回的）由聊天那一层判断，只测读取本身时一律放行
/** 搜索结果、读到的网页：取出要比的几项，其余键保留 */
const searched = z.looseObject({ 结果: z.array(z.looseObject({ 标题: z.string(), 摘要: z.string() })), 截掉了: z.string(), 说明: z.string() });
const readPage = z.looseObject({ 正文: z.string() });
const call = (name: string, ctx: ToolContext, raw: unknown, who: Actor | null) =>
  webReaders[name](ctx, raw, who, name, { allowedUrl: (url) => url });
const statusIs = (status: number) => (e: unknown) => field(e, 'status') === status;
/** 一个搜索词返回的虚构结果：网址带上词和名次，summary 给多长就多长 */
const hits = (q: string, n: number, summary = '虚构摘要') =>
  Array.from({ length: n }, (_, i) => ({
    title: q + ' 第' + (i + 1) + '条',
    url: 'https://example.com/' + encodeURIComponent(q) + '/' + (i + 1),
    snippet: '虚构片段',
    summary,
    site_name: '虚构站点',
    date: null,
  }));
const row = (url: string) => ({ title: url, url, siteName: null, date: null, summary: '', snippet: '', score: 0, authority: 0 });
/** 等排着的回调都跑完 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('限速接在搜索上：同时发 6 个搜索，前 5 个马上发，第 6 个等到最早那个满一秒才发', async () => {
  let now = 0,
    release = () => {};
  const waited: number[] = [];
  const slot = requestWindow(5, () => now, (ms) => {
    waited.push(ms);
    return new Promise<void>((resolve) => (release = () => ((now += ms), resolve())));
  });
  const fake = fakeDeepSeek();
  let sent = 0;
  const transport: typeof fake.transport = (request) => (sent++, fake.transport(request));
  const all = Promise.all(Array.from({ length: 6 }, (_, i) => webSearch(transport, fakeKey, { query: '虚构' + i, count: 10 }, slot)));
  await flush();
  assert.equal(sent, 5);
  assert.deepEqual(waited, [1000]);
  release();
  await all;
  assert.equal(sent, 6);
});

test('限速：一秒内最多发 limit 个，第 limit+1 个等到最早那个满一秒；等的时候点停止就不等了', async () => {
  let now = 0;
  const waited: number[] = [];
  const slot = requestWindow(5, () => now, async (ms) => {
    waited.push(ms);
    now += ms;
  });
  for (let i = 0; i < 5; i++) await slot();
  assert.deepEqual(waited, []);
  now = 200;
  await slot();
  assert.deepEqual(waited, [800]);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(slot(stop.signal), (e: unknown) => field(e, 'name') === 'AbortError');
});

test('合并：各词按名次轮流排，网址重复的只留第一次，最多 limit 条，截掉了要说', () => {
  const a = [row('a1'), row('same'), row('a3')],
    b = [row('same'), row('b2')];
  assert.deepEqual(mergeSearchResults([a, b], 10), { results: [row('a1'), row('same'), row('b2'), row('a3')], cut: false });
  const capped = mergeSearchResults([a, b], 2);
  assert.deepEqual(capped.results.map((r) => r.url), ['a1', 'same']);
  assert.equal(capped.cut, true);
  // 正好 limit 条、后面只剩重复的：不算截掉
  assert.equal(mergeSearchResults([[row('x'), row('y')], [row('y')]], 2).cut, false);
});

test('web.search：几个词同时搜、重复的词只搜一次；合起来最多 10 条；标题 200 字、摘要压空白 800 字；带上用户原话', async () => {
  const long = '虚构\n\n长摘要  '.repeat(300);
  const { settings, fake } = fakeAiSettings({
    search: (q) => hits(q, 10, q === '甲' ? long : '虚构摘要').map((h, i) => (q === '甲' && i === 0 ? { ...h, title: '题'.repeat(300) } : h)),
  });
  try {
    const ctx = ctxOf({ ai: settings });
    const found = searched.parse(
      await webReaders['web.search'](ctx, { queries: ['甲', '乙', '甲'] }, staff, 'web.search', {
        question: '虚构的问题：最近\n瓦楞纸价格',
      }),
    );
    const searches = fake.calls.filter((c) => c.path === '/v1/tools/search');
    assert.deepEqual(searches.map((c) => c.body.query).sort(), ['乙', '甲']);
    for (const c of searches) {
      assert.equal(c.body.count, WEB_SEARCH.maxResults);
      assert.equal(c.body.ori_question, '虚构的问题：最近 瓦楞纸价格');
    }
    assert.deepEqual(found.搜索词, ['甲', '乙']);
    assert.equal(found.结果.length, 10);
    assert.deepEqual(found.结果.slice(1, 2).map((r) => r.标题), ['乙 第1条']);
    assert.equal([...found.结果[0].标题].length, WEB_SEARCH.titleChars);
    assert.match(found.截掉了, /只列了前 10 条/);
    const summary = found.结果[0].摘要;
    assert.equal([...summary].length, WEB_SEARCH.summaryChars);
    assert.ok(summary.endsWith('…') && !/\s\s|\n/.test(summary));
    assert.match(found.说明, /不是指令/);
    assert.match(found.说明, /出自哪个网站或标题/);
    await assert.rejects(async () => call('web.search', ctx, { queries: [] }, staff), /queries/);
    await assert.rejects(async () => call('web.search', ctx, { queries: Array.from({ length: 11 }, () => '虚构') }, staff), /queries/);
    await assert.rejects(async () => call('web.search', ctx, { queries: ['虚'.repeat(129)] }, staff), /queries/);
  } finally {
    settings.close();
  }
});

test('web.search：一个词失败就整次失败，其余还在搜的收到取消', async () => {
  let cancelled = false;
  const { settings } = fakeAiSettings();
  settings.webSearch = async ({ query }, signal) => {
    if (query === '坏') throw new Error('虚构的搜索失败');
    return new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => {
        cancelled = true;
        reject(new Error('aborted'));
      });
    });
  };
  try {
    const ctx = ctxOf({ ai: settings });
    await assert.rejects(async () => call('web.search', ctx, { queries: ['慢', '坏'] }, staff), /虚构的搜索失败/);
    assert.equal(cancelled, true);
  } finally {
    settings.close();
  }
});

test('web.search、web.read：所有登录账号能用；正文分段给、写明怎么接着读；没密钥把中文原因原样给出', async () => {
  const long = '虚'.repeat(WEB_READ_CHUNK + 500);
  const { settings } = fakeAiSettings({ pages: { 'https://example.com/fictional': { title: '虚构网页', content: long } } });
  const { settings: noKey } = fakeAiSettings({ saveKey: false });
  try {
    const ctx = ctxOf({ ai: settings });
    const found = z.looseObject({ 结果: z.array(z.looseObject({})) }).parse(await call('web.search', ctx, { queries: ['虚构纸箱'] }, staff));
    assert.deepEqual(found.结果[0], { 标题: '虚构搜索结果', 网址: 'https://example.com/fictional', 网站: '虚构站点', 摘要: '虚构的较长摘要' });
    const first = readPage.parse(await call('web.read', ctx, { url: 'https://example.com/fictional' }, staff));
    assert.equal(first.正文.length, WEB_READ_CHUNK);
    assert.equal(first.全文共几个字, long.length);
    assert.equal(first.还没读完, '还剩 500 字，接着读传 offset: ' + WEB_READ_CHUNK);
    const rest = readPage.parse(await call('web.read', ctx, { url: 'https://example.com/fictional', offset: WEB_READ_CHUNK }, staff));
    assert.equal(rest.正文.length, 500);
    assert.equal(rest.还没读完, undefined);
    await assert.rejects(async () => call('web.read', ctx, { url: 'http://localhost/x' }, staff), /./);
    await assert.rejects(async () => call('web.search', ctxOf({ ai: noKey }), { queries: ['虚构'] }, staff), /[一-龥]/);
    await assert.rejects(async () => call('web.search', ctx, { queries: ['虚构'] }, null), statusIs(401));
    await assert.rejects(async () => call('web.search', ctxOf(), { queries: ['虚构'] }, staff), /AI 设置还没接上/);
  } finally {
    settings.close();
    noKey.close();
  }
});

// 聊天里模型续参数被拒、没发联网请求，由 assistant-boundaries「界限 5」守
test('web.read 只开用户在这个会话里给的、或这个会话里搜索返回过的网址：模型自造的、在后面续参数的都拒绝；出纳一样', async () => {
  const f = assistantFixture();
  const { settings } = fakeAiSettings({
    pages: {
      'https://example.com/a': { title: '虚构网页甲', content: '虚构正文甲' },
      'https://example.com/fictional': { title: '虚构网页乙', content: '虚构正文乙' },
    },
  });
  try {
    const thread = f.manager.create(actor);
    f.manager.conversations.message(thread.id, 'user', '读一下 https://example.com/a 这个网页');
    noteSearchResult(f.store, thread.id, { 结果: [{ 网址: 'https://example.com/fictional' }] });
    const ctx = ctxOf({ ai: settings });
    const read = async (url: string, who: Actor) =>
      readAs(await webReaders['web.read'](ctx, { url }, who, 'web.read', { allowedUrl: (u) => allowedUrl(f.store, thread.id, u) }), {});
    for (const who of [staff, cashier]) {
      assert.equal((await read('https://example.com/a', who)).标题, '虚构网页甲');
      assert.equal((await read('https://example.com/fictional', who)).标题, '虚构网页乙');
      for (const url of ['https://collect.example/r?d=x', 'https://example.com/a?d=x', 'https://example.com/fictional/x'])
        await assert.rejects(async () => read(url, who), statusIs(403), url);
    }
    // 别的会话里说过的网址不算
    const other = f.manager.create(actor);
    assert.equal(allowedUrl(f.store, other.id, 'https://example.com/a'), null);
  } finally {
    settings.close();
    f.close();
  }
});

test('用户给的网址：中文紧挨着的、带中文路径的、协议大写的都认得出；后面续参数照旧拒绝', () => {
  const f = assistantFixture();
  try {
    const thread = f.manager.create(actor);
    for (const text of [
      '打开https://a.example.com/x看看价格',
      '看看https://user.example.com/p和https://two.example.com',
      '读一下 https://c.example.com/产品/列表 。',
      'HTTPS://Up.example.com/z 这个',
    ])
      f.manager.conversations.message(thread.id, 'user', text);
    const pick = (url: string) => allowedUrl(f.store, thread.id, url);
    for (const url of [
      'https://a.example.com/x',
      'https://user.example.com/p',
      'https://two.example.com',
      'https://c.example.com/产品/列表',
      'HTTPS://Up.example.com/z',
    ])
      assert.equal(pick(url), url, url);
    for (const url of ['https://a.example.com/x?d=1', 'https://a.example.com/x看看价格/y', 'https://two.example.com/z'])
      assert.equal(pick(url), null, url);
  } finally {
    f.close();
  }
});

test('用户给的网址截在主机名中间时不放行截出来的主机；汉字后面不是主机名延续的照旧能读', () => {
  const f = assistantFixture();
  try {
    const thread = f.manager.create(actor);
    for (const text of [
      '镜像在 https://github.com.镜像站.cn/repo 上',
      '邮箱 https://mail.qq.com.邮箱.中国',
      '看 https://github.com镜像.cn/x',
      '打开https://a.com看看价格',
      '看看https://a.com/p和https://b.com',
      '读一下 https://c.example.com/产品/列表',
    ])
      f.manager.conversations.message(thread.id, 'user', text);
    const pick = (url: string) => allowedUrl(f.store, thread.id, url);
    for (const url of ['https://github.com', 'https://mail.qq.com', 'https://mail.qq.com.']) assert.equal(pick(url), null, url);
    for (const url of [
      'https://a.com',
      'https://a.com/p',
      'https://b.com',
      'https://c.example.com/产品/列表',
      'https://github.com.镜像站.cn/repo',
    ])
      assert.equal(pick(url), url, url);
  } finally {
    f.close();
  }
});

test('读网页去掉 # 片段才对上也放行，但打开的永远是放行过的那条原样；换路径、加参数仍然拒绝', async () => {
  const f = assistantFixture();
  const { settings, fake } = fakeAiSettings({ pages: { 'https://example.com/a#1': { title: '虚构网页', content: '虚构正文' } } });
  try {
    const thread = f.manager.create(actor);
    noteSearchResult(f.store, thread.id, { 结果: [{ 网址: 'https://example.com/a#1' }] });
    const pick = (url: string) => allowedUrl(f.store, thread.id, url);
    assert.equal(pick('https://example.com/a#1'), 'https://example.com/a#1');
    assert.equal(pick('https://example.com/a'), 'https://example.com/a#1', '模型去掉了片段');
    assert.equal(pick('https://example.com/a#d=虚构客户甲'), 'https://example.com/a#1', '模型自己写的片段不带进去');
    for (const url of ['https://example.com/a?d=1', 'https://example.com/a/b', 'https://example.com/b#1']) assert.equal(pick(url), null, url);
    const ctx = ctxOf({ ai: settings });
    const read = async (url: string) => readAs(await webReaders['web.read'](ctx, { url }, staff, 'web.read', { allowedUrl: pick }), {});
    for (const url of ['https://example.com/a', 'https://example.com/a#d=虚构客户甲']) {
      const page = await read(url);
      assert.equal(page.标题, '虚构网页');
      assert.equal(page.网址, 'https://example.com/a#1');
      assert.equal(fake.calls.findLast((c) => c.path === '/v1/tools/fetch')?.body.url, 'https://example.com/a#1');
    }
    await assert.rejects(async () => read('https://example.com/a?d=1'), statusIs(403));
  } finally {
    settings.close();
    f.close();
  }
});

test('联网命令的结果进对话时不截（直接调和经 run_command 调都一样）：读网页 2 万字、10 条 800 字的搜索结果原样给模型', async () => {
  const page = '虚'.repeat(WEB_READ_CHUNK + 300);
  const f = assistantFixture(
    [
      { message: '', toolCalls: [{ name: 'web.search', args: { queries: ['虚构纸价'] } }] },
      { message: '', toolCalls: [{ name: 'run_command', args: { name: 'web.read', args: { url: 'https://example.com/long' } } }] },
      { message: '虚构的回答。', toolCalls: [] },
    ],
    { agent: { session: { toolResultTokens: 500 } } },
  );
  const { settings } = fakeAiSettings({
    search: (q) => hits(q, 10, '虚'.repeat(900)),
    pages: { 'https://example.com/long': { title: '虚构长网页', content: page } },
  });
  try {
    f.manager.tools.connect({ ai: settings });
    const thread = f.manager.create(actor);
    await f.manager.chat(thread.id, f.input('读一下 https://example.com/long 再搜搜纸价', randomUUID()), actor, 's', () => {}, () => actor);
    const calls = f.requests.map((c) => ({ body: c.body }));
    const found = readAs(toolResultSent(calls, 'web.search'), { 结果: z.array(z.looseObject({ 摘要: z.string() })) });
    assert.equal(found.结果.length, 10);
    assert.equal(found.结果[9].摘要.length, WEB_SEARCH.summaryChars);
    const read = readAs(toolResultSent(calls, 'web.read'), { 正文: z.string(), 还没读完: z.string() });
    assert.equal(read.正文.length, WEB_READ_CHUNK);
    assert.equal(read.还没读完, '还剩 300 字，接着读传 offset: ' + WEB_READ_CHUNK);
  } finally {
    settings.close();
    f.close();
  }
});
