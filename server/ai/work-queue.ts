import { randomUUID } from 'node:crypto';
import { AiConnectionError } from './errors.js';
export type QueueState = {
  state: 'queued' | 'running' | 'backoff';
  position: number;
  limit: number;
  attempt: number;
};
type Job = {
  id: string;
  /** 跑一次；成功时交回把结果交给调用方的函数（各个任务的结果类型不同，排队这一层不用知道） */
  run: () => Promise<() => void>;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  notify?: (s: QueueState) => void;
  attempt: number;
  abort: () => void;
};
/** 自动调节的并发上限最高到几；连着成功几次往上加一 */
const ADAPTIVE_CEILING = 6;
const SUCCESSES_TO_RAISE = 6;
/** 限流后最多等多久、最多重排几次 */
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRIES = 2;
// 所有使用当前AI管理器的请求共享限额。仅明确429自动重试，超时/断线可能已计费，不自动重发。
export class AiWorkQueue {
  private jobs: Job[] = [];
  private active = 0;
  private adaptive = ADAPTIVE_CEILING;
  private successes = 0;
  private cooldown = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private configured: () => number,
    private backoffMs = 2000,
  ) {}
  get limit() {
    return Math.max(1, Math.min(this.configured(), this.adaptive));
  }
  stats() {
    return {
      active: this.active,
      waiting: this.jobs.length,
      limit: this.limit,
      configured: this.configured(),
    };
  }
  run<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
    notify?: (s: QueueState) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: randomUUID(),
        run: () => run().then((value) => () => resolve(value)),
        reject,
        signal,
        notify,
        attempt: 0,
        abort: () => {
          const index = this.jobs.indexOf(job);
          if (index >= 0) {
            this.jobs.splice(index, 1);
            reject(new AiConnectionError('busy', '排队任务已取消。', 409));
            this.pump();
          }
        },
      };
      if (signal?.aborted) {
        reject(new AiConnectionError('busy', '任务已取消。', 409));
        return;
      }
      signal?.addEventListener('abort', job.abort, { once: true });
      this.jobs.push(job);
      this.pump();
    });
  }
  private pump() {
    if (this.timer) clearTimeout(this.timer);
    const waiting = Date.now() < this.cooldown;
    this.jobs.forEach((j, i) =>
      j.notify?.({
        state: waiting ? 'backoff' : 'queued',
        position: i + 1,
        limit: this.limit,
        attempt: j.attempt,
      }),
    );
    if (waiting) {
      this.timer = setTimeout(() => this.pump(), this.cooldown - Date.now());
      this.timer.unref();
      return;
    }
    while (this.active < this.limit) {
      const j = this.jobs.shift();
      if (!j) break;
      if (j.signal?.aborted) {
        j.abort();
        j.reject(new AiConnectionError('busy', '任务已取消。', 409));
        continue;
      }
      this.active++;
      j.notify?.({ state: 'running', position: 0, limit: this.limit, attempt: j.attempt });
      void Promise.resolve()
        .then(j.run)
        .then(
          (deliver) => {
            if (++this.successes >= SUCCESSES_TO_RAISE) {
              this.adaptive = Math.min(ADAPTIVE_CEILING, this.adaptive + 1);
              this.successes = 0;
            }
            deliver();
          },
          (e: unknown) => {
            if (e instanceof AiConnectionError && e.code === 'rate_limit') {
              this.adaptive = 1;
              this.successes = 0;
              this.cooldown = Date.now() + Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** j.attempt);
              if (j.attempt < MAX_RETRIES && !j.signal?.aborted) {
                j.attempt++;
                this.jobs.push(j);
                return;
              }
            }
            j.reject(e);
          },
        )
        .finally(() => {
          this.active--;
          if (!this.jobs.includes(j)) j.signal?.removeEventListener('abort', j.abort);
          this.pump();
        });
    }
  }
}
