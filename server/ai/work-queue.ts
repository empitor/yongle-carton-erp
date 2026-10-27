import { randomUUID } from 'node:crypto';
import { AiConnectionError } from './connection-error.js';
export type QueueState = {
  state: 'queued' | 'running' | 'backoff';
  position: number;
  limit: number;
  attempt: number;
};
type Job = {
  id: string;
  run: () => Promise<any>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  signal?: AbortSignal;
  notify?: (s: QueueState) => void;
  attempt: number;
  abort: () => void;
};
// 所有使用当前AI管理器的请求共享限额。仅明确429自动重试，超时/断线可能已计费，不自动重发。
export class AiWorkQueue {
  private jobs: Job[] = [];
  private active = 0;
  private adaptive = 6;
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
        run,
        resolve,
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
    while (this.active < this.limit && this.jobs.length) {
      const j = this.jobs.shift()!;
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
          (v) => {
            if (++this.successes >= 6) {
              this.adaptive = Math.min(6, this.adaptive + 1);
              this.successes = 0;
            }
            j.resolve(v);
          },
          (e) => {
            if (e instanceof AiConnectionError && e.code === 'rate_limit') {
              this.adaptive = 1;
              this.successes = 0;
              this.cooldown = Date.now() + Math.min(30000, this.backoffMs * 2 ** j.attempt);
              if (j.attempt < 2 && !j.signal?.aborted) {
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
