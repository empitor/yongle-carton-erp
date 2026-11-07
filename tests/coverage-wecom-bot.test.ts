import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/db.js';
import { InboxService } from '../server/inbox/service.js';
import { WecomBotConnection } from '../server/inbox/wecom-bot.js';

function setup(fetchImpl: typeof fetch = async () => assert.fail('不应尝试下载')) {
  const store = new Store(':memory:'), inbox = new InboxService(store);
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    readyState = 0;
    sent: { cmd: string; headers: { req_id: string }; body?: { stream?: { content: string } } }[] = [];
    constructor() {
      super();
      sockets.push(this);
    }
    send(frame: string) {
      this.sent.push(JSON.parse(frame));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
    frame(data: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
    accept() {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      this.frame({ headers: this.sent[0].headers, errcode: 0 });
    }
  }
  const bot = new WecomBotConnection({
    credentials: () => ({ botId: 'fictional-bot', secret: 'fictional-secret' }),
    ingest: (input) => inbox.ingest(input), exists: (channel, id) => inbox.has(channel, id),
    WebSocketImpl: Socket as unknown as typeof WebSocket,
    fetchImpl, checkHost: async () => '203.0.114.1', sleep: async () => {}, heartbeatMs: 25,
  });
  const text = (socket: Socket, id: string) => socket.frame({
    cmd: 'aibot_msg_callback', headers: { req_id: id },
    body: { msgid: id, msgtype: 'text', text: { content: '虚构消息' } },
  });
  return { bot, inbox, sockets, text, close() { bot.stop(); store.close(); } };
}

test('企微心跳丢失后退避重连，旧连接消息无效，新连接可保存', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = setup();
  try {
    f.bot.start();
    const first = f.sockets[0];
    first.accept();
    t.mock.timers.tick(25);
    assert.equal(first.sent[1].cmd, 'ping');
    first.frame({ headers: first.sent[1].headers, errcode: 0 });
    for (let i = 0; i < 10 && f.bot.status().state === 'connected'; i++) t.mock.timers.tick(25);
    assert.equal(f.bot.status().state, 'retrying');
    assert.match(f.bot.status().lastError, /心跳/);
    t.mock.timers.tick(999);
    assert.equal(f.sockets.length, 1);
    t.mock.timers.tick(1);
    assert.equal(f.sockets.length, 2);
    const next = f.sockets[1];
    next.accept();
    f.text(first, 'stale-socket');
    f.text(next, 'active-socket');
    await f.bot.idle();
    assert.equal(f.inbox.has('wecom_bot', 'stale-socket'), false);
    assert.equal(f.inbox.has('wecom_bot', 'active-socket'), true);
    assert.equal(next.sent.at(-1)?.headers.req_id, 'active-socket');
    f.bot.stop();
    t.mock.timers.tick(60_000);
    assert.equal(f.sockets.length, 2);
    assert.equal(f.bot.status().state, 'off');
  } finally {
    f.close();
  }
});

test('旧企微连接的下载结束后，回复不应发到新连接', async () => {
  let start!: () => void, finish!: (response: Response) => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const download = new Promise<Response>((resolve) => { finish = resolve; });
  const f = setup(async () => { start(); return download; });
  try {
    f.bot.start();
    const first = f.sockets[0];
    first.accept();
    first.frame({
      cmd: 'aibot_msg_callback', headers: { req_id: 'old-request' },
      body: { msgid: 'old-message', msgtype: 'file', file: { url: 'https://fixture.invalid/file', aeskey: 'fictional' } },
    });
    await started;
    f.bot.start();
    const next = f.sockets[1];
    next.accept();
    finish(new Response(null, { status: 404 }));
    await f.bot.idle();
    assert.equal(next.sent.some((frame) => frame.cmd === 'aibot_respond_msg' && frame.headers.req_id === 'old-request'), false);
  } finally {
    finish(new Response(null, { status: 404 }));
    f.close();
  }
});
