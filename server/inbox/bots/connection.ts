/**
 * 一家机器人的长连接：启停、状态、认证超时、心跳、退避重连，收到的消息按顺序放进收件箱再回执。
 * 三家共用这一份，每家的协议细节在 BotProtocol 里（wecom.ts 等）。
 */
// Node 自带的 WebSocket 连企业微信会被返回 404（2026-11 实测），官方 SDK 也用 ws。
import NodeWebSocket from 'ws';
import { errorMessage } from '../../../shared/core/index.js';
import type { BotState, BotStatus, InboxChannel, InboxIncoming } from '../../../shared/import/index.js';
import { storeMessage } from './inbound.js';
import { BotAuthError, BotFailure, type BotCredentials, type BotLink, type BotMessage, type BotProtocol } from './protocol.js';

const MAX_MISSED_PONGS = 2;
const AUTH_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const CREDENTIALS_UNREADABLE = '已保存的 Secret 在这台机器上解不开（换了服务器、平台或服务账号），请重新填写 Secret。';
/** 不是我们自己写的中文原因（网络层、程序出错的英文原文），对外只说这一句。 */
const CONNECT_FAILED = '连接出错，正在重试';

/**
 * 连接用到的 WebSocket 的那几样。ws 的 WebSocket 和浏览器标准的 WebSocket（测试替身按它写）都合得上；
 * on('pong')、ping() 只有 ws 有（钉钉的心跳用），替身没有就不挂、不发。
 */
type BotSocket = {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  on?(event: 'pong', listener: () => void): unknown;
  ping?(): void;
};
type BotSocketClass = new (url: string) => BotSocket;
/** WebSocket 的 readyState：已打开 */
const SOCKET_OPEN = 1;

/** 收到的一帧转成字节：文字按 UTF-8；ws 给 Buffer，标准 WebSocket 给 ArrayBuffer（Blob 由调用方先读出来）；别的认不出（交给调用方当坏帧丢掉） */
function frameBytes(data: unknown) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  throw new Error('收到的帧既不是文字也不是二进制');
}

/**
 * 退避重连、认证超时和心跳用的计时器：只写连接用到的样子（默认是全局的四个函数）。
 * 计时器的编号连接只存着、原样交回 clear，不看是什么类型。
 */
export type BotTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  clearInterval(id: unknown): void;
};

export type BotConnectionOptions = {
  credentials: () => BotCredentials | null;
  ingest: (incoming: InboxIncoming) => unknown;
  exists: (channel: InboxChannel, externalId: string) => boolean;
  WebSocketImpl?: BotSocketClass;
  sleep?: (ms: number) => Promise<void>;
  timers?: BotTimers;
};

export class BotConnection<M = unknown, R = unknown> {
  private socket: BotSocket | null = null;
  private generation = 0;
  private attempts = 0;
  private missedPongs = 0;
  private secret = '';
  private heartbeat: unknown = null;
  private authTimer: unknown = null;
  private retryTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private timers: BotTimers;
  private current: BotStatus = {
    state: 'off',
    lastError: '',
    connectedAt: null,
    lastMessageAt: null,
    received: 0,
  };
  constructor(
    readonly protocol: BotProtocol<M, R>,
    private options: BotConnectionOptions,
  ) {
    this.timers = options.timers || globalThis;
  }
  status(): BotStatus {
    return { ...this.current };
  }
  /** 重新读取凭据后连接；已有连接先断开。 */
  start() {
    this.teardown();
    let credentials: BotCredentials | null = null;
    try {
      credentials = this.options.credentials();
    } catch (e) {
      // 已存的 Secret 解不开（换了服务器、平台或服务账号）：要人重填才能再连，记成被拒，原因显示在设置页
      console.error('[机器人] ' + this.protocol.name + '的 Secret 解不开：', errorMessage(e));
      this.setState('auth_failed', CREDENTIALS_UNREADABLE);
      return;
    }
    if (!credentials) {
      this.setState('off', '');
      return;
    }
    this.attempts = 0;
    this.current.lastError = '';
    this.open(credentials);
  }
  stop() {
    this.teardown();
    this.setState('off', '');
  }
  /** 测试和关闭时等待已收到的消息处理完。 */
  idle() {
    return this.queue;
  }
  private setState(state: BotState, error?: string) {
    this.current.state = state;
    if (error !== undefined) this.current.lastError = this.redact(error);
    if (state !== 'connected') this.current.connectedAt = null;
  }
  private redact(text: string) {
    return this.secret ? text.split(this.secret).join('***') : text;
  }
  private clearTimers() {
    if (this.heartbeat) this.timers.clearInterval(this.heartbeat);
    if (this.authTimer) this.timers.clearTimeout(this.authTimer);
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.heartbeat = this.authTimer = this.retryTimer = null;
  }
  private teardown() {
    this.generation++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // 旧连接关不掉（已经断了、还没连上）也不要紧：换代以后它的事件都不再处理
    }
  }
  private open(credentials: BotCredentials) {
    const generation = ++this.generation;
    this.secret = credentials.secret;
    this.setState('connecting');
    let url: string | Promise<string>;
    try {
      url = this.protocol.connectUrl(credentials);
    } catch (e) {
      this.connectFailed(credentials, generation, e);
      return;
    }
    // 固定地址同步连，要先换地址的等换好再连
    if (typeof url === 'string') this.connect(url, credentials, generation);
    else
      url.then(
        (next) => generation === this.generation && this.connect(next, credentials, generation),
        (e: unknown) => this.connectFailed(credentials, generation, e),
      );
  }
  private connectFailed(credentials: BotCredentials, generation: number, e: unknown) {
    if (generation !== this.generation) return;
    if (e instanceof BotAuthError) this.setState('auth_failed', e.message);
    else this.scheduleRetry(credentials, generation, e instanceof BotFailure ? e.message : CONNECT_FAILED);
  }
  private connect(url: string, credentials: BotCredentials, generation: number) {
    const Impl = this.options.WebSocketImpl ?? NodeWebSocket;
    let socket: BotSocket;
    try {
      socket = new Impl(url);
    } catch {
      this.scheduleRetry(credentials, generation, CONNECT_FAILED);
      return;
    }
    this.socket = socket;
    const live = () => generation === this.generation;
    const link = this.link(socket, generation, credentials);
    socket.addEventListener('open', () => {
      if (!live()) return;
      // 先挂超时再交给本家：不用等回应的会在 onOpen 里直接接通、清掉它
      this.authTimer = this.timers.setTimeout(() => {
        if (live()) {
          this.current.lastError = this.protocol.name + '没有回应订阅请求';
          socket.close();
        }
      }, AUTH_TIMEOUT_MS);
      this.protocol.onOpen(link, credentials);
    });
    socket.addEventListener('message', (event) => {
      if (live()) void this.onData(event.data, link);
    });
    socket.addEventListener('error', () => {
      if (live()) this.current.lastError = '连接' + this.protocol.name + '失败，正在重试';
    });
    socket.addEventListener('close', () => {
      if (!live()) return;
      this.clearTimers();
      this.socket = null;
      if (this.current.state === 'auth_failed' || this.current.state === 'kicked') return;
      this.scheduleRetry(credentials, generation, this.current.lastError || '连接已断开，正在重试');
    });
    // ws 自带心跳的回应（钉钉用）；测试替身没有 on 就不挂
    socket.on?.('pong', () => {
      if (live()) this.missedPongs = 0;
    });
  }
  private link(socket: BotSocket, generation: number, credentials: BotCredentials): BotLink<M, R> {
    const live = () => generation === this.generation && socket === this.socket;
    const link: BotLink<M, R> = {
      send: (data) => {
        if (!live() || socket.readyState !== SOCKET_OPEN) return false;
        try {
          socket.send(data);
          return true;
        } catch {
          return false;
        }
      },
      wsPing: () => {
        if (live()) socket.ping?.();
      },
      authOk: () => {
        if (live()) this.connected(socket, link);
      },
      authFailed: (message) => {
        if (!live()) return;
        this.clearTimers();
        this.setState('auth_failed', message);
        socket.close();
      },
      pong: () => {
        if (live()) this.missedPongs = 0;
      },
      kicked: (message) => {
        if (!live()) return;
        this.setState('kicked', message);
        socket.close();
      },
      received: (message) => {
        // 按收到的顺序逐条处理；下载慢也不影响心跳。
        if (live()) this.queue = this.queue.then(() => this.deliver(message, credentials)).catch(() => {});
      },
      reconnect: (reason) => {
        if (!live()) return;
        this.current.lastError = reason;
        socket.close();
      },
    };
    return link;
  }
  private connected(socket: BotSocket, link: BotLink<M, R>) {
    if (this.authTimer) this.timers.clearTimeout(this.authTimer);
    this.authTimer = null;
    this.attempts = 0;
    this.missedPongs = 0;
    this.setState('connected', '');
    this.current.connectedAt = new Date().toISOString();
    this.heartbeat = this.timers.setInterval(() => {
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        this.current.lastError = '心跳没有回应，正在重连';
        socket.close();
        return;
      }
      this.missedPongs++;
      this.protocol.ping(link);
    }, this.protocol.heartbeatMs());
  }
  private scheduleRetry(credentials: BotCredentials, generation: number, error: string) {
    if (generation !== this.generation) return;
    this.setState('retrying', error);
    const delay = Math.min(1000 * 2 ** this.attempts++, MAX_BACKOFF_MS);
    this.retryTimer = this.timers.setTimeout(() => {
      if (generation === this.generation) this.open(credentials);
    }, delay);
  }
  private async onData(data: unknown, link: BotLink<M, R>) {
    try {
      // 只有 Blob 要等读出来；文字和二进制当场交给本家（同一轮事件里处理完，和收到的顺序一致）
      const bytes = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : frameBytes(data);
      this.protocol.onFrame(bytes, link);
    } catch {
      // 坏帧丢掉，不影响连接
    }
  }
  private async deliver(message: BotMessage<M, R>, credentials: BotCredentials) {
    const sleep = this.options.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const { saved, reply } = await storeMessage(message, {
      channel: this.protocol.channel,
      name: this.protocol.name,
      ingest: this.options.ingest,
      exists: this.options.exists,
      fetch: (media) => this.protocol.fetch(media, credentials),
      sleep,
      redact: (text) => this.redact(text),
    });
    if (!reply) return;
    this.current.received += saved;
    this.current.lastMessageAt = new Date().toISOString();
    await this.protocol.reply(message.replyTo, reply, credentials);
  }
}
