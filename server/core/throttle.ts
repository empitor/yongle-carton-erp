import { MINUTE_MS } from '../../shared/core/index.js';

/** 提示里“几分钟后重试”的分钟数（retryAfter 的毫秒向上取整） */
export const retryMinutes = (ms: number) => Math.ceil(ms / MINUTE_MS);
/** 被拦、被限流时，同一个会话或账号名多久只往登录记录里记一笔：有人反复刷也不会把记录写满 */
const LOG_ONCE_MINUTES = 5;
export const LOG_ONCE_MS = LOG_ONCE_MINUTES * MINUTE_MS;
/** 表超过上限时，清过期记录至多这么久扫一次全表（摊下来每次记一笔都是常数时间） */
const PRUNE_INTERVAL = MINUTE_MS;

/**
 * 按键计次的限流：登录、验证本人密码、申请账号、忘记密码都用它。只在内存里，重启清零。
 * - hit：每次提交都计数（成功也算），窗口从第一次算起，到上限就拦；表满了从最早的丢，不让内存无限涨；
 * - failed：只在失败时计数，每失败一次窗口从这次重新算；retryAfter 看还要等多久，forgive 退回一次，cleared 在成功后清掉。
 *   表满了不丢旧的（丢了就等于替猜密码的人清零），新键记不下：调用方先看 full，满了直接拦新来的。
 * 所以失败计数和 hit 计数不能放在同一个实例里：否则刷 hit 能把还没过期的失败计数挤掉（AuthManager 分两个）。
 */
export class Throttle {
  private items = new Map<string, { count: number; until: number }>();
  private prunedAt = -Infinity;
  constructor(
    private now: () => number,
    private limit = 10_000,
  ) {}
  /** 到了上限还要等多少毫秒；没到上限是 0 */
  retryAfter(key: string, limit: number) {
    const item = this.items.get(key),
      now = this.now();
    return item && item.until > now && item.count >= limit ? item.until - now : 0;
  }
  /** 表满了、这个键又不在表里：记不下新的了 */
  full(key: string) {
    this.prune();
    return this.items.size >= this.limit && !this.items.has(key);
  }
  /** 计一次并返回这次是不是已经超了（超了的这次不计数） */
  hit(key: string, limit: number, windowMs: number) {
    const now = this.now(),
      item = this.items.get(key),
      live = !!item && item.until > now;
    if (live && item.count >= limit) return true;
    this.items.set(key, { count: (live ? item.count : 0) + 1, until: live ? item.until : now + windowMs });
    this.prune();
    for (const k of this.items.keys()) {
      if (this.items.size <= this.limit) break;
      this.items.delete(k);
    }
    return false;
  }
  failed(key: string, windowMs: number) {
    if (this.full(key)) return;
    const now = this.now(),
      item = this.items.get(key);
    this.items.set(key, { count: (item && item.until > now ? item.count : 0) + 1, until: now + windowMs });
  }
  /** 先按失败记下、结果是成功时退回这一次（异步核对密码时先占位，并发的请求不能一起越过上限） */
  forgive(key: string) {
    const item = this.items.get(key);
    if (!item) return;
    if (item.count <= 1) this.items.delete(key);
    else item.count--;
  }
  cleared(key: string) {
    this.items.delete(key);
  }
  private prune() {
    const now = this.now();
    if (this.items.size < this.limit || now - this.prunedAt < PRUNE_INTERVAL) return;
    this.prunedAt = now;
    for (const [k, v] of this.items) if (v.until <= now) this.items.delete(k);
  }
}
