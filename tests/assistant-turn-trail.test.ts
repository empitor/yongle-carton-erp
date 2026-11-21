// 一轮对话给页面看的过程（chat/turn-trail.ts）：状态行的叫法（tool 事件的 label，出卡片的写“准备确认卡片”）、
// 先说的话（said 事件、存进回复的 interim，全文不限段数）、联网来源（sources：只收 http/https、网址存原样、按去掉 # 片段去重、
// 读过的在前）。假 DeepSeek、内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isWebLink } from '../shared/assistant/index.js';
import { noteSources, trailOf } from '../server/assistant/chat/turn-trail.js';
import type { ChatRun } from '../server/assistant/chat/run-state.js';
import { WEB_SEARCH } from '../server/assistant/tools/web.js';
import { assistantFixture, scriptModel } from './assistant-fixture.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { actor } from './actor-fixture.js';

const sourcesOf = (calls: [string, unknown][]) => {
  const run: Pick<ChatRun, 'sources' | 'interim'> = { sources: new Map(), interim: [] };
  for (const [name, result] of calls) noteSources(run, name, result);
  return trailOf(run).sources;
};

test('页面看得到过程：tool 事件带叫法；先说的话发 said、存进 interim；搜到和读过的存进 sources（读过的在前、非 http 的不进）', async () => {
  const f = assistantFixture([
    {
      message: '我先上网查一下最近的纸价。',
      toolCalls: [{ name: 'web.search', args: { queries: ['虚构瓦楞纸价格', '虚构箱板纸行情'] } }],
    },
    { message: '', toolCalls: [{ name: 'web.read', args: { url: 'https://example.com/b' } }] },
    { message: '虚构的回答：纸价持平。', toolCalls: [] },
  ], {
    web: {
      search: (q) =>
        q === '虚构瓦楞纸价格'
          ? [
              { title: '虚构甲', url: 'https://example.com/a', snippet: '甲', site_name: '虚构站点甲', date: '2026-11-01' },
              { title: '坏链接', url: 'javascript:alert(1)', snippet: '坏' },
            ]
          : [{ title: '虚构乙', url: 'https://example.com/b', snippet: '乙', site_name: '虚构站点乙', date: null }],
      pages: { 'https://example.com/b': { title: '虚构乙全文', content: '虚构正文' } },
    },
  });
  const events: [string, unknown][] = [];
  try {
    const thread = f.manager.create(actor);
    const view = await f.manager.chat(
      thread.id,
      f.input('最近瓦楞纸价格怎么样', randomUUID()),
      actor,
      's',
      (event, data) => events.push([event, data]),
      () => actor,
    );
    const tools = events.filter(([e]) => e === 'tool').map(([, d]) => d);
    assert.deepEqual(tools[0], { name: 'web.search', state: 'running', label: '联网搜索：虚构瓦楞纸价格、虚构箱板纸行情' });
    assert.deepEqual(tools[2], { name: 'web.read', state: 'running', label: '读网页：example.com/b' });
    const said = events.find(([e]) => e === 'said');
    assert.ok(said, '发了 said 事件');
    assert.equal(field(said[1], 'text'), '我先上网查一下最近的纸价。');
    const last = view.messages.at(-1);
    assert.ok(last, '有回复');
    assert.equal(last.text, '虚构的回答：纸价持平。');
    assert.deepEqual(last.interim?.map((p) => p.text), ['我先上网查一下最近的纸价。']);
    // 网站名是搜索接口给的外来文字，不进来源（页面写网址的真实主机）
    assert.deepEqual(last.sources, [
      { title: '虚构乙全文', url: 'https://example.com/b', read: true },
      { title: '虚构甲', url: 'https://example.com/a', date: '2026-11-01' },
    ]);
    // 给模型的历史不动：先说的那句本来就在原样记录的助手消息里
    const sent = JSON.stringify(f.requests.at(-1)?.body.messages);
    assert.equal(sent.split('我先上网查一下最近的纸价。').length - 1, 1);
  } finally {
    f.close();
  }
});

test('先说的话存全文、不限段数（和生成时页面上看到的一样）；出错收尾也存下先说的话和来源', async () => {
  const f = assistantFixture();
  let n = 0;
  // 只第一段联网：搜索限速每秒 5 个，8 次都搜会白等一秒
  scriptModel(f.settings, () => {
    if (++n > 8) throw new Error('虚构的接口故障');
    if (n === 1) return { message: '虚'.repeat(600), toolCalls: [{ name: 'web.search', args: { queries: ['虚构'] } }] };
    return { message: '第' + n + '段', toolCalls: [{ name: 'records.search', args: { module: 'customers' } }] };
  });
  const said: string[] = [];
  try {
    const thread = f.manager.create(actor);
    await assert.rejects(
      f.manager.chat(thread.id, f.input('虚构的问题', randomUUID()), actor, 's', (e, d) => e === 'said' && said.push(String(field(d, 'text'))), () => actor),
    );
    const last = f.manager.view(thread.id, actor).messages.at(-1);
    assert.ok(last, '出错的那一轮也存了回复');
    assert.equal(last.error, true);
    assert.ok(last.interim, '存了先说的话');
    assert.deepEqual(last.interim.map((p) => p.text), said);
    assert.equal(last.interim.length, 8);
    assert.equal(last.interim[0].text, '虚'.repeat(600));
    assert.deepEqual(last.sources?.map((s) => s.url), ['https://example.com/fictional']);
  } finally {
    f.close();
  }
});

test('来源去掉 # 片段后按网址去重，链接用先出现的那条原样；读过的同一网页并进去', () => {
  assert.deepEqual(
    sourcesOf([
      ['web.search', { 结果: [{ 标题: '虚构甲', 网址: 'https://example.com/p#1' }, { 标题: '虚构甲（又一条）', 网址: 'https://example.com/p#2' }, { 标题: '虚构乙', 网址: 'https://example.com/q' }] }],
      ['web.read', { 标题: '虚构甲全文', 网址: 'https://example.com/p' }],
    ]),
    [
      { title: '虚构甲全文', url: 'https://example.com/p#1', read: true },
      { title: '虚构乙', url: 'https://example.com/q' },
    ],
  );
});

test('来源的网址存原样不转码，超过 2000 字的不收；标题最多 200 字；只收 http、https', () => {
  const chinese = 'https://example.com/产品/列表';
  const sources = sourcesOf([
    [
      'web.search',
      {
        结果: [
          { 标题: '题'.repeat(300), 网址: chinese },
          { 标题: '太长', 网址: 'https://example.com/' + 'x'.repeat(2000) },
          { 标题: '坏', 网址: 'javascript:alert(1)' },
          { 标题: '坏', 网址: 'data:text/html,<b>x</b>' },
        ],
      },
    ],
  ]);
  assert.ok(sources, '收到了来源');
  assert.deepEqual(sources.map((s) => s.url), [chinese]);
  assert.equal([...sources[0].title].length, WEB_SEARCH.titleChars);
  for (const url of ['https://a.example.com/x', 'HTTP://a.example.com']) assert.equal(isWebLink(url), true, url);
  for (const url of ['javascript:alert(1)', 'ftp://a.example.com', '不是网址', 'https://a.example.com/' + 'x'.repeat(2000)])
    assert.equal(isWebLink(url), false, url);
});

test('状态行：只出确认卡片的命令写“准备确认卡片：……”，只读的和直接执行的照常写叫法', async () => {
  const f = assistantFixture([
    {
      message: '',
      toolCalls: [
        { name: 'records.search', args: { module: 'customers' } },
        { name: 'records.propose_save', args: { module: 'customers', patch: { name: '虚构状态行客户' } } },
        { name: 'memory.save', args: { content: '我说的大箱指的是虚构产品 A-200' } },
      ],
    },
    { message: '好的。', toolCalls: [] },
  ]);
  const events: [string, unknown][] = [];
  try {
    const thread = f.manager.create(actor);
    await f.manager.chat(thread.id, f.input('虚构的问题', randomUUID()), actor, 's', (e, d) => events.push([e, d]), () => actor);
    const labels = events.filter(([e, d]) => e === 'tool' && field(d, 'state') === 'running').map(([, d]) => field(d, 'label'));
    assert.deepEqual(labels, ['查业务记录列表', '准备确认卡片：新建或修改记录', '记住']);
  } finally {
    f.close();
  }
});
