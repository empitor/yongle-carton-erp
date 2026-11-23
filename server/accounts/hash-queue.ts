import type { Request } from 'express';
import { SERVER_BUSY_CODE, SERVER_BUSY_MESSAGE, SERVER_BUSY_RETRY_SECONDS } from '../../shared/core/index.js';
import { AppError } from '../core/index.js';
import { scryptAsync } from './password-hash.js';

/**
 * 核对密码（登录、进超级管理员模式、改密码、删除确认）共用的一道闸。算一次 scrypt 占线程池一个线程几十毫秒，
 * 线程池还要给读写文件用（发页面的 js/css、上传、导出）：同时算的有上限，多出来的在程序里排队（不占线程池）。
 * 两条道：
 * - 优先道：本机入口（维护通道）的登录、已经登录的人验本人密码。空出名额先叫它们，不占普通道的名额，
 *   没登录的人刷再多登录也挤不掉它们（管理员被人锁住时从维护通道登录这条退路一直在）。
 * - 普通道：从域名来的登录，先来先算；同一网段同时在道里（排着或在算）的有上限，少量网段占不满。
 * 只有道满了、同一网段超了、或等超时才回“服务器正忙”（ServerBusyError），不算输错。排着队时对方断开了的，从队里拿掉。
 * 这几个数按开发机上一次哈希约 30–60 毫秒估的；2 核服务器上大概慢一倍，部署后可以量一次再调。
 */
/** 同时在算的最多 2 个：线程池默认 4 个线程，留一半给读写文件；服务器 2 核 */
export const MAX_PARALLEL_HASHES = 2;
/** 普通道排队最多 32 个：按一次约 60 毫秒、2 个并行，排到最后约 1 秒 */
export const MAX_WAITING_HASHES = 32;
/** 优先道排队最多 8 个：维护通道和已登录的人，平时同时只有一两个 */
export const MAX_PRIORITY_WAITING = 8;
/** 同一网段同时在普通道里最多 2 个（访客网段见 AuthManager.clientAddress） */
export const MAX_PER_NETWORK = 2;
/** 排队最多等 5 秒，过了就回“服务器正忙” */
export const MAX_HASH_WAIT_MS = 5_000;

/** 服务器正忙：回 429、固定代码，Retry-After 由全站出错回答带上（server/http-errors.ts 看 retryAfterSeconds） */
export class ServerBusyError extends AppError {
  readonly retryAfterSeconds = SERVER_BUSY_RETRY_SECONDS;
  constructor() {
    super(SERVER_BUSY_MESSAGE, 429, SERVER_BUSY_CODE);
  }
}

type Limits = { parallel: number; waiting: number; priorityWaiting: number; perNetwork: number; waitMs: number };
const defaults: Limits = {
  parallel: MAX_PARALLEL_HASHES,
  waiting: MAX_WAITING_HASHES,
  priorityWaiting: MAX_PRIORITY_WAITING,
  perNetwork: MAX_PER_NETWORK,
  waitMs: MAX_HASH_WAIT_MS,
};
/** 走哪条道：priority 走优先道；否则走普通道，network 是访客网段 */
export type HashLane = { priority: true; signal?: AbortSignal } | { network: string; signal?: AbortSignal };
type Waiter = { go: () => void };

export class HashQueue {
  private running = 0;
  private readonly priority: Waiter[] = [];
  private readonly open: Waiter[] = [];
  /** 普通道里每个网段排着和在算的个数 */
  private readonly networks = new Map<string, number>();
  private readonly limits: Limits;
  constructor(
    private readonly hash: (password: string, salt: string) => Promise<Buffer> = scryptAsync,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
  }
  /** 两条道各排着几个（诊断用） */
  get queued() {
    return { priority: this.priority.length, open: this.open.length };
  }
  /** 排队算一次。lane.signal 断开（对方关了连接）时还在排队的就拿掉，抛出断开的错误 */
  async run(password: string, salt: string, lane: HashLane): Promise<Buffer> {
    const network = 'network' in lane ? lane.network : undefined;
    if (network !== undefined) {
      const count = this.networks.get(network) ?? 0;
      if (count >= this.limits.perNetwork) throw new ServerBusyError();
      this.networks.set(network, count + 1);
    }
    try {
      if (this.running < this.limits.parallel) this.running++;
      else if (network === undefined) await this.wait(this.priority, this.limits.priorityWaiting, lane.signal);
      else await this.wait(this.open, this.limits.waiting, lane.signal);
      try {
        return await this.hash(password, salt);
      } finally {
        // 名额直接交给下一个：优先道先叫，都没人排才空出来
        const next = this.priority.shift() ?? this.open.shift();
        if (next) next.go();
        else this.running--;
      }
    } finally {
      if (network !== undefined) {
        // 这个网段只剩这一个了就拿掉，不留 0
        const count = this.networks.get(network);
        if (count !== undefined && count > 1) this.networks.set(network, count - 1);
        else this.networks.delete(network);
      }
    }
  }
  private wait(line: Waiter[], cap: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(gone());
    if (line.length >= cap) return Promise.reject(new ServerBusyError());
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const at = line.indexOf(waiter);
        if (at >= 0) line.splice(at, 1);
      };
      const waiter: Waiter = {
        go: () => {
          leave();
          resolve();
        },
      };
      const onAbort = () => {
        leave();
        reject(gone());
      };
      const timer = setTimeout(() => {
        leave();
        reject(new ServerBusyError());
      }, this.limits.waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      line.push(waiter);
    });
  }
}

const gone = () => new AppError('请求已经断开。', 400, 'aborted');

/** 对方在回答之前断开了连接时触发（排队算密码的请求据此从队里拿掉） */
export function disconnected(req: Request): AbortSignal {
  const controller = new AbortController(),
    res = req.res;
  res?.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
