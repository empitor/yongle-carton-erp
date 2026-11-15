// AI 工作队列（server/ai/work-queue.ts）：所有 AI 请求共用的并发限额、明确限流（429/503）时降为串行并有限退避重试、
// 别的错不重发、排队的能取消。退避用 1～2 毫秒，不真等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkQueue, type QueueState } from '../server/ai/work-queue.js';
import { AiConnectionError } from '../server/ai/errors.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limited = () => new AiConnectionError('rate_limit', '限流', 429);

test('六份任务最多三个同时执行，逐份结果独立、失败隔离、队列不重复混淆', async () => {
  let active = 0,
    max = 0;
  const q = new AiWorkQueue(() => 3),
    states: (QueueState & { i: number })[] = [];
  const result = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      q.run(
        async () => {
          active++;
          max = Math.max(max, active);
          try {
            await sleep(20);
            if (i === 2) throw new Error('独立失败');
            return '文件' + i;
          } finally {
            active--;
          }
        },
        undefined,
        (s) => states.push({ i, ...s }),
      ),
    ),
  );
  assert.equal(max, 3);
  assert.equal(result[2].status, 'rejected');
  const sixth = result[5];
  assert.equal(sixth.status === 'fulfilled' ? sixth.value : sixth.reason, '文件5');
  assert(states.some((s) => s.state === 'queued'));
  assert.equal(q.stats().active, 0);
});
test('明确429降为串行并有限退避重试，超时不自动重发，排队任务可取消', async () => {
  let calls = 0;
  const q = new AiWorkQueue(() => 3, 2);
  const keep = setInterval(() => {}, 50);
  try {
    const r = await q.run(async () => {
      if (calls++ === 0) throw new AiConnectionError('rate_limit', '限流', 429);
      return 'ok';
    });
    assert.equal(r, 'ok');
    assert.equal(calls, 2);
    assert.equal(q.limit, 1);
    let unknown = 0;
    await assert.rejects(() =>
      q.run(async () => {
        unknown++;
        throw new AiConnectionError('timeout', '可能已处理', 504);
      }),
    );
    assert.equal(unknown, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      first = q.run(() => gate),
      controller = new AbortController(),
      cancelled = q.run(async () => {
        throw new Error('不能发出');
      }, controller.signal);
    controller.abort();
    await assert.rejects(() => cancelled, /取消/);
    release();
    await first;
  } finally {
    clearInterval(keep);
  }
});

test('一直限流：重试 2 次后照实报限流，总共调 3 次；冷却期间排着的任务收到“退避等待”；之后连续成功 6 次，限额回到设置值', async () => {
  const q = new AiWorkQueue(() => 2, 1);
  const keep = setInterval(() => {}, 50); // 冷却的计时器不挡进程退出，测试里留一个活着的
  try {
    let calls = 0;
    const states: QueueState['state'][] = [];
    await assert.rejects(
      q.run(async () => (calls++, Promise.reject(limited())), undefined, (s) => states.push(s.state)),
      (e: unknown) => e instanceof AiConnectionError && e.code === 'rate_limit',
    );
    assert.equal(calls, 3);
    assert.ok(states.includes('backoff'), states.join());
    assert.equal(q.limit, 1, '限流后降为串行');
    for (let i = 0; i < 6; i++) await q.run(async () => i);
    assert.equal(q.limit, 2, '连续成功 6 次回到设置的 2');
  } finally {
    clearInterval(keep);
  }
});
