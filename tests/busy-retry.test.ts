// 页面收到“服务器正忙”（429、代码 busy）：停一下自动再发一次，第二次还忙才交给调用方显示（src/ui/http.ts 的 retryWhenBusy，
// 登录页、进超级管理员模式、改密码、删除确认都经过它）。停的办法换成记下时长、不真等。
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { retryWhenBusy } from '../src/ui/http.js';
import { SERVER_BUSY_CODE, SERVER_BUSY_MESSAGE } from '../shared/core/index.js';

const busy = () =>
  new Response(JSON.stringify({ message: SERVER_BUSY_MESSAGE, code: SERVER_BUSY_CODE }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
  });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/** 按顺序回给定的回答，数发了几次；wait 只记要停多久 */
function sender(...answers: (() => Response)[]) {
  const waited: number[] = [];
  let sent = 0;
  return {
    send: async () => answers[sent++](),
    wait: async (ms: number) => {
      waited.push(ms);
    },
    waited,
    get sent() {
      return sent;
    },
  };
}

test('第一次正忙：按 Retry-After 停一下再发一次，第二次成功就用第二次的回答', async () => {
  const s = sender(busy, ok);
  const r = await retryWhenBusy(s.send, s.wait);
  assert.equal(r.status, 200);
  assert.equal(s.sent, 2);
  assert.deepEqual(s.waited, [1000]);
});

test('第二次还忙：不再发，把正忙的回答交给调用方显示', async () => {
  const s = sender(busy, busy, ok);
  const r = await retryWhenBusy(s.send, s.wait);
  assert.equal(r.status, 429);
  assert.equal(z.object({ message: z.string() }).parse(await r.json()).message, SERVER_BUSY_MESSAGE);
  assert.equal(s.sent, 2);
});

test('别的 429（输错太多被限流）不自动重发', async () => {
  const limited = () => new Response(JSON.stringify({ message: '尝试次数过多，请5分钟后重试。' }), { status: 429 });
  const s = sender(limited, ok);
  assert.equal((await retryWhenBusy(s.send, s.wait)).status, 429);
  assert.equal(s.sent, 1);
});
