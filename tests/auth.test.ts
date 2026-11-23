// 登录和账号权限：未登录一律 401、账号级别和权限、只读和出纳能做什么、停用和改密、哈希存储、本机模式重启要重登。虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AuthManager } from '../server/accounts/index.js';
import { levelGrant } from '../server/accounts/account-db.js';
import { accountLevels } from '../shared/core/accounts.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { financeOnlyAccount, financeOnlyApiAllowed } from '../shared/core/account-scope.js';
import { cookieOf, startHttp, stateActor, testAdmin } from './http-fixture.js';
import { orderBasics } from './stack-fixture.js';
import { hashGate } from './hash-gate.js';
import { HashQueue } from '../server/accounts/hash-queue.js';
import { count, one } from '../server/core/sql.js';
import { rows } from '../server/core/schema/rows.js';

const pass = 'Fictional-pass-123';

/** 出错回答里的提示 */
const messageOf = async (r: Response) => z.object({ message: z.string() }).parse(await r.json()).message;
/** 回答正文（JSON 对象） */
const bodyOf = async (r: Response) => z.record(z.string(), z.unknown()).parse(await r.json());
const accountList = z.object({ users: z.array(z.object({ id: z.string(), name: z.string(), level: z.string() })) });
type AccountRow = z.infer<typeof accountList>['users'][number];
/** 账号管理（/auth/users）回答里的账号列表 */
const accountsIn = async (r: Response) => accountList.parse(await r.json()).users;
/** 账号列表里按名字找一个，没有就让测试失败 */
function accountNamed(users: AccountRow[], name: string) {
  const found = users.find((u) => u.name === name);
  assert.ok(found, '账号列表里有 ' + name);
  return found;
}

/** 起服务、建管理员并进超级管理员模式（建号要在模式里），再按级别建几个号 */
async function withAccounts(levels: [name: string, level: string][] = []) {
  const f = orderBasics(),
    h = await startHttp(f.store);
  await h.enterSuperMode();
  for (const [name, level] of levels)
    assert.equal((await h.send('/auth/users', { name, password: pass, level }, h.cookie)).status, 201);
  return {
    f,
    h,
    async close() {
      await h.close();
      f.store.close();
    },
  };
}

test('没登录时业务接口一律 401，健康检查和登录状态照常', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store, { admin: false });
  try {
    for (const path of ['/orders', '/customers', '/products', '/dashboard', '/suppliers', '/purchases', '/warehouse/items', '/warehouse/movements', '/ai/settings', '/auth/users'])
      assert.equal((await h.send(path)).status, 401, path);
    assert.equal((await h.send('/health')).status, 200);
    assert.equal((await h.send('/auth/state')).status, 200);
  } finally {
    await h.close();
    store.close();
  }
});

test('五种账号级别建出来读回同一个级别，库里的角色和权限就是这个级别的', async () => {
  const names = accountLevels.map((level) => ['虚构' + level, level] as [string, string]);
  const s = await withAccounts(names.filter(([, level]) => level !== 'admin').concat([['虚构第二管理员', 'admin']]));
  try {
    const users = await accountsIn(await s.h.send('/auth/users', undefined, s.h.cookie));
    const grantRow = rows.users.pick({ role: true, permissions: true });
    const loggedLevel = z.object({ level: z.string().optional() });
    for (const level of accountLevels) {
      const name = level === 'admin' ? '虚构第二管理员' : '虚构' + level;
      assert.equal(accountNamed(users, name).level, level, name);
      const row = one(s.h.auth.db, grantRow, 'SELECT role,permissions FROM users WHERE name=?', name);
      assert.ok(row, name + ' 在账号库里');
      const permissions: unknown = JSON.parse(row.permissions);
      assert.deepEqual({ role: row.role, permissions }, levelGrant[level], name);
      const state = loggedLevel.parse(await (await s.h.send('/auth/state', undefined, await s.h.login(name, pass))).json());
      assert.equal(state.level, level, name + ' 登录后的级别');
    }
  } finally {
    await s.close();
  }
});

test('只读账号能看业务，不能写、不能管账号', async () => {
  const s = await withAccounts([['虚构只读', 'viewer']]);
  try {
    const viewer = await s.h.login('虚构只读', pass);
    assert.equal((await s.h.send('/orders', undefined, viewer)).status, 200);
    assert.equal((await s.h.send('/customers', { name: '虚构写入' }, viewer)).status, 403);
    assert.equal((await s.h.send('/auth/users', undefined, viewer)).status, 403);
  } finally {
    await s.close();
  }
});

test('出纳只看财务：订单、客户文件、收件箱和业务助手工具都拒绝（路径大小写不同也拦），关联记录也不给看', async () => {
  assert.equal(financeOnlyAccount({ role: 'admin', permissions: ['finance:view', 'finance:cash'] }), true);
  assert.equal(financeOnlyAccount({ role: 'admin', permissions: ['business:edit', 'finance:view'] }), false);
  assert.equal(financeOnlyAccount({ role: 'super_admin', permissions: ['finance:view'] }), false);
  const s = await withAccounts([
    ['虚构出纳', 'cashier'],
    ['虚构只读', 'viewer'],
  ]);
  const { h, f } = s;
  try {
    const cashier = await h.login('虚构出纳', pass),
      viewer = await h.login('虚构只读', pass);
    for (const path of ['/orders', '/customers', '/dashboard', '/inbox', '/ai/imports', '/products/1/marks']) {
      const r = await h.send(path, undefined, cashier);
      assert.equal(r.status, 403, path);
      assert.match(await messageOf(r), /出纳账号只能查看财务数据/);
    }
    assert.notEqual((await h.send('/finance/settings', undefined, cashier)).status, 403, '财务接口照常');
    // 路由不分大小写（管理员用大写路径也能读到客户），出纳的拦截也不分；多一个斜杠也拦
    const raw = async (path: string, cookie: string) => {
      const r = await fetch(h.origin + path, { headers: { Cookie: cookie } });
      await r.arrayBuffer();
      return r.status;
    };
    assert.equal(await raw('/API/customers', h.cookie), 200);
    for (const path of ['/API/customers', '/Api/orders', '/API/inbox/1/file', '/api/Customers', '/API/Dashboard', '//api/customers'])
      assert.equal(await raw(path, cashier), 403, path);
    for (const path of ['/API/finance/settings', '/Api/Finance/settings', '/API/auth/state'])
      assert.notEqual(await raw(path, cashier), 403, path);
    // 出纳的页面出了错也要能上报，否则助手和管理员排查时看不到
    assert.equal(financeOnlyApiAllowed('/api/diagnostics/page-problems'), true);
    // 记录详情的“关联记录与修改历史”和订单的关联单据：能看记录的人就能看，出纳不能
    const order = f.order([f.line(f.pa, 10)]);
    for (const path of ['/business/orders/' + order.id + '/context', '/business/orders/' + order.id + '/related']) {
      assert.equal((await h.send(path, undefined, viewer)).status, 200, '只读账号 ' + path);
      assert.equal((await h.send(path, undefined, cashier)).status, 403, '出纳 ' + path);
    }
    const actorOf = async (cookie: string) => stateActor(await bodyOf(await h.send('/auth/state', undefined, cookie)));
    const registry = new AssistantToolRegistry(':memory:');
    try {
      const tool = (tools: ReturnType<typeof registry.view>['tools'], name: string) => {
        const found = tools.find((t) => t.name === name);
        assert.ok(found, '有工具 ' + name);
        return found;
      };
      const cashierTools = registry.view(await actorOf(cashier)).tools;
      assert.equal(tool(cashierTools, 'overview.get').permitted, false);
      assert.match(tool(cashierTools, 'overview.get').permissionReason, /出纳账号只能查看财务数据/);
      assert.equal(tool(cashierTools, 'finance.summary').permitted, true, '财务工具照常');
      assert.equal(tool(registry.view(await actorOf(viewer)).tools, 'overview.get').permitted, true);
    } finally {
      registry.close();
    }
  } finally {
    await s.close();
  }
});

test('停用账号立即下线、不能再登录；最后一个管理员不能停用', async () => {
  const s = await withAccounts([['虚构只读', 'viewer']]);
  const { h } = s;
  try {
    const viewer = await h.login('虚构只读', pass);
    const users = await accountsIn(await h.send('/auth/users', undefined, h.cookie));
    const id = (name: string) => accountNamed(users, name).id;
    assert.equal((await h.send('/auth/users/' + id('虚构只读'), { disabled: true }, h.cookie, { method: 'PUT' })).status, 200);
    assert.equal((await h.send('/orders', undefined, viewer)).status, 401);
    assert.equal((await h.send('/auth/login', { name: '虚构只读', password: pass })).status, 403);
    assert.equal((await h.send('/auth/users/' + id(testAdmin.name), { disabled: true }, h.cookie, { method: 'PUT' })).status, 409);
  } finally {
    await s.close();
  }
});

test('改自己的密码要先对上当前密码，改完当前会话保留', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  try {
    const change = (current: string) => h.send('/auth/password', { current, password: 'Fictional-admin-456' }, h.cookie);
    assert.equal((await change('Wrong-password-1')).status, 401);
    assert.equal((await change(testAdmin.password)).status, 200);
    assert.equal((await h.send('/orders', undefined, h.cookie)).status, 200);
  } finally {
    await h.close();
    store.close();
  }
});

test('登录在算哈希的时候本人改了密码：用旧密码的这次登录不成功', async () => {
  const s = await gated();
  try {
    s.gate.hold(1);
    const before = s.gate.calls,
      pending = s.h.send('/auth/login', testAdmin);
    await s.gate.reached(before + 1);
    assert.equal((await s.change(s.h.cookie, 'Fictional-admin-456')).status, 200);
    s.gate.release();
    const late = await pending;
    assert.equal(late.status, 401);
    assert.equal(late.headers.get('set-cookie'), null, '没发会话');
  } finally {
    await s.close();
  }
});

/** 本机模式起服务，核对密码的哈希能卡住；管理员已建好（不是本机管理员，验本人密码要真算） */
async function gated() {
  const gate = hashGate(),
    store = new Store(':memory:'),
    h = await startHttp(store, { auth: new AuthManager(':memory:', Date.now, { hashes: new HashQueue(gate.hash) }) });
  const change = (cookie: string, password: string) => h.send('/auth/password', { current: testAdmin.password, password }, cookie);
  return {
    gate,
    h,
    change,
    async close() {
      gate.release();
      await h.close();
      store.close();
    },
  };
}

test('两个会话同时用旧密码改密码：只能成一个', async () => {
  const s = await gated();
  try {
    const other = await s.h.login(testAdmin.name, testAdmin.password);
    const before = s.gate.calls;
    s.gate.hold(2);
    const both = [s.change(s.h.cookie, 'Fictional-first-123'), s.change(other, 'Fictional-second-123')];
    await s.gate.reached(before + 2);
    s.gate.release();
    assert.deepEqual((await Promise.all(both)).map((r) => r.status).sort(), [200, 401]);
  } finally {
    await s.close();
  }
});

test('进模式在算哈希时这个会话被撤了（本人在别处改了密码）：没进成', async () => {
  const s = await gated();
  try {
    const other = await s.h.login(testAdmin.name, testAdmin.password);
    const before = s.gate.calls;
    s.gate.hold(1);
    const entering = s.h.send('/auth/super-admin/enter', { password: testAdmin.password }, other);
    await s.gate.reached(before + 1);
    assert.equal((await s.change(s.h.cookie, 'Fictional-changed-123')).status, 200);
    s.gate.release();
    const r = await entering;
    assert.equal(r.status, 401);
    assert.equal(await messageOf(r), '请先登录管理账号。');
  } finally {
    await s.close();
  }
});

test('改密码在算哈希时账号被停用了：没改成，密码还是原来的', async () => {
  const s = await gated();
  try {
    await s.h.enterSuperMode();
    const made = await s.h.send('/auth/users', { name: '虚构员工', password: 'Fictional-staff-123', level: 'staff' }, s.h.cookie);
    const id = accountNamed(await accountsIn(made), '虚构员工').id;
    const staff = await s.h.login('虚构员工', 'Fictional-staff-123');
    const stored = () => {
      const row = one(s.h.auth.db, rows.users.pick({ password_hash: true }), 'SELECT password_hash FROM users WHERE id=?', id);
      assert.ok(row, '虚构员工还在账号库里');
      return row.password_hash;
    };
    const was = stored();
    const before = s.gate.calls;
    s.gate.hold(1);
    const changing = s.h.send('/auth/password', { current: 'Fictional-staff-123', password: 'Fictional-staff-456' }, staff);
    await s.gate.reached(before + 1);
    assert.equal((await s.h.send('/auth/users/' + id, { disabled: true }, s.h.cookie, { method: 'PUT' })).status, 200);
    s.gate.release();
    assert.equal((await changing).status, 401);
    assert.equal(stored(), was);
  } finally {
    await s.close();
  }
});

/** 账号库里记了几次“验本人密码没通过” */
const stepUpFailures = (auth: AuthManager) => count(auth.db, "SELECT count(*) FROM auth_events WHERE action='step-up-failed'");

test('登录以后账号被从库里删掉：进超级管理员模式回 401 要重新登录，不记“验密码没通过”', async () => {
  const s = await gated();
  try {
    s.h.auth.db.prepare('DELETE FROM users WHERE name=?').run(testAdmin.name);
    const r = await s.h.send('/auth/super-admin/enter', { password: testAdmin.password }, s.h.cookie);
    assert.equal(r.status, 401);
    assert.match(await r.text(), /请先登录管理账号。/);
    assert.equal(stepUpFailures(s.h.auth), 0);
  } finally {
    await s.close();
  }
});

test('改密码在算哈希时账号被从库里删掉：回 401 要重新登录，不记“验密码没通过”', async () => {
  const s = await gated();
  try {
    const before = s.gate.calls;
    s.gate.hold(1);
    const changing = s.change(s.h.cookie, 'Fictional-admin-456');
    await s.gate.reached(before + 1);
    s.h.auth.db.prepare('DELETE FROM users WHERE name=?').run(testAdmin.name);
    s.gate.release();
    const r = await changing;
    assert.equal(r.status, 401);
    assert.match(await r.text(), /请先登录管理账号。/);
    assert.equal(stepUpFailures(s.h.auth), 0);
  } finally {
    await s.close();
  }
});

test('账号库里的密码哈希坏了：登录当密码错，服务端日志只记账号编号', async (t) => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  const logged = t.mock.method(console, 'error', () => {});
  try {
    h.auth.db.prepare("UPDATE users SET password_hash='abcd'").run();
    const r = await h.send('/auth/login', testAdmin);
    assert.equal(r.status, 401);
    assert.equal(await messageOf(r), '用户名或密码错误。');
    assert.equal(logged.mock.callCount(), 1);
    const line = String(logged.mock.calls[0].arguments[0]);
    assert.match(line, /密码哈希格式不对/);
    assert.ok(!line.includes(testAdmin.password) && !line.includes(testAdmin.name));
  } finally {
    await h.close();
    store.close();
  }
});

test('验证本人密码没填：提示说“密码”，不露英文字段名', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  try {
    const r = await h.send('/auth/super-admin/enter', {}, h.cookie);
    assert.equal(r.status, 400);
    const message = await messageOf(r);
    assert.match(message, /^密码：/);
    assert.doesNotMatch(message, /password/);
  } finally {
    await h.close();
    store.close();
  }
});

test('账号库存的是加盐哈希；登录 Cookie 是 HttpOnly、SameSite=Strict；建过管理员后不能再建', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store, { admin: false });
  try {
    const r = await h.send('/auth/setup', testAdmin);
    const cookie = r.headers.get('set-cookie');
    assert.ok(cookie, '发了登录 Cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    const row = one(h.auth.db, rows.users.pick({ salt: true, password_hash: true }), 'SELECT salt,password_hash FROM users');
    assert.ok(row, '建出了管理员');
    assert.match(row.salt, /^[0-9a-f]{48}$/);
    assert.match(row.password_hash, /^[0-9a-f]{128}$/);
    assert.ok(!JSON.stringify(await (await h.send('/auth/state', undefined, cookieOf(r))).json()).includes('password'));
    assert.equal((await h.send('/auth/setup', { name: '另一个管理员', password: 'Fictional-admin-456' })).status, 409);
  } finally {
    await h.close();
    store.close();
  }
});

test('本机模式重启后要重新登录：同一个账号库新开一次，原来的 Cookie 不再认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-auth-restart-')),
    file = join(dir, 'users.sqlite'),
    store = new Store(':memory:'),
    h = await startHttp(store, { auth: new AuthManager(file) });
  // 只带 Cookie 的原始请求（AuthManager.actor 只看请求头和连接）；没开本机管理，用不到对方地址
  const request = new IncomingMessage(new Socket());
  request.headers.cookie = h.cookie;
  const reopened = new AuthManager(file);
  try {
    assert.equal(h.auth.actor(request)?.name, testAdmin.name, '重启前认得');
    assert.equal(reopened.actor(request), null);
  } finally {
    reopened.close();
    await h.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
