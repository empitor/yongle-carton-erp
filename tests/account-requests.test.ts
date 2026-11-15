// 申请账号、忘记密码、临时密码。全部用临时目录或内存库和虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AuthManager } from '../server/core/auth.js';
import { Store } from '../server/core/db.js';
import { count, many, one, rows } from '../server/core/index.js';
import { passwordAllowed, passwordPattern } from '../shared/core/password-policy.js';
import { startHttp, userList } from './http-fixture.js';
import {
  forgetAccount,
  lastUsedLabel,
  readRecentAccounts,
  rememberAccount,
} from '../src/recent-accounts.js';

const adminPassword = 'Fictional-admin-123';

/** 测试数据里一定有的记录：没有就让测试失败 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error('测试数据：没有' + what);
  return value;
}

const read = async <T extends z.ZodType>(response: Response | Promise<Response>, schema: T): Promise<z.output<T>> =>
  schema.parse(await (await response).json());

const requestItemSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  note: z.string().optional(),
  nameTaken: z.boolean().optional(),
  password_hash: z.unknown().optional(),
  salt: z.unknown().optional(),
});
const requestsSchema = z.looseObject({ requests: z.array(requestItemSchema) });
const approveResetSchema = z.looseObject({ temporaryPassword: z.string(), requests: z.array(requestItemSchema) });
const resetPasswordSchema = z.looseObject({ temporaryPassword: z.string() });
const authStateSchema = z.looseObject({
  configured: z.boolean(),
  pendingRequests: z.number().optional(),
  level: z.string().optional(),
  actor: z
    .looseObject({
      id: z.string(),
      role: z.string().optional(),
      mustChangePassword: z.boolean().optional(),
    })
    .nullable(),
});
const messageSchema = z.looseObject({ message: z.string() });
const setupSchema = z.looseObject({ actor: z.looseObject({ role: z.string() }) });

async function start(file = ':memory:') {
  const clock = { now: Date.now() };
  const store = new Store(':memory:'),
    h = await startHttp(store, { auth: new AuthManager(file, () => clock.now) });
  // 处理申请、发临时密码要在超级管理员模式里
  await h.enterSuperMode();
  const stop = async () => {
    await h.close();
    store.close();
  };
  const requests = async () => (await read(h.send('/auth/requests', undefined, h.cookie), requestsSchema)).requests;
  return { auth: h.auth, send: h.send, login: h.login, admin: h.cookie, stop, requests, clock };
}

test('申请账号：通过之前不能登录，管理员选级别后用自己设的密码登录', async () => {
  const s = await start();
  try {
    const password = 'Fictional-applicant-1';
    const applied = await s.send('/auth/apply', { name: '虚构申请人', password, note: '仓库' });
    assert.equal(applied.status, 202);
    assert.deepEqual(await applied.json(), { ok: true });
    assert.equal((await s.send('/auth/login', { name: '虚构申请人', password })).status, 401);

    const state = await read(s.send('/auth/state', undefined, s.admin), authStateSchema);
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
    assert.deepEqual((await read(approved, requestsSchema)).requests, []);

    const cookie = await s.login('虚构申请人', password);
    const own = await read(s.send('/auth/state', undefined, cookie), authStateSchema);
    assert.equal(own.level, 'viewer');
    assert.ok(own.actor);
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
    assert.equal(count(db, 'SELECT COUNT(*) FROM account_requests'), 0);
    const actions = many(db, rows.auth_events.pick({ action: true }), 'SELECT action FROM auth_events').map((e) => e.action);
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
    assert.deepEqual(list.map((r) => r.name), ['虚构员工'], '不存在的账号不进列表，重复提交只算一条');
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
    const body = await read(approved, approveResetSchema);
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
    const state = await read(s.send('/auth/state', undefined, cookie), authStateSchema);
    assert.ok(state.actor);
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
    const after = await read(s.send('/auth/state', undefined, cookie), authStateSchema);
    assert.ok(after.actor);
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
    const users = userList(await read(s.send('/auth/users', undefined, s.admin), z.record(z.string(), z.unknown())));
    const id = must(users.find((u) => u.name === '虚构员工'), '虚构员工').id;
    const reset = await s.send('/auth/users/' + id + '/password', {}, s.admin);
    const temporary = (await read(reset, resetPasswordSchema)).temporaryPassword;
    await s.send('/auth/apply', { name: '虚构申请人', password: 'Fictional-applicant-1' });

    // 管理员会话 8 小时过期，这里只看登录结果
    s.clock.now += 25 * 3600_000;
    const expired = await s.send('/auth/login', { name: '虚构员工', password: temporary });
    assert.equal(expired.status, 401);
    assert.match((await read(expired, messageSchema)).message, /临时密码已过期/);

    s.clock.now += 14 * 24 * 3600_000;
    const admin = await s.login('虚构管理员', adminPassword);
    assert.deepEqual((await read(s.send('/auth/requests', undefined, admin), requestsSchema)).requests, []);
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
    const state = await read(s.send('/auth/state', undefined, s.admin), authStateSchema);
    assert.ok(state.actor);
    assert.equal((await s.send('/auth/users/' + state.actor.id + '/password', {}, s.admin)).status, 409);
    await s.login('虚构管理员', adminPassword);

    const temporary = s.auth.resetPassword('虚构管理员');
    assert.equal((await s.send('/auth/state', undefined, s.admin)).status, 200);
    const cookie = await s.login('虚构管理员', temporary);
    const locked = await read(s.send('/auth/state', undefined, cookie), authStateSchema);
    assert.ok(locked.actor);
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
    assert.equal((await s.send('/auth/apply', application, '', { csrf: null })).status, 403);
    assert.equal((await s.send('/auth/forgot', { name: 'x' }, '', { csrf: null })).status, 403);
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
    empty = await startHttp(store, { admin: false });
  try {
    const weak = await empty.send('/auth/setup', { name: '虚构管理员', password: 'alllowercase' });
    assert.equal(weak.status, 400, '第一个管理员也要符合规则');
  } finally {
    await empty.close();
    store.close();
  }
});

test('登录不提示密码长度', async () => {
  const s = await start();
  try {
    const short = await s.send('/auth/login', { name: '虚构管理员', password: 'short' });
    assert.equal(short.status, 401);
    assert.equal((await read(short, messageSchema)).message, '用户名或密码错误。');
  } finally {
    await s.stop();
  }
});

/** 0.8.4 的账号库（虚构数据）：照 0.8.4 的语句建，没有记版本。0.9.0 打开时删掉重建。 */
const accountDatabase084 = `CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,permissions TEXT NOT NULL);
  CREATE TABLE auth_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL);
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','super_admin'));
  ALTER TABLE users ADD COLUMN disabled_at TEXT;
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN temp_password_expires INTEGER;
  CREATE TABLE account_requests(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('register','reset')),
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    salt TEXT,
    password_hash TEXT,
    client TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX account_requests_reset ON account_requests(name) WHERE kind='reset';`;
const accountDatabaseState = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: must(one(db, z.object({ user_version: z.number() }), 'PRAGMA user_version'), 'user_version').user_version,
      schema: many(db, z.object({ name: z.string(), sql: z.string().nullable() }), "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
      users: many(db, rows.users, 'SELECT * FROM users ORDER BY name'),
      requests: many(db, rows.account_requests, 'SELECT * FROM account_requests ORDER BY id'),
    };
  } finally {
    db.close();
  }
};

test('旧账号库（0.8.4 留下的，没记版本）打开时删掉重建：旧账号不留，程序回到首次使用，可以照常建管理员、登录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-account-'));
  const file = join(dir, 'users.sqlite');
  const old = new DatabaseSync(file);
  old.exec(accountDatabase084);
  const salt = 'fictional-salt';
  old
    .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), '虚构老管理员', salt, scryptSync('oldadmin', salt, 64).toString('hex'), '[]', 'super_admin');
  old.close();
  assert.equal(accountDatabaseState(file).version, 0, '0.8.4 的账号库没有记版本');
  const store = new Store(':memory:'),
    h = await startHttp(store, { auth: new AuthManager(file), admin: false });
  try {
    const rebuilt = accountDatabaseState(file);
    assert.equal(rebuilt.version, 1, '按当前结构重建，记成第 1 版');
    assert.deepEqual(rebuilt.users, [], '旧账号不留');
    assert.ok(rebuilt.schema.some((t) => t.name === 'auth_sessions'), '登录会话表一起建好');
    assert.deepEqual(readdirSync(dir).filter((n) => n !== 'users.sqlite' && !/-(wal|shm)$/.test(n)), [], '不留备份');
    const post = (path: string, body: unknown) => h.send(path, body);
    assert.equal((await read(fetch(h.api + '/auth/state'), authStateSchema)).configured, false, '回到首次使用');
    assert.equal((await post('/auth/login', { name: '虚构老管理员', password: 'oldadmin' })).status, 401, '旧账号登不上');
    const setup = await post('/auth/setup', { name: '虚构新管理员', password: adminPassword });
    assert.equal(setup.status, 200);
    assert.equal((await read(setup, setupSchema)).actor.role, 'super_admin');
    assert.equal((await post('/auth/login', { name: '虚构新管理员', password: adminPassword })).status, 200);
  } finally {
    await h.close();
    store.close();
  }
  // 再打开一次：已经是当前版本，原样打开，新建的管理员还在
  const again = new AuthManager(file);
  try {
    assert.equal(again.configured(), true);
  } finally {
    again.close();
  }
  rmSync(dir, { recursive: true, force: true });
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

