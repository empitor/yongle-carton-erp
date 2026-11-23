// 核对密码的那道闸（server/accounts/hash-queue.ts）：同时算的有上限；普通道先来先算、同一网段有上限；优先道（维护通道、
// 已登录的人）空出名额先叫、不占普通道名额；道满、超时才说服务器正忙；断开的从队里拿掉。
// 哈希换成手动放行的，超时用假计时器，不靠真实时间。
import assert from 'node:assert/strict';
import test from 'node:test';
import { HashQueue, ServerBusyError } from '../../server/accounts/hash-queue.js';
import { SERVER_BUSY_CODE } from '../../shared/core/index.js';

/** 手动放行的哈希：started 记谁开始算了，finish(密码) 让它算完 */
function manualHash() {
  const started: string[] = [],
    pending = new Map<string, () => void>();
  return {
    started,
    hash: (password: string) =>
      new Promise<Buffer>((done) => {
        started.push(password);
        pending.set(password, () => done(Buffer.alloc(64)));
      }),
    finish(password: string) {
      const release = pending.get(password);
      if (!release) throw new Error('还没开始算：' + password);
      release();
    },
  };
}
/** 让排着的接上（放行后要过几轮微任务） */
const settle = () => new Promise((done) => setImmediate(done));
const limits = { parallel: 2, waiting: 2, priorityWaiting: 2, perNetwork: 2, waitMs: 5000 };
/** 每个用一个不同的网段走普通道 */
const open = (name: string) => ({ network: 'net-' + name });
const priority = { priority: true as const };
const isBusy = (e: unknown) => e instanceof ServerBusyError && e.status === 429 && e.code === SERVER_BUSY_CODE;

test('默认同时只算 2 个（线程池留一半给读写文件），第 3 个在等', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash);
  const runs = ['a', 'b', 'c'].map((p) => queue.run(p, 'salt', open(p)));
  await settle();
  assert.deepEqual(h.started, ['a', 'b']);
  h.finish('a');
  await settle();
  h.finish('b');
  h.finish('c');
  await Promise.all(runs);
});

test('普通道：到了上限后来的在等，放开一个，排着的先来先算', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const runs = ['a', 'b', 'c', 'd'].map((p) => queue.run(p, 'salt', open(p)));
  await settle();
  assert.deepEqual(h.started, ['a', 'b']);
  h.finish('b');
  await settle();
  assert.deepEqual(h.started, ['a', 'b', 'c'], '先来的 c 先算');
  h.finish('a');
  await settle();
  assert.deepEqual(h.started, ['a', 'b', 'c', 'd']);
  h.finish('c');
  h.finish('d');
  await Promise.all(runs);
});

test('普通道排满了再来的回“服务器正忙”（busy），不算哈希', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const running = ['a', 'b', 'c', 'd'].map((p) => queue.run(p, 'salt', open(p)));
  await assert.rejects(queue.run('e', 'salt', open('e')), isBusy);
  await settle();
  assert.ok(!h.started.includes('e'));
  for (const p of ['a', 'b', 'c', 'd']) {
    await settle();
    h.finish(p);
  }
  await Promise.all(running);
});

test('同一网段同时在普通道里（排着或在算）超过上限的回 busy，别的网段照常；它的算完了又能进', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const same = { network: 'net-x' };
  const first = [queue.run('x1', 'salt', same), queue.run('x2', 'salt', same)];
  await assert.rejects(queue.run('x3', 'salt', same), isBusy);
  const other = queue.run('y', 'salt', open('y'));
  await settle();
  h.finish('x1');
  await first[0];
  const again = queue.run('x4', 'salt', same);
  await settle();
  for (const p of ['x2', 'y', 'x4']) {
    await settle();
    h.finish(p);
  }
  await Promise.all([first[1], other, again]);
  assert.ok(!h.started.includes('x3'));
});

test('优先道：普通道有人排着时，空出名额先叫优先道的', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const runs = [queue.run('a', 'salt', open('a')), queue.run('b', 'salt', open('b')), queue.run('c', 'salt', open('c'))];
  const admin = queue.run('admin', 'salt', priority);
  await settle();
  assert.deepEqual(queue.queued, { priority: 1, open: 1 });
  h.finish('a');
  await settle();
  assert.deepEqual(h.started, ['a', 'b', 'admin'], '优先道的插到普通道前面');
  for (const p of ['b', 'admin', 'c']) {
    await settle();
    h.finish(p);
  }
  await Promise.all([...runs, admin]);
});

test('优先道不占普通道的名额：普通道排满了它照样能排上；优先道自己满了才 busy', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const runs = ['a', 'b', 'c', 'd'].map((p) => queue.run(p, 'salt', open(p)));
  await assert.rejects(queue.run('e', 'salt', open('e')), isBusy, '普通道满了');
  const admins = [queue.run('p1', 'salt', priority), queue.run('p2', 'salt', priority)];
  await assert.rejects(queue.run('p3', 'salt', priority), isBusy, '优先道自己的上限');
  for (const p of ['a', 'b', 'p1', 'p2', 'c', 'd']) {
    await settle();
    h.finish(p);
  }
  await Promise.all([...runs, ...admins]);
  assert.deepEqual(h.started, ['a', 'b', 'p1', 'p2', 'c', 'd']);
});

test('排队等超时回“服务器正忙”，从队里拿掉，后面放开也不再算它', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const running = ['a', 'b'].map((p) => queue.run(p, 'salt', open(p)));
  const waiting = queue.run('c', 'salt', open('c'));
  t.mock.timers.tick(limits.waitMs);
  await assert.rejects(waiting, isBusy);
  h.finish('a');
  h.finish('b');
  await Promise.all(running);
  await settle();
  assert.deepEqual(h.started, ['a', 'b']);
});

test('排着队时对方断开了：从队里拿掉，不白算，名额留给后面的人', async () => {
  const h = manualHash(),
    queue = new HashQueue(h.hash, limits);
  const running = ['a', 'b'].map((p) => queue.run(p, 'salt', open(p)));
  const left = new AbortController();
  const gone = queue.run('c', 'salt', { network: 'net-c', signal: left.signal });
  const next = queue.run('d', 'salt', open('d'));
  left.abort();
  await assert.rejects(gone, (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 'aborted');
  h.finish('a');
  await settle();
  assert.deepEqual(h.started, ['a', 'b', 'd']);
  h.finish('b');
  h.finish('d');
  await Promise.all([...running, next]);
});
