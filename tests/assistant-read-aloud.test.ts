// 读出来：按消息编号由服务端取文字、交给假 DeepSeek 合成，音频流转给浏览器。不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/index.js';
import { clipForSpeech, messageForSpeech } from '../server/assistant/speech-text.js';
import { jsonResponse } from './fake-deepseek-wire.js';
import { speechServer } from './speech-fixture.js';
import { readAs } from './read-result.js';

const now = '2026-11-13T08:00:00.000Z';
const messageOf = async (response: Response) => readAs(await response.json(), { message: z.string() }).message;
/** 直接往库里放一个会话和几条消息（虚构内容） */
function seed(db: DatabaseSync, userId: string, threadId: string, messages: { id: string; role: string; text: string; document?: object }[]) {
  db.prepare('INSERT INTO assistant_threads(id,user_id,title,created_at,updated_at,document) VALUES(?,?,?,?,?,?)').run(threadId, userId, '虚构会话', now, now, '{}');
  for (const m of messages)
    db.prepare('INSERT INTO assistant_messages(id,thread_id,role,created_at,text,document) VALUES(?,?,?,?,?,?)').run(
      m.id, threadId, m.role, now, m.text, JSON.stringify(m.document || {}),
    );
}

test('朗读的文字：只取自己会话里助手的回复（含另一位补的话），别人的、用户自己的、空的都拒绝', () => {
  const store = new Store(':memory:');
  try {
    seed(store.db, '甲', 't1', [
      { id: 'u1', role: 'user', text: '查一下虚构客户的订单' },
      { id: 'a1', role: 'assistant', text: '虚构客户有两张订单。', document: { relay: [{ speaker: 'le', text: '库存够发。' }, { bad: 1 }] } },
      { id: 'a2', role: 'assistant', text: '   ' },
    ]);
    seed(store.db, '乙', 't2', [{ id: 'b1', role: 'assistant', text: '乙的回复' }]);
    assert.equal(messageForSpeech(store.db, 't1', 'a1', '甲'), '虚构客户有两张订单。\n库存够发。');
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        assert.ok(e instanceof AppError);
        return [e.status, e.message];
      }
      return null;
    };
    assert.equal(code(() => messageForSpeech(store.db, 't2', 'b1', '甲'))?.[0], 404);
    assert.equal(code(() => messageForSpeech(store.db, 't1', 'b1', '甲'))?.[0], 404);
    assert.deepEqual(code(() => messageForSpeech(store.db, 't1', 'u1', '甲')), [400, '只能朗读助手的回复。']);
    assert.equal(code(() => messageForSpeech(store.db, 't1', 'a2', '甲'))?.[0], 422);
  } finally {
    store.close();
  }
});

test('朗读的文字太长：按计费字符（汉字算 2 个）截到上限内最后一个句末，没有句末就硬截', () => {
  assert.equal(clipForSpeech('一二三。四五六。', 100), '一二三。四五六。');
  assert.equal(clipForSpeech('一二三。四五六七八九十。', 16), '一二三。');
  assert.equal(clipForSpeech('abc. defgh', 8), 'abc.');
  assert.equal(clipForSpeech('一二三四五六', 7), '一二三');
  assert.equal(clipForSpeech('ab😀cd', 4), 'ab😀');
  const long = '虚构的一句话。'.repeat(1000);
  const clipped = clipForSpeech(long);
  assert.ok(clipped.endsWith('。'));
  assert.ok([...clipped].length * 2 <= 10_000);
});

test('朗读接口：取消息文字交给 DeepSeek（女声、裸 PCM），音频原样流回；别人的消息、传任意文字都拒绝', async () => {
  const s = await speechServer();
  try {
    seed(s.store.db, s.actorId, 'own', [
      { id: 'q', role: 'user', text: '问题' },
      { id: 'r', role: 'assistant', text: '虚构回复，**加粗**也交给 DeepSeek 过滤。' },
    ]);
    seed(s.store.db, 'someone-else', 'other', [{ id: 'x', role: 'assistant', text: '别人的回复' }]);
    const ok = await s.send('/speak', { threadId: 'own', messageId: 'r' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/pcm; rate=24000');
    assert.equal(ok.headers.get('x-audio-sample-rate'), '24000');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const bytes = new Uint8Array(await ok.arrayBuffer());
    assert.equal(bytes.length, 4800);
    assert.ok(bytes.every((b, i) => b === i % 251));
    const tts = s.fake.calls.filter((c) => c.path === '/v1/tools/tts');
    assert.equal(tts.length, 1);
    assert.deepEqual(
      { text: tts[0].body.text, voice: tts[0].body.voice_id, format: tts[0].body.format },
      { text: '虚构回复，**加粗**也交给 DeepSeek 过滤。', voice: 'stella', format: 'pcm' },
    );
    assert.equal((await s.send('/speak', { threadId: 'other', messageId: 'x' })).status, 404);
    assert.equal((await s.send('/speak', { threadId: 'own', messageId: 'q' })).status, 400);
    assert.equal((await s.send('/speak', { threadId: 'own', messageId: 'r', text: '任意文字' })).status, 400);
    assert.equal((await s.send('/speak', { threadId: 'own', messageId: 'r' }, { csrf: false })).status, 403);
    assert.equal(s.fake.calls.filter((c) => c.path === '/v1/tools/tts').length, 1);
    // 拿到音频之前出错：说中文原因
    s.fake.next('/v1/tools/tts', jsonResponse({ error: { message: 'Insufficient Balance' } }, 402));
    const poor = await s.send('/speak', { threadId: 'own', messageId: 'r' });
    assert.equal(poor.status, 422);
    assert.match(await messageOf(poor), /余额不足/);
    s.fake.next('/v1/tools/tts', jsonResponse({ error: { message: 'bad text' } }, 400));
    assert.match(await messageOf(await s.send('/speak', { threadId: 'own', messageId: 'r' })), /读不出来/);
    // 第一块音频之前就断了：还没发响应头，回中文说明
    s.fake.next('/v1/tools/tts', s.fake.brokenStream(['abcd', 'efgh'], 0));
    const early = await s.send('/speak', { threadId: 'own', messageId: 'r' });
    assert.equal(early.status, 502);
    assert.match(await messageOf(early), /朗读中途断了，请再点一次/);
    // 已经开始流音频以后上游断了：只能断开连接，浏览器读不完整（页面按“朗读中途断了”提示）
    s.fake.next('/v1/tools/tts', () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(new Uint8Array([1, 2, 3, 4])),
          pull: (c) => c.error(new TypeError('terminated')),
        }),
        { status: 200, headers: { 'content-type': 'audio/pcm' } },
      ),
    );
    const broken = await s.send('/speak', { threadId: 'own', messageId: 'r' });
    assert.equal(broken.status, 200);
    await assert.rejects(broken.arrayBuffer());
  } finally {
    await s.close();
  }
});

test('朗读：浏览器停止就取消上游；同一账号点下一条，上一条的上游也停掉', async () => {
  const cancelled: string[] = [];
  let opened = 0;
  const s = await speechServer({
    wrap: (inner) => async (req) => {
      if (new URL(req.url).pathname !== '/v1/tools/tts') return inner(req);
      const body = readAs(await req.clone().json(), { text: z.string() });
      if (body.text === '第三条') return inner(req);
      opened++;
      // 先吐一块，之后一直不结束，直到被取消
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(new Uint8Array([1, 0, 2, 0])),
          pull: () => new Promise(() => {}),
          cancel: () => void cancelled.push(body.text),
        }),
        { status: 200, headers: { 'content-type': 'audio/pcm' } },
      );
    },
  });
  try {
    seed(s.store.db, s.actorId, 'own', [
      { id: 'm1', role: 'assistant', text: '第一条' },
      { id: 'm2', role: 'assistant', text: '第二条' },
      { id: 'm3', role: 'assistant', text: '第三条' },
    ]);
    const browser = new AbortController();
    const first = await s.send('/speak', { threadId: 'own', messageId: 'm1' }, { signal: browser.signal });
    assert.ok(first.body);
    const reader = first.body.getReader();
    const chunk = await reader.read();
    assert.ok(!chunk.done);
    assert.deepEqual([...chunk.value], [1, 0, 2, 0]);
    browser.abort();
    await waitFor(() => cancelled.includes('第一条'));
    const second = await s.send('/speak', { threadId: 'own', messageId: 'm2' });
    assert.ok(second.body);
    await second.body.getReader().read();
    const third = await s.send('/speak', { threadId: 'own', messageId: 'm3' });
    assert.equal(third.status, 200);
    assert.equal((await third.arrayBuffer()).byteLength, 4800);
    await waitFor(() => cancelled.includes('第二条'));
    assert.equal(opened, 2);
  } finally {
    await s.close();
  }
});

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), '等待超时');
}
