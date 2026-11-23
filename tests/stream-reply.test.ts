// 流式回复的写出（server/core/http/stream.ts）和读取（src/ui/event-stream.ts）：用假连接、假计时器，不起服务、不真等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { openEventStream, pipeBytes } from '../server/core/index.js';
import { STREAM_HEARTBEAT_MS, STREAM_LATEST_MS } from '../server/core/http/stream.js';
import { readEventStream } from '../src/ui/event-stream.js';

/** 假请求：只记下设的超时 */
class FakeRequest extends IncomingMessage {
  readonly timeouts: number[];
  constructor(timeouts: number[]) {
    super(new Socket());
    this.timeouts = timeouts;
  }
  override setTimeout(ms: number) {
    this.timeouts.push(ms);
    return this;
  }
}

/** 假响应：记下写出的每一段和响应头，不碰网络；write 返回 full() 的反面，模拟写缓冲满了 */
class FakeResponse extends ServerResponse {
  override destroyed = false;
  override writableEnded = false;
  override headersSent = false;
  readonly out: (string | number[])[] = [];
  readonly headers: Record<string, string> = {};
  readonly full: () => boolean;
  readonly timeouts: number[];
  constructor(req: FakeRequest, full: () => boolean) {
    super(req);
    this.full = full;
    this.timeouts = req.timeouts;
  }
  override setHeader(name: string, value: number | string | readonly string[]) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }
  override flushHeaders() {
    this.headersSent = true;
  }
  override setTimeout(ms: number) {
    this.timeouts.push(ms);
    return this;
  }
  override write(chunk: string | Uint8Array, done?: BufferEncoding | ((error?: Error | null) => void)) {
    this.headersSent = true;
    this.out.push(typeof chunk === 'string' ? chunk : [...chunk]);
    if (typeof done === 'function') done(null);
    return !this.full();
  }
  override end() {
    this.writableEnded = true;
    return this;
  }
  override destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

/** 假连接：请求和响应共用一份超时记录 */
function connection(full = () => false) {
  const timeouts: number[] = [];
  const req = new FakeRequest(timeouts);
  const res = new FakeResponse(req, full);
  return { req, res, out: res.out, headers: res.headers, timeouts };
}
/** 写出的事件，按“名字 data”列出；心跳记成 heartbeat */
const events = (out: unknown[]) =>
  out.map((s) => (s === ': heartbeat\n\n' ? 'heartbeat' : String(s).replace(/^event: (\S+)\ndata: (.*)\n\n$/, '$1 $2')));

test('事件流：发响应头和超时，一条写成 event、data 加空行，每 10 秒一行心跳注释，收尾后不再写', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const c = connection();
  const stream = openEventStream(c.req, c.res, { timeoutMs: 1234 });
  assert.deepEqual(c.timeouts, [1234, 1234]);
  assert.equal(c.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(c.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(c.headers['x-accel-buffering'], 'no', '代理不攒着');
  stream.send('tool', { label: '虚构命令' });
  assert.equal(c.out[0], 'event: tool\ndata: {"label":"虚构命令"}\n\n');
  t.mock.timers.tick(STREAM_HEARTBEAT_MS * 2);
  stream.end('result', { ok: true });
  t.mock.timers.tick(STREAM_HEARTBEAT_MS * 3);
  assert.deepEqual(events(c.out), ['tool {"label":"虚构命令"}', 'heartbeat', 'heartbeat', 'result {"ok":true}']);
  assert.equal(c.res.writableEnded, true);
});

test('只算最新一条的事件：同一段 250 毫秒内攒着、新的替掉旧的，到点写出；换段、别的事件、收尾前先写出攒着的', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const c = connection();
  const stream = openEventStream<Record<string, unknown>>(c.req, c.res, {
    timeoutMs: 1000,
    latest: { progress: (d) => d.stage, draft: () => 'draft' },
  });
  const progress = (stage: string, n?: number) => stream.send('progress', { stage, n });
  progress('receiving', 1);
  progress('receiving', 2);
  progress('receiving', 3);
  assert.equal(c.out.length, 1, '同一段里没到点的先攒着');
  t.mock.timers.tick(STREAM_LATEST_MS);
  progress('receiving', 4);
  progress('validating');
  stream.send('draft', { text: '虚' });
  stream.send('draft', { text: '虚构' });
  stream.send('said', { text: '先说一句' });
  stream.send('draft', { text: '虚构回复' });
  stream.send('draft', { text: '虚构回复全文' });
  stream.end('result', { ok: true });
  assert.deepEqual(events(c.out), [
    'progress {"stage":"receiving","n":1}',
    'progress {"stage":"receiving","n":3}',
    'progress {"stage":"receiving","n":4}',
    'progress {"stage":"validating"}',
    'draft {"text":"虚"}',
    'draft {"text":"虚构"}',
    'said {"text":"先说一句"}',
    'draft {"text":"虚构回复全文"}',
    'result {"ok":true}',
  ]);
});

test('事件流断开：回完之前断了调一次 onLost、之后不再写；回完以后再断不算', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  let lost = 0;
  const c = connection();
  const stream = openEventStream(c.req, c.res, { timeoutMs: 1000, onLost: () => lost++ });
  c.res.destroy();
  c.res.emit('close');
  stream.send('progress', { stage: 'receiving' });
  t.mock.timers.tick(STREAM_HEARTBEAT_MS);
  stream.end('error', { message: '已停止回复。' });
  assert.equal(lost, 1);
  assert.deepEqual(c.out, []);
  const done = connection();
  openEventStream(done.req, done.res, { timeoutMs: 1000, onLost: () => lost++ }).end('result', {});
  done.res.emit('close');
  assert.equal(lost, 1, '正常结束不算断开');
});

/** 上游的字节流：chunks 一块块给；fail 在给完以后报错；hang 给完以后一直不结束，直到被取消 */
function upstream(chunks: number[][], end: 'close' | 'fail' | 'hang' = 'close') {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks.shift();
      if (next) return c.enqueue(new Uint8Array(next));
      if (end === 'close') return c.close();
      if (end === 'fail') return c.error(new Error('虚构的上游断开'));
      return new Promise(() => {});
    },
    cancel: () => void (state.cancelled = true),
  });
  return { body, state };
}
const tick = () => new Promise((r) => setImmediate(r));

test('边收边写字节：第一块到了才发响应头，写缓冲满了等它腾出来，写完收尾', async () => {
  let full = true;
  const c = connection(() => full);
  const { body } = upstream([[1, 2], [3]]);
  const piping = pipeBytes(c.res, body, new AbortController().signal, { 'Content-Type': 'audio/pcm' });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(c.out, [[1, 2]], '缓冲满了，下一块等着');
  assert.equal(c.headers['content-type'], 'audio/pcm');
  full = false;
  c.res.emit('drain');
  await piping;
  assert.deepEqual(c.out, [[1, 2], [3]]);
  assert.equal(c.res.writableEnded, true);
});

test('边收边写字节出错：第一块之前出错原样抛出、还没发响应头；开始写以后出错断开连接；取消就停读上游', async () => {
  const early = connection();
  await assert.rejects(pipeBytes(early.res, upstream([], 'fail').body, new AbortController().signal, {}), /虚构的上游断开/);
  assert.equal(early.res.headersSent, false, '还能回一句中文说明');
  const late = connection();
  await pipeBytes(late.res, upstream([[1]], 'fail').body, new AbortController().signal, {});
  assert.deepEqual([late.out, late.res.destroyed], [[[1]], true]);
  const stopped = connection();
  const page = new AbortController();
  const hanging = upstream([[1]], 'hang');
  const piping = pipeBytes(stopped.res, hanging.body, page.signal, {});
  for (let i = 0; i < 5; i++) await tick();
  page.abort();
  await piping;
  assert.deepEqual([hanging.state.cancelled, stopped.res.destroyed], [true, true]);
});

/** 一个响应：text 按字节在 cuts 处切开分块到达（可以切在汉字中间） */
function response(text: string, cuts: number[] = []) {
  const bytes = new TextEncoder().encode(text);
  const edges = [0, ...cuts, bytes.length];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 1; i < edges.length; i++) c.enqueue(bytes.slice(edges[i - 1], edges[i]));
        c.close();
      },
    }),
  );
}
const LOST = '虚构的中断说法';
/** 抛出的是带这句说明和错误码的错误 */
const failed = (message: string, code: string) => (e: unknown) =>
  e instanceof Error && e.message === message && 'code' in e && e.code === code;

test('读事件流：事件和汉字跨块也拼得起来，心跳注释跳过，data 解析后交出，返回 result', async () => {
  const wire = 'event: draft\ndata: {"text":"纸箱"}\n\n: heartbeat\n\nevent: progress\ndata: {"stage":"receiving"}\n\nevent: result\ndata: {"id":"t1"}\n\n';
  const seen: unknown[] = [];
  const result = await readEventStream(response(wire, [8, 27, 30, 61]), (event, data) => seen.push([event, data]), LOST);
  assert.deepEqual(result, { id: 't1' });
  assert.deepEqual(seen, [
    ['draft', { text: '纸箱' }],
    ['progress', { stage: 'receiving' }],
    ['result', { id: 't1' }],
  ]);
});

test('读事件流出错：error 事件交出后抛服务器的说明和错误码；没收到 result、网断、没有正文按调用方的说法；主动停止原样抛出', async () => {
  const seen: string[] = [];
  await assert.rejects(
    readEventStream(response('event: error\ndata: {"message":"余额不足","code":"quota"}\n\n'), (e) => seen.push(e), LOST),
    failed('余额不足', 'quota'),
  );
  assert.deepEqual(seen, ['error'], '页面先按 error 收拾（比如丢掉半截字）');
  const lost = failed(LOST, 'network');
  await assert.rejects(readEventStream(response('event: progress\ndata: {}\n\n'), () => {}, LOST), lost);
  await assert.rejects(readEventStream(new Response(null), () => {}, LOST), lost);
  const broken = (name: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw Object.assign(new Error('network error'), { name });
        },
      }),
    );
  await assert.rejects(readEventStream(broken('TypeError'), () => {}, LOST), lost);
  await assert.rejects(readEventStream(broken('AbortError'), () => {}, LOST), { name: 'AbortError' });
});
