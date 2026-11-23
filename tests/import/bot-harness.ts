/**
 * 机器人测试的准备代码：手拨的计时器（退避、心跳不真等）、等条件成立、企业微信的假套接字，
 * 以及连本机假服务端（bot-fakes.ts）的一条连接。凭据都是虚构的。
 */
import { z } from 'zod';
import { Store } from '../../server/core/index.js';
import { InboxService } from '../../server/inbox/service.js';
import { BotConnection, type BotTimers } from '../../server/inbox/bots/connection.js';
import type { BotCredentials, BotProtocol, ProtocolDeps } from '../../server/inbox/bots/protocol.js';
import { startFakeBots } from './bot-fakes.js';
import { FAKE_APP } from './bot-fakes-http.js';

/** 等真实的网络往返（本机假服务端）把条件变成真。 */
export async function until(check: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('等不到：' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 只给连接用的计时器：不会自己走，advance 拨多少就跑到点的那些。 */
export function manualTimers() {
  let now = 0,
    seq = 0;
  const jobs = new Map<number, { at: number; every: number; fn: () => void }>();
  const add = (fn: () => void, ms: number, every = 0) => (jobs.set(++seq, { at: now + ms, every, fn }), seq);
  const clear = (id: unknown) => void (typeof id === 'number' && jobs.delete(id));
  const timers: BotTimers = {
    setTimeout: (fn: () => void, ms: number) => add(fn, ms),
    setInterval: (fn: () => void, ms: number) => add(fn, ms, ms),
    clearTimeout: clear,
    clearInterval: clear,
  };
  return {
    timers,
    /** 还排着的计时器（退避、心跳、认证超时）个数；0 说明不会再自己重连。 */
    pending: () => jobs.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, job] = due;
        now = job.at;
        if (job.every) job.at += job.every;
        else jobs.delete(id);
        job.fn();
      }
      now = end;
    },
  };
}

/** 连接发给企业微信的一帧：命令、请求编号，回复的正文在 body.stream */
const wecomSentSchema = z.looseObject({
  cmd: z.string(),
  headers: z.looseObject({ req_id: z.string() }),
  body: z
    .looseObject({ stream: z.looseObject({ content: z.string().optional(), finish: z.boolean().optional() }).optional() })
    .optional(),
});
type WecomSent = z.output<typeof wecomSentSchema>;

type SocketListener = (event: { data: unknown }) => void;
/**
 * 企业微信的假套接字：测试手动 accept、发帧、断开。监听的写法和连接要的套接字一样
 * （open、error、close 不带参数，message 收 { data }），可以直接当 WebSocketImpl 交给连接。
 */
export class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: WecomSent[] = [];
  private listeners = new Map<string, SocketListener[]>();
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: SocketListener): void;
  addEventListener(type: string, listener: SocketListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  private emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send(text: string) {
    this.sent.push(wecomSentSchema.parse(JSON.parse(text)));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  frame(value: unknown) {
    this.emit('message', JSON.stringify(value));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  /** 打开并回订阅成功。 */
  accept() {
    this.open();
    this.frame({ headers: { req_id: this.sent[0].headers.req_id }, errcode: 0, errmsg: 'ok' });
  }
}

/** 一家机器人连本机假服务端：收件箱是 :memory: 库，计时器手拨。 */
export async function botHarness(protocol: (deps: ProtocolDeps) => BotProtocol, wrapFetch?: (f: typeof fetch) => typeof fetch) {
  const fake = await startFakeBots();
  const store = new Store(':memory:'),
    inbox = new InboxService(store),
    clock = manualTimers();
  const fetchImpl = wrapFetch ? wrapFetch(fake.fetchImpl) : fake.fetchImpl;
  /** 另开一条连接：换凭据，或换发请求的函数（模拟网络不通）。 */
  const connection = (credentials: BotCredentials = FAKE_APP, fetchOther = fetchImpl) =>
    new BotConnection(protocol({ fetchImpl: fetchOther, checkHost: fake.checkHost }), {
      credentials: () => credentials,
      ingest: (incoming) => inbox.ingest(incoming),
      exists: (channel, id) => inbox.has(channel, id),
      WebSocketImpl: fake.WebSocketImpl,
      sleep: async () => {},
      timers: clock.timers,
    });
  const bot = connection();
  return {
    fake,
    inbox,
    bot,
    clock,
    connection,
    items: () => inbox.list({}, {}).rows,
    connect: async () => {
      bot.start();
      await until(() => bot.status().state === 'connected', '连上' + bot.protocol.name);
    },
    close: async () => (bot.stop(), await fake.close(), store.close()),
  };
}
