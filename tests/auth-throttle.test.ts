// 登录和公开接口的限频：计数规则（纯函数）、访客按网段合并、同一账号跨地址的总上限、验本人密码按账号计。虚构账号。
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthManager } from '../server/accounts/index.js';
import type { AuthOptions } from '../server/accounts/auth.js';
import { Store, count, clientNetwork, Throttle } from '../server/core/index.js';
import { HashQueue } from '../server/accounts/hash-queue.js';
import { SERVER_BUSY_CODE, SERVER_BUSY_MESSAGE } from '../shared/core/index.js';
import { hashGate } from './hash-gate.js';
import { cookieOf, startProxied, testAdmin } from './http-fixture.js';

const wrong = { ...testAdmin, password: 'Fictional-wrong-password' };

test('失败计数：错满上限后要等到最后一次失败起满一个窗口，retryAfter 给出剩下的毫秒', () => {
  let now = 1_000_000;
  const t = new Throttle(() => now);
  for (let i = 0; i < 4; i++) t.failed('k', 300_000);
  assert.equal(t.retryAfter('k', 5), 0);
  t.failed('k', 300_000);
  assert.equal(t.retryAfter('k', 5), 300_000);
  now += 299_999;
  assert.equal(t.retryAfter('k', 5), 1);
  now += 1;
  assert.equal(t.retryAfter('k', 5), 0);
});

test('失败计数：forgive 退回一次，cleared 全部清掉', () => {
  const t = new Throttle(() => 0);
  t.failed('k', 1000);
  t.failed('k', 1000);
  t.forgive('k');
  assert.equal(t.retryAfter('k', 2), 0);
  assert.equal(t.retryAfter('k', 1), 1000);
  t.cleared('k');
  assert.equal(t.retryAfter('k', 1), 0);
});

test('提交计数：每次都算、超了的那次不计，窗口从第一次算起', () => {
  let now = 0;
  const t = new Throttle(() => now);
  for (let i = 0; i < 3; i++) assert.equal(t.hit('k', 3, 3600_000), false);
  assert.equal(t.hit('k', 3, 3600_000), true);
  now += 3600_000;
  assert.equal(t.hit('k', 3, 3600_000), false);
});

test('失败计数表满了不丢旧的：新键记不下（full），已有的键照常计数', () => {
  const t = new Throttle(() => 0, 3);
  for (const k of ['a', 'b', 'c']) t.failed(k, 1000);
  assert.equal(t.full('d'), true);
  t.failed('d', 1000);
  assert.equal(t.retryAfter('d', 1), 0, '新键没记上');
  assert.equal(t.full('a'), false);
  t.failed('a', 1000);
  assert.equal(t.retryAfter('a', 2), 1000, '旧键接着计');
});

test('表满了以后清过期记录至多每分钟扫一次，不是每记一笔都扫', () => {
  let now = 0;
  const t = new Throttle(() => now, 3);
  for (const k of ['a', 'b', 'c']) t.failed(k, 1000);
  now = 2000;
  assert.equal(t.full('d'), false, '第一次满了就扫，过期的清掉');
  for (const k of ['d', 'e', 'f']) t.failed(k, 1000);
  now = 4000;
  assert.equal(t.full('g'), true, '离上次扫不到一分钟，过期的先不清');
  now = 2000 + 60_000;
  assert.equal(t.full('g'), false, '满一分钟再扫');
});

test('访客网段：IPv4 原样，IPv6 不管怎么写都按前 64 位合并', () => {
  assert.equal(clientNetwork('192.0.2.7'), '192.0.2.7');
  assert.equal(clientNetwork('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(clientNetwork('2001:0DB8:0001:0002:ffff:0:0:9'), '2001:db8:1:2::/64');
  assert.equal(clientNetwork('2001:db8::1'), '2001:db8:0:0::/64');
  assert.notEqual(clientNetwork('2001:db8:1:3::1'), clientNetwork('2001:db8:1:2::1'));
});

/** 部署模式，账号库用可拨的时钟；管理员从本机入口建 */
async function proxied(options: AuthOptions = {}) {
  const clock = { now: Date.now() };
  const store = new Store(':memory:');
  const p = await startProxied(store, {}, {
    makeAuth: (deployment) => new AuthManager(':memory:', () => clock.now, { ...options, deployment, localAdministration: true }),
  });
  assert.equal((await p.call(p.localPort, '/auth/setup', { body: testAdmin })).code, 200);
  const from = (ip: string) => ({ ...p.remote, 'x-erp-client-ip': ip });
  const login = (ip: string, body: object = wrong) => p.call(p.proxyPort, '/auth/login', { body, headers: from(ip) });
  return {
    p,
    clock,
    from,
    login,
    async close() {
      await p.close();
      store.close();
    },
  };
}

/** 从 20 个不同网段各输错一次（每批 5 个一起发，不超过同时算哈希的上限） */
async function failFrom20Networks(s: Awaited<ReturnType<typeof proxied>>, body: object = wrong) {
  for (let batch = 0; batch < 4; batch++) {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => s.login('198.51.100.' + (batch * 5 + i + 1), body)));
    assert.deepEqual(results.map((r) => r.code), Array(5).fill(401));
  }
}

test('登录：同一 /64 里换地址也算同一个访客，别的网段不受影响', async () => {
  const s = await proxied();
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await s.login('2001:db8:1:2::' + i)).code, 401);
    const blocked = await s.login('2001:db8:1:2::99');
    assert.equal(blocked.code, 429);
    assert.equal(blocked.value.message, '尝试次数过多，请5分钟后重试。');
    assert.equal((await s.login('2001:db8:1:3::1')).code, 401);
  } finally {
    await s.close();
  }
});

test('登录：访客自己带的 X-Forwarded-For 不算地址，换着写也是同一个访客', async () => {
  const s = await proxied();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await s.p.call(s.p.proxyPort, '/auth/login', { body: wrong, headers: { ...s.from('192.0.2.60'), 'x-forwarded-for': '198.51.100.' + i } })).code);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  } finally {
    await s.close();
  }
});

test('登录：一个人输错被拦，同一出口的别的账号照常能试（办公室共用一个公网地址）', async () => {
  const s = await proxied();
  try {
    for (let i = 0; i < 5; i++) await s.login('192.0.2.61');
    assert.equal((await s.login('192.0.2.61')).code, 429);
    assert.equal((await s.login('192.0.2.61', { name: '虚构同事', password: 'Fictional-wrong-password' })).code, 401);
  } finally {
    await s.close();
  }
});

test('登录：从域名进来，同一账号跨网段错满 20 次就连正确密码也拦 15 分钟', async () => {
  const s = await proxied();
  try {
    await failFrom20Networks(s);
    const blocked = await s.login('203.0.113.1', testAdmin);
    assert.equal(blocked.code, 429);
    assert.equal(blocked.value.message, '尝试次数过多，请15分钟后重试。');
    s.clock.now += 15 * 60_000;
    assert.equal((await s.login('203.0.113.1', testAdmin)).code, 200);
  } finally {
    await s.close();
  }
});

test('登录：账号被人从域名锁住时，维护通道照样能登录', async () => {
  const s = await proxied();
  try {
    await failFrom20Networks(s);
    assert.equal((await s.login('203.0.113.1', testAdmin)).code, 429);
    assert.equal((await s.p.call(s.p.localPort, '/auth/login', { body: testAdmin })).code, 200);
  } finally {
    await s.close();
  }
});

test('登录：不存在的账号名和存在的一样计数、一样回答', async () => {
  const s = await proxied();
  try {
    const nobody = { name: '查无此人', password: 'Fictional-wrong-password' };
    await failFrom20Networks(s, nobody);
    const blocked = await s.login('203.0.113.1', nobody);
    assert.equal(blocked.code, 429);
    assert.equal(blocked.value.message, '尝试次数过多，请15分钟后重试。');
  } finally {
    await s.close();
  }
});

test('登录：同一网段同时发来一批，同时只算 2 个，其余回“服务器正忙”、不计入输错', async () => {
  const s = await proxied();
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => s.login('192.0.2.30')));
    assert.equal(results.filter((r) => r.code === 401).length, 2);
    assert.equal(results.filter((r) => r.value.code === SERVER_BUSY_CODE).length, 8);
    // 只算了 2 次输错：还能再错 3 次才被限流
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await s.login('192.0.2.30')).code);
    assert.deepEqual(codes, [401, 401, 401, 429]);
  } finally {
    await s.close();
  }
});

test('登录：跨 25 个网段同时猜同一个账号，先记输错再排队，账号总上限照样只放过 20 个', async () => {
  const s = await proxied();
  try {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => s.login('198.51.100.' + (i + 1))));
    assert.equal(results.filter((r) => r.code === 401).length, 20);
    assert.equal(results.filter((r) => r.value.message === '尝试次数过多，请15分钟后重试。').length, 5);
  } finally {
    await s.close();
  }
});

test('登录：公开接口的计数刷满一万条，也冲不掉还在锁定的登录失败计数', async () => {
  const s = await proxied();
  try {
    for (let i = 0; i < 5; i++) await s.login('192.0.2.40');
    for (let i = 0; i < 10_001; i++) s.p.auth.submissions.hit('forgot:2001:db8:' + i.toString(16) + '::/64', 10, 3600_000);
    assert.equal((await s.login('192.0.2.40', testAdmin)).code, 429);
  } finally {
    await s.close();
  }
});

test('验证本人密码：按会话计，换地址也接着算；同一账号别的会话不受影响，照样能进模式、改密码', async () => {
  const s = await proxied();
  try {
    const session = async () => cookieOf(await s.login('192.0.2.50', testAdmin));
    const stolen = await session(),
      own = await session();
    const enter = (cookie: string, ip: string, password: string) =>
      s.p.call(s.p.proxyPort, '/auth/super-admin/enter', { body: { password }, headers: s.from(ip), cookie });
    for (let i = 1; i <= 5; i++) assert.equal((await enter(stolen, '198.51.100.' + i, 'Fictional-wrong-password')).code, 401);
    const blocked = await enter(stolen, '203.0.113.9', testAdmin.password);
    assert.equal(blocked.code, 429);
    assert.equal(blocked.value.message, '密码验证次数过多，请5分钟后重试。');
    assert.equal((await enter(own, '192.0.2.50', testAdmin.password)).code, 200);
    const changed = await s.p.call(s.p.proxyPort, '/auth/password', {
      headers: s.from('192.0.2.50'),
      cookie: own,
      body: { current: testAdmin.password, password: 'Fictional-changed-123' },
    });
    assert.equal(changed.code, 200);
  } finally {
    await s.close();
  }
});

test('登录：核对密码的队伍满了回 429“服务器正忙”、带 Retry-After 和 busy 代码，不计入输错', async () => {
  const gate = hashGate();
  // 一个在算、不许排队：第二个登录一来就是“队伍满了”
  const s = await proxied({ hashes: new HashQueue(gate.hash, { parallel: 1, waiting: 0 }) });
  try {
    const name = (i: number) => ({ name: '虚构访客' + i, password: 'Fictional-wrong-password' });
    const before = gate.calls;
    gate.hold();
    const first = s.login('192.0.2.70', name(0));
    await gate.reached(before + 1);
    const busy = await s.login('192.0.2.70', name(1));
    assert.equal(busy.code, 429);
    assert.deepEqual(busy.value, { message: SERVER_BUSY_MESSAGE, code: SERVER_BUSY_CODE });
    assert.equal(busy.headers['retry-after'], '1');
    assert.equal(gate.calls, before + 1, '没排上的没算哈希');
    gate.release();
    assert.equal((await first).code, 401);
    // 没排上的那次没算输错：这个名字还能错满 5 次才被限流
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await s.login('192.0.2.70', name(1))).code);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  } finally {
    gate.release();
    await s.close();
  }
});

/** 等到条件成立（只转事件循环，不等真实时间；转一万轮还不成立就算失败） */
async function until(ok: () => boolean) {
  for (let i = 0; !ok(); i++) {
    if (i > 10_000) throw new Error('等的事一直没发生');
    await new Promise((done) => setImmediate(done));
  }
}

test('普通道被没登录的登录占满时，本机入口（维护通道）登录和已登录的人进模式照样成功', async () => {
  const gate = hashGate(),
    queue = new HashQueue(gate.hash, { parallel: 1, waiting: 1 });
  const s = await proxied({ hashes: queue });
  try {
    const cookie = cookieOf(await s.login('192.0.2.90', testAdmin));
    const before = gate.calls;
    gate.hold(2);
    const anonymous = [s.login('198.51.100.1'), s.login('198.51.100.2')];
    await gate.reached(before + 1);
    await until(() => queue.queued.open === 1);
    assert.equal((await s.login('198.51.100.3')).value.code, SERVER_BUSY_CODE, '普通道满了');
    const local = s.p.call(s.p.localPort, '/auth/login', { body: testAdmin });
    const enter = s.p.call(s.p.proxyPort, '/auth/super-admin/enter', { body: { password: testAdmin.password }, headers: s.from('192.0.2.90'), cookie });
    await until(() => queue.queued.priority === 2);
    gate.release();
    assert.equal((await local).code, 200);
    assert.equal((await enter).code, 200);
    assert.deepEqual((await Promise.all(anonymous)).map((r) => r.code), [401, 401]);
  } finally {
    gate.release();
    await s.close();
  }
});

test('验证本人密码：优先道也满了时回“服务器正忙”，不计入这个会话的输错', async () => {
  const gate = hashGate();
  const s = await proxied({ hashes: new HashQueue(gate.hash, { parallel: 1, waiting: 0, priorityWaiting: 0 }) });
  try {
    const cookie = cookieOf(await s.login('192.0.2.71', testAdmin));
    const enter = (password: string) =>
      s.p.call(s.p.proxyPort, '/auth/super-admin/enter', { body: { password }, headers: s.from('192.0.2.71'), cookie });
    const before = gate.calls;
    gate.hold();
    const other = s.login('192.0.2.72');
    await gate.reached(before + 1);
    const busy = await enter('Fictional-wrong-password');
    assert.equal(busy.code, 429);
    assert.equal(busy.value.code, SERVER_BUSY_CODE);
    gate.release();
    await other;
    for (let i = 0; i < 4; i++) assert.equal((await enter('Fictional-wrong-password')).code, 401);
    assert.equal((await enter(testAdmin.password)).code, 200, '忙那次没算，错 4 次还能进');
  } finally {
    gate.release();
    await s.close();
  }
});

test('登录：输错计数表满了，新来的回“服务器正忙”、不算哈希；已经在表里的照常计数', async () => {
  const gate = hashGate();
  // 从域名登录输错一次记 3 个键（网段+账号、网段、账号），上限 3 正好一次就满
  const s = await proxied({ hashes: new HashQueue(gate.hash), failureLimit: 3 });
  try {
    const before = gate.calls;
    assert.equal((await s.login('192.0.2.80')).code, 401);
    const other = await s.login('192.0.2.81', { name: '虚构别人', password: 'Fictional-wrong-password' });
    assert.equal(other.code, 429);
    assert.deepEqual(other.value, { message: SERVER_BUSY_MESSAGE, code: SERVER_BUSY_CODE });
    assert.equal(gate.calls, before + 1);
    for (let i = 0; i < 4; i++) assert.equal((await s.login('192.0.2.80')).code, 401);
    assert.equal((await s.login('192.0.2.80')).value.message, '尝试次数过多，请5分钟后重试。', '旧的计数没丢');
  } finally {
    await s.close();
  }
});

test('忘记密码：同一用户名一小时只登记 3 次，再多照样回 202、不再写记录', async () => {
  const s = await proxied();
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await s.p.call(s.p.proxyPort, '/auth/forgot', { body: { name: testAdmin.name }, headers: s.from('198.51.100.' + i) });
      assert.equal(r.code, 202);
    }
    const logged = count(s.p.auth.db, "SELECT COUNT(*) FROM auth_events WHERE action='password-reset-requested'");
    assert.equal(logged, 3);
  } finally {
    await s.close();
  }
});

test('申请账号：记下的是访客网段，同一网段最多占 3 个名额', async () => {
  const s = await proxied();
  try {
    const apply = (i: number) =>
      s.p.call(s.p.proxyPort, '/auth/apply', {
        body: { name: '虚构申请' + i, password: 'Fictional-apply-123' },
        headers: s.from('2001:db8:7::' + i),
      });
    for (let i = 1; i <= 3; i++) assert.equal((await apply(i)).code, 202);
    assert.equal((await apply(4)).code, 429);
    assert.deepEqual(
      s.p.auth.listRequests().map((r) => r.client),
      Array(3).fill('2001:db8:7:0::/64'),
    );
  } finally {
    await s.close();
  }
});
