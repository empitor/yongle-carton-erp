// 申请账号、忘记密码、临时密码。全部用临时目录或内存库和虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { normalizeAiSettingsHash } from '../shared/assistant-navigation.js';
import { passwordAllowed, passwordPattern } from '../shared/password-policy.js';
import {
  forgetAccount,
  lastUsedLabel,
  readRecentAccounts,
  rememberAccount,
} from '../src/recent-accounts.js';

const adminPassword = 'Fictional-admin-123';

async function start(file = ':memory:') {
  const clock = { now: Date.now() };
  const store = new Store(':memory:'),
    auth = new AuthManager(file, () => clock.now),
    server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  const send = (path: string, body?: unknown, cookie = '', csrf: string | null = auth.csrf) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-ERP-Auth-Token': csrf } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (name: string, password: string) => {
    const response = await send('/auth/login', { name, password });
    assert.equal(response.status, 200, name + ' 应该能登录');
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const setup = await send('/auth/setup', { name: '虚构管理员', password: adminPassword });
  const admin = setup.headers.get('set-cookie')!.split(';')[0];
  const stop = async () => {
    await new Promise((r) => server.close(r));
    auth.close();
    store.close();
  };
  const requests = async () => (await (await send('/auth/requests', undefined, admin)).json()).requests;
  return { auth, send, login, admin, stop, requests, clock };
}

test('申请账号：通过之前不能登录，管理员选级别后用自己设的密码登录', async () => {
  const s = await start();
  try {
    const password = 'Fictional-applicant-1';
    const applied = await s.send('/auth/apply', { name: '虚构申请人', password, note: '仓库' });
    assert.equal(applied.status, 202);
    assert.deepEqual(await applied.json(), { ok: true });
    assert.equal((await s.send('/auth/login', { name: '虚构申请人', password })).status, 401);

    const state = await (await s.send('/auth/state', undefined, s.admin)).json();
    assert.equal(state.pendingRequests, 1);
    assert.equal(state.level, 'admin');
    const [request] = await s.requests();
    assert.equal(request.kind, 'register');
    assert.equal(request.note, '仓库');
    assert.equal(request.password_hash, undefined, '列表不带密码哈希');
    assert.equal(request.salt, undefined);

    // 没选级别不能通过，申请人不会默认拿到任何权限
    assert.equal((await s.send('/auth/requests/' + request.id + '/approve', {}, s.admin)).status, 400);
    const approved = await s.send('/auth/requests/' + request.id + '/approve', { level: 'viewer' }, s.admin);
    assert.equal(approved.status, 200);
    assert.deepEqual((await approved.json()).requests, []);

    const cookie = await s.login('虚构申请人', password);
    const own = await (await s.send('/auth/state', undefined, cookie)).json();
    assert.equal(own.level, 'viewer');
    assert.equal(own.actor.mustChangePassword, undefined, '自己设的密码不用强制改');
    assert.equal(own.pendingRequests, undefined, '非管理员看不到待处理数量');
    assert.equal((await s.send('/orders', undefined, cookie)).status, 200);
    assert.equal((await s.send('/customers', { name: '虚构写入' }, cookie)).status, 403);
    assert.equal((await s.send('/auth/requests', undefined, cookie)).status, 403);
    assert.equal(
      (await s.send('/auth/requests/' + randomUUID() + '/approve', { level: 'admin' }, cookie)).status,
      403,
    );
    assert.equal((await s.send('/auth/requests')).status, 401);
  } finally {
    await s.stop();
  }
});

test('申请账号重名：不提示申请人，不影响原账号，管理员改名后才能通过', async () => {
  const s = await start();
  try {
    const applied = await s.send('/auth/apply', {
      name: '虚构管理员',
      password: 'Fictional-impostor-1',
    });
    assert.equal(applied.status, 202, '和正常申请一样的回答');
    const [request] = await s.requests();
    assert.equal(request.nameTaken, true);
    const url = '/auth/requests/' + request.id;
    assert.equal((await s.send(url + '/approve', { level: 'viewer' }, s.admin)).status, 409);
    await s.login('虚构管理员', adminPassword);
    assert.equal(
      (await s.send('/auth/login', { name: '虚构管理员', password: 'Fictional-impostor-1' })).status,
      401,
    );
    assert.equal(
      (await s.send(url + '/approve', { level: 'viewer', name: '虚构改名' }, s.admin)).status,
      200,
    );
    await s.login('虚构改名', 'Fictional-impostor-1');
  } finally {
    await s.stop();
  }
});

test('拒绝申请后记录连同密码哈希一起删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-account-'));
  const file = join(dir, 'users.sqlite');
  const s = await start(file);
  try {
    await s.send('/auth/apply', { name: '虚构拒绝', password: 'Fictional-rejected-1' });
    const [request] = await s.requests();
    assert.equal((await s.send('/auth/requests/' + request.id + '/reject', {}, s.admin)).status, 200);
    assert.equal((await s.send('/auth/requests/' + request.id + '/reject', {}, s.admin)).status, 404);
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_requests').get()!.n, 0);
    const actions = db.prepare('SELECT action FROM auth_events').all().map((e) => String(e.action));
    db.close();
    assert.ok(actions.includes('account-requested:' + request.id));
    assert.ok(actions.includes('account-request-rejected:' + request.id));
    assert.equal((await s.send('/auth/login', { name: '虚构拒绝', password: 'Fictional-rejected-1' })).status, 401);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('忘记密码：不暴露账号是否存在；管理员确认前原密码不变；用原密码登录会撤销申请', async () => {
  const s = await start();
  try {
    await s.send('/auth/users', { name: '虚构员工', password: 'Fictional-staff-123', level: 'staff' }, s.admin);
    const known = await s.send('/auth/forgot', { name: '虚构员工' });
    const unknown = await s.send('/auth/forgot', { name: '查无此人' });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, known.status);
    assert.deepEqual(await unknown.json(), await known.json());
    await s.send('/auth/forgot', { name: '虚构员工' });
    const list = await s.requests();
    assert.deepEqual(list.map((r: any) => r.name), ['虚构员工'], '不存在的账号不进列表，重复提交只算一条');
    assert.equal(list[0].kind, 'reset');

    await s.login('虚构员工', 'Fictional-staff-123');
    assert.deepEqual(await s.requests(), [], '想起密码了，申请自动取消');
  } finally {
    await s.stop();
  }
});

test('临时密码：旧密码和旧会话立即失效；改密前只能看状态和改密；改完恢复正常', async () => {
  const s = await start();
  try {
    await s.send('/auth/users', { name: '虚构员工', password: 'Fictional-staff-123', level: 'staff' }, s.admin);
    const old = await s.login('虚构员工', 'Fictional-staff-123');
    await s.send('/auth/forgot', { name: '虚构员工' });
    const [request] = await s.requests();
    const approved = await s.send('/auth/requests/' + request.id + '/approve', {}, s.admin);
    assert.equal(approved.status, 200);
    const body = await approved.json();
    const temporary = body.temporaryPassword;
    assert.match(temporary, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    assert.doesNotMatch(temporary, /[01oil]/, '不含容易读错的字符');
    assert.deepEqual(body.requests, []);

    assert.equal((await s.send('/orders', undefined, old)).status, 401, '旧会话失效');
    assert.equal(
      (await s.send('/auth/login', { name: '虚构员工', password: 'Fictional-staff-123' })).status,
      401,
      '旧密码失效',
    );

    const cookie = await s.login('虚构员工', temporary);
    const state = await (await s.send('/auth/state', undefined, cookie)).json();
    assert.equal(state.actor.mustChangePassword, true);
    for (const path of ['/orders', '/customers', '/dashboard', '/ai/settings', '/auth/users'])
      assert.equal((await s.send(path, undefined, cookie)).status, 401, path + ' 改密前不能用');
    assert.equal((await s.send('/customers', { name: '虚构写入' }, cookie)).status, 401);
    assert.equal(
      (await s.send('/auth/password', { current: temporary, password: temporary }, cookie)).status,
      400,
      '不能改回同一个',
    );
    assert.equal(
      (await s.send('/auth/password', { current: temporary, password: 'short' }, cookie)).status,
      400,
    );
    assert.equal(
      (await s.send('/auth/password', { current: temporary, password: 'Fictional-staff-456' }, cookie)).status,
      200,
    );
    const after = await (await s.send('/auth/state', undefined, cookie)).json();
    assert.equal(after.actor.mustChangePassword, undefined);
    assert.equal((await s.send('/orders', undefined, cookie)).status, 200, '当前设备不用重新登录');
    assert.equal((await s.send('/auth/login', { name: '虚构员工', password: temporary })).status, 401);
    await s.login('虚构员工', 'Fictional-staff-456');
  } finally {
    await s.stop();
  }
});

test('临时密码 24 小时过期，申请 14 天过期', async () => {
  const s = await start();
  try {
    await s.send('/auth/users', { name: '虚构员工', password: 'Fictional-staff-123', level: 'staff' }, s.admin);
    const users = (await (await s.send('/auth/users', undefined, s.admin)).json()).users;
    const id = users.find((u: any) => u.name === '虚构员工').id;
    const reset = await s.send('/auth/users/' + id + '/password', {}, s.admin);
    const temporary = (await reset.json()).temporaryPassword;
    await s.send('/auth/apply', { name: '虚构申请人', password: 'Fictional-applicant-1' });

    // 管理员会话 8 小时过期，这里只看登录结果
    s.clock.now += 25 * 3600_000;
    const expired = await s.send('/auth/login', { name: '虚构员工', password: temporary });
    assert.equal(expired.status, 401);
    assert.match((await expired.json()).message, /临时密码已过期/);

    s.clock.now += 14 * 24 * 3600_000;
    const admin = await s.login('虚构管理员', adminPassword);
    assert.deepEqual((await (await s.send('/auth/requests', undefined, admin)).json()).requests, []);
  } finally {
    await s.stop();
  }
});

test('管理员不能给自己生成临时密码，命令行找回可以，且同样要先改密', async () => {
  const s = await start();
  try {
    await s.send('/auth/forgot', { name: '虚构管理员' });
    const [request] = await s.requests();
    assert.equal((await s.send('/auth/requests/' + request.id + '/approve', {}, s.admin)).status, 409);
    const state = await (await s.send('/auth/state', undefined, s.admin)).json();
    assert.equal((await s.send('/auth/users/' + state.actor.id + '/password', {}, s.admin)).status, 409);
    await s.login('虚构管理员', adminPassword);

    const temporary = s.auth.resetPassword('虚构管理员');
    assert.equal((await s.send('/auth/state', undefined, s.admin)).status, 200);
    const cookie = await s.login('虚构管理员', temporary);
    const locked = await (await s.send('/auth/state', undefined, cookie)).json();
    assert.equal(locked.actor.mustChangePassword, true);
    assert.equal(locked.pendingRequests, undefined);
    assert.equal((await s.send('/auth/requests', undefined, cookie)).status, 401);
    assert.equal((await s.send('/auth/super-admin/enter', { password: temporary }, cookie)).status, 401);
  } finally {
    await s.stop();
  }
});

test('公开接口要页面凭证、有频率限制和数量上限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-account-'));
  const file = join(dir, 'users.sqlite');
  const s = await start(file);
  try {
    const application = { name: '虚构申请人', password: 'Fictional-applicant-1' };
    assert.equal((await s.send('/auth/apply', application, '', null)).status, 403);
    assert.equal((await s.send('/auth/forgot', { name: 'x' }, '', null)).status, 403);
    assert.equal((await s.send('/auth/apply', { ...application, password: 'short' })).status, 400);
    assert.equal((await s.send('/auth/apply', { ...application, level: 'admin' })).status, 400, '不能自己选级别');
    for (let i = 0; i < 10; i++)
      assert.equal((await s.send('/auth/forgot', { name: '查无此人' })).status, 202);
    assert.equal((await s.send('/auth/forgot', { name: '查无此人' })).status, 429);

    const db = new DatabaseSync(file);
    const insert = db.prepare(
      "INSERT INTO account_requests(id,kind,name,client,created_at) VALUES(?,'register',?,'192.0.2.1',?)",
    );
    for (let i = 0; i < 50; i++) insert.run(randomUUID(), '虚构批量' + i, s.clock.now);
    db.close();
    assert.equal((await s.send('/auth/apply', application)).status, 429, '待处理太多，不再收');

    s.clock.now += 3600_000;
    const open = new DatabaseSync(file);
    open.exec('DELETE FROM account_requests');
    open.close();
    for (let i = 0; i < 5; i++) assert.equal((await s.send('/auth/apply', application)).status, 202);
    assert.equal((await s.send('/auth/apply', application)).status, 429, '同一地址一小时最多 5 次');
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新设密码至少 8 位，要有大写和小写字母；建号、申请、改密都检查', async () => {
  for (const good of ['Abcdefgh', 'aB345678', 'Fictional-Password', 'A'.repeat(127) + 'b'])
    assert.equal(passwordAllowed(good), true, good);
  for (const bad of ['', 'Abcdefg', 'abcdefgh', 'ABCDEFGH', '12345678', 'A'.repeat(128) + 'b'])
    assert.equal(passwordAllowed(bad), false, bad);
  const pattern = new RegExp('^(?:' + passwordPattern + ')$');
  for (const sample of ['Abcdefgh', 'Abcdefg', 'abcdefgh', 'ABCDEFGH', '12345678'])
    assert.equal(pattern.test(sample), passwordAllowed(sample), '输入框和服务端要一致：' + sample);

  const s = await start();
  try {
    for (const password of ['abcdefgh', 'ABCDEFGH', 'Abcdefg']) {
      assert.equal((await s.send('/auth/apply', { name: '虚构申请人', password })).status, 400, password);
      assert.equal(
        (await s.send('/auth/users', { name: '虚构员工', password, level: 'staff' }, s.admin)).status,
        400,
        password,
      );
      assert.equal(
        (await s.send('/auth/password', { current: adminPassword, password }, s.admin)).status,
        400,
        password,
      );
    }
    const created = await s.send('/auth/users', { name: '虚构员工', password: 'Abcdefgh', level: 'staff' }, s.admin);
    assert.equal(created.status, 201, '8 位带大小写就够了');
    await s.login('虚构员工', 'Abcdefgh');
  } finally {
    await s.stop();
  }
  const store = new Store(':memory:'),
    empty = new AuthManager(':memory:'),
    server = createApp(store, { auth: empty }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const weak = await fetch('http://127.0.0.1:' + (server.address() as any).port + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': empty.csrf },
      body: JSON.stringify({ name: '虚构管理员', password: 'alllowercase' }),
    });
    assert.equal(weak.status, 400, '第一个管理员也要符合规则');
  } finally {
    await new Promise((r) => server.close(r));
    empty.close();
    store.close();
  }
});

test('登录不提示密码长度', async () => {
  const s = await start();
  try {
    const short = await s.send('/auth/login', { name: '虚构管理员', password: 'short' });
    assert.equal(short.status, 401);
    assert.equal((await short.json()).message, '用户名或密码错误。');
  } finally {
    await s.stop();
  }
});

test('旧账号库打开后自动加字段，不符合新规则的旧密码也照常登录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-account-'));
  const file = join(dir, 'users.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,
    permissions TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','super_admin')),disabled_at TEXT);
    CREATE TABLE auth_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL);`);
  const salt = 'fictional-salt';
  old
    .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), '虚构老账号', salt, scryptSync('oldlowercase', salt, 64).toString('hex'), '["business:edit"]', 'admin');
  old.close();
  const store = new Store(':memory:'),
    auth = new AuthManager(file),
    server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构老账号', password: 'oldlowercase' }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const state = await (await fetch(base + '/auth/state', { headers: { Cookie: cookie } })).json();
    assert.equal(state.level, 'staff');
    assert.equal(state.actor.mustChangePassword, undefined);
  } finally {
    await new Promise((r) => server.close(r));
    auth.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('这台设备用过的账号：只记用户名，最多 5 个，最近的在前，能移除，存储坏了不报错', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  assert.deepEqual(readRecentAccounts(storage), []);
  for (const name of ['甲', '乙', '丙', '丁', '戊', '己']) rememberAccount(storage, name);
  rememberAccount(storage, '丙');
  assert.deepEqual(readRecentAccounts(storage).map((a) => a.name), ['丙', '己', '戊', '丁', '乙']);
  assert.deepEqual(forgetAccount(storage, '己').map((a) => a.name), ['丙', '戊', '丁', '乙']);
  assert.doesNotMatch([...data.values()].join(), /password|token/);
  data.set('erp-recent-accounts', '{坏数据');
  assert.deepEqual(readRecentAccounts(storage), []);
  data.set('erp-recent-accounts', JSON.stringify([{ name: 1 }, { name: '甲', at: '2026-11-06T01:00:00Z' }]));
  assert.deepEqual(readRecentAccounts(storage).map((a) => a.name), ['甲']);
  const now = new Date(2026, 10, 6, 12);
  assert.equal(lastUsedLabel(new Date(2026, 10, 6, 1).toISOString(), now), '今天用过');
  assert.equal(lastUsedLabel(new Date(2026, 10, 5, 23).toISOString(), now), '昨天用过');
  assert.equal(lastUsedLabel(new Date(2026, 9, 2, 8).toISOString(), now), '10 月 2 日用过');
  assert.equal(lastUsedLabel('不是日期', now), '');
});

test('设置里的旧账号页签转到账号管理页', () => {
  assert.equal(normalizeAiSettingsHash('#ai-settings?tab=accounts'), '#accounts');
  assert.equal(normalizeAiSettingsHash('#ai-settings?tab=channels'), '#ai-settings?tab=channels');
});
