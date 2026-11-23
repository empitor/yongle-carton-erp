// 部署模式：配置校验、两个入口（本机维护入口、给 Caddy 的代理入口）各自的规矩、登录 Cookie、会话存账号库。虚构数据。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuthManager } from '../server/accounts/index.js';
import { Store } from '../server/core/db.js';
import { readDeployment } from '../server/core/deployment.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { AssistantManager } from '../server/assistant/manager.js';
import { assistantDeps } from './assistant-fixture.js';
import { fakeDeepSeek, testProtector } from './fake-deepseek.js';
import { cookieOf, setCookieOf, startProxied, stateActor, userList, type AppOptions } from './http-fixture.js';

const owner = { name: '虚构维护员', password: 'Fictional-owner-password' };
const host = 'erp.example.invalid';

test('部署配置：不合规的值都拒绝启动，并说清是哪一项', () => {
  const ok = { ERP_DEPLOYMENT: '1', ERP_ALLOWED_HOSTS: host };
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...ok, ERP_DEPLOYMENT: '2' }, /ERP_DEPLOYMENT 只接受 0 或 1/],
    [{ ...ok, ERP_PROXY_PORT: '3001' }, /ERP_PROXY_PORT 必须是与 PORT 不同的有效端口/],
    [{ ...ok, ERP_PROXY_PORT: '70000' }, /ERP_PROXY_PORT/],
    [{ ERP_DEPLOYMENT: '1' }, /ERP_ALLOWED_HOSTS 必须填写有效的公网域名/],
    [{ ...ok, ERP_ALLOWED_HOSTS: 'localhost' }, /ERP_ALLOWED_HOSTS/],
    [{ ...ok, ERP_ALLOWED_HOSTS: '127.0.0.1' }, /ERP_ALLOWED_HOSTS/],
    [{ ...ok, ERP_ALLOWED_ORIGINS: 'http://' + host }, /ERP_ALLOWED_ORIGINS 必须是允许域名的 HTTPS 来源/],
    [{ ...ok, ERP_ALLOWED_ORIGINS: 'https://other.example.invalid' }, /ERP_ALLOWED_ORIGINS/],
    [{ ...ok, ERP_BACKUP_COPY_DIR: 'relative/copies' }, /ERP_BACKUP_COPY_DIR 必须使用绝对路径/],
    [{ ...ok, ERP_BACKUP_COPY_KEEP: '3' }, /ERP_BACKUP_COPY_KEEP 必须是正整数，且需要配置备份复制目录/],
    [{ ...ok, ERP_BACKUP_COPY_DIR: join(tmpdir(), 'copies'), ERP_BACKUP_COPY_KEEP: '0' }, /ERP_BACKUP_COPY_KEEP/],
  ];
  for (const [env, message] of cases) assert.throws(() => readDeployment(env, 3001), message, JSON.stringify(env));
});

test('部署配置：省略或 0 是本机模式；只给域名时来源默认是 https 加域名、代理端口默认 3002', () => {
  assert.equal(readDeployment({}, 3001), undefined);
  assert.equal(readDeployment({ ERP_DEPLOYMENT: '0' }, 3001), undefined);
  const d = readDeployment({ ERP_DEPLOYMENT: '1', ERP_ALLOWED_HOSTS: 'ERP.Example.invalid' }, 3001);
  assert.ok(d);
  assert.equal(d.proxyPort, 3002);
  assert.deepEqual([...d.hosts], [host]);
  assert.deepEqual([...d.origins], ['https://' + host]);
});

test('备案号设置：没填、只填空白都没有；填了去掉首尾空白原样记下，两项各自可以不填', () => {
  const base = { ERP_DEPLOYMENT: '1', ERP_ALLOWED_HOSTS: host };
  assert.equal(readDeployment(base, 3001)?.filing, undefined);
  assert.equal(readDeployment({ ...base, ERP_ICP_RECORD: '  ', ERP_POLICE_RECORD: '' }, 3001)?.filing, undefined);
  assert.deepEqual(readDeployment({ ...base, ERP_ICP_RECORD: ' 虚构ICP备00000000号 ' }, 3001)?.filing, {
    icp: '虚构ICP备00000000号',
  });
  assert.deepEqual(
    readDeployment({ ...base, ERP_ICP_RECORD: '虚构ICP备00000000号', ERP_POLICE_RECORD: '虚构公网安备 00000000000000号' }, 3001)
      ?.filing,
    { icp: '虚构ICP备00000000号', police: '虚构公网安备 00000000000000号' },
  );
});

test('登录状态接口：填了备案号时只给从域名进来的页面，本机入口不给；没填就都没有', async () => {
  const filing = { icp: '虚构ICP备00000000号' };
  const store = new Store(':memory:');
  const withFiling = await startProxied(store, {}, {
    makeAuth: (deployment) =>
      new AuthManager(':memory:', Date.now, { deployment: { ...deployment, filing }, localAdministration: true }),
  });
  const without = await startProxied(store);
  try {
    const state = async (p: typeof without, port: number, headers = {}) =>
      (await p.call(port, '/auth/state', { headers })).value.filing;
    assert.deepEqual(await state(withFiling, withFiling.proxyPort, withFiling.remote), filing);
    assert.equal(await state(withFiling, withFiling.localPort), undefined);
    assert.equal(await state(without, without.proxyPort, without.remote), undefined);
  } finally {
    await withFiling.close();
    await without.close();
    store.close();
  }
});

/** 部署模式的两个入口；账号库是临时目录里的文件、时钟可拨；维护员从本机入口建好 */
async function deployed(options: Omit<AppOptions, 'auth' | 'deployment'> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-deployment-')),
    file = join(dir, 'users.sqlite'),
    clock = { now: Date.now() },
    store = new Store(':memory:');
  const p = await startProxied(store, options, {
    makeAuth: (deployment) => new AuthManager(file, () => clock.now, { deployment, localAdministration: true }),
  });
  const setup = await p.call(p.localPort, '/auth/setup', { body: owner });
  assert.equal(setup.code, 200);
  const remoteLogin = async (account = owner) =>
    cookieOf(await p.call(p.proxyPort, '/auth/login', { headers: p.remote, body: account }));
  const remoteActor = async (cookie: string) =>
    stateActor((await p.call(p.proxyPort, '/auth/state', { headers: p.remote, cookie })).value);
  return {
    p,
    file,
    clock,
    store,
    local: cookieOf(setup),
    setup,
    remoteLogin,
    remoteActor,
    async close() {
      await p.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('代理入口只认登记的域名和本机转来的单个访客地址；本机入口带转发头就拒', async () => {
  const s = await deployed();
  const { p } = s;
  try {
    for (const headers of [
      { host },
      { ...p.remote, host: 'localhost' },
      { ...p.remote, host: 'other.example.invalid' },
      { ...p.remote, 'x-erp-client-ip': '192.0.2.8, 192.0.2.9' },
    ])
      assert.equal((await p.call(p.proxyPort, '/health', { headers })).code, 403, JSON.stringify(headers));
    assert.equal((await p.call(p.localPort, '/health', { headers: p.remote })).code, 403);
    assert.equal((await p.call(p.localPort, '/health', { headers: { 'x-forwarded-for': '127.0.0.1' } })).code, 403);
    assert.equal((await p.call(p.proxyPort, '/health', { headers: p.remote })).code, 200);
  } finally {
    await s.close();
  }
});

test('首个管理员只能在本机入口建；SSH 隧道换了端口时，来源和 Host 一致才放行', async () => {
  const store = new Store(':memory:'),
    p = await startProxied(store);
  const tunnel = 'http://127.0.0.1:13001';
  try {
    assert.equal((await p.call(p.proxyPort, '/auth/setup', { headers: p.remote, body: owner })).code, 403);
    assert.equal((await p.call(p.localPort, '/auth/setup', { headers: { origin: tunnel }, body: owner })).code, 403);
    assert.equal(
      (await p.call(p.localPort, '/auth/setup', { headers: { host: '127.0.0.1:13001', origin: tunnel }, body: owner })).code,
      200,
    );
  } finally {
    await p.close();
    store.close();
  }
});

test('代理入口的写请求来源不是登记的 HTTPS 来源就拒', async () => {
  const s = await deployed();
  try {
    const r = await s.p.call(s.p.proxyPort, '/auth/login', { headers: { ...s.p.remote, origin: 'https://bad.invalid' }, body: owner });
    assert.equal(r.code, 403);
  } finally {
    await s.close();
  }
});

test('代理入口的回答带 HSTS 和安全头（图片只多放行 blob:），本机入口不带 HSTS', async () => {
  const s = await deployed();
  try {
    assert.equal(s.setup.headers['strict-transport-security'], undefined);
    const r = await s.p.call(s.p.proxyPort, '/auth/state', { headers: s.p.remote });
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['x-frame-options']);
    const csp = String(r.headers['content-security-policy'] || '');
    assert.match(csp, /(^|;)img-src 'self' data: blob:(;|$)/);
    assert.match(csp, /(^|;)script-src 'self'(;|$)/);
    assert.match(csp, /(^|;)default-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  } finally {
    await s.close();
  }
});

test('健康检查：从域名进来只回 ok，版本号和进程号只给本机入口', async () => {
  const store = new Store(':memory:');
  const p = await startProxied(store);
  try {
    assert.deepEqual((await p.call(p.proxyPort, '/health', { headers: p.remote })).value, { ok: true });
    const local = (await p.call(p.localPort, '/health')).value;
    assert.equal(local.processId, process.pid);
    assert.ok(local.version);
  } finally {
    await p.close();
    store.close();
  }
});

test('登录 Cookie：域名入口用 __Host- 前缀加 Secure，本机入口用原名，各入口只认自己的名字', async () => {
  const s = await deployed();
  const { p } = s;
  const value = (cookie: string) => cookie.split('=')[1];
  try {
    const local = setCookieOf(s.setup);
    assert.match(local, /^erp_session=[0-9a-f]{64}; /);
    assert.doesNotMatch(local, /; Secure/);
    const remote = setCookieOf(await p.call(p.proxyPort, '/auth/login', { headers: p.remote, body: owner }));
    assert.match(remote, /^__Host-erp_session=[0-9a-f]{64}; /);
    assert.match(remote, /; Path=\/;/);
    assert.match(remote, /; Secure/);
    assert.doesNotMatch(remote, /Domain=/i);
    const token = value(remote.split(';')[0]);
    assert.equal((await s.remoteActor('__Host-erp_session=' + token))?.name, owner.name);
    assert.equal(await s.remoteActor('erp_session=' + token), null);
    const localState = await p.call(p.localPort, '/auth/state', { cookie: '__Host-erp_session=' + value(s.local) });
    assert.equal(localState.value.actor, null);
    const out = await p.call(p.proxyPort, '/auth/logout', { headers: p.remote, cookie: '__Host-erp_session=' + token, body: {} });
    assert.match(
      setCookieOf(out),
      /^__Host-erp_session=; Path=\/; Expires=Thu, 01 Jan 1970 [^;]+; HttpOnly; Secure; SameSite=Strict$/,
    );
  } finally {
    await s.close();
  }
});

test('同一个超级管理员账号：本机入口登录就是本机管理员，从域名登录的不是，要验证密码进模式', async () => {
  const s = await deployed();
  try {
    assert.equal(stateActor((await s.p.call(s.p.localPort, '/auth/state', { cookie: s.local })).value)?.localAdministrator, true);
    const cookie = await s.remoteLogin();
    const actor = await s.remoteActor(cookie);
    assert.ok(actor);
    assert.equal(actor.localAdministrator, undefined);
    assert.equal(actor.superAdminMode, false);
    const entered = await s.p.call(s.p.proxyPort, '/auth/super-admin/enter', { headers: s.p.remote, cookie, body: { password: owner.password } });
    assert.equal(stateActor(entered.value)?.superAdminMode, true);
  } finally {
    await s.close();
  }
});

test('部署模式的会话存进账号库，只存令牌的哈希；重启后还在，超级管理员模式要重进', async () => {
  const s = await deployed();
  try {
    const cookie = await s.remoteLogin();
    await s.p.call(s.p.proxyPort, '/auth/super-admin/enter', { headers: s.p.remote, cookie, body: { password: owner.password } });
    const token = cookie.split('=')[1];
    const rows = s.p.auth.db.prepare('SELECT token_hash FROM auth_sessions').all().map((r) => r.token_hash);
    assert.ok(rows.includes(createHash('sha256').update(token).digest('hex')));
    assert.ok(!rows.includes(token));
    s.p.restart();
    const actor = await s.remoteActor(cookie);
    assert.ok(actor);
    assert.equal(actor.name, owner.name);
    assert.equal(actor.superAdminMode, false);
  } finally {
    await s.close();
  }
});

test('部署模式的会话：退出、停用、8 小时到期都让它失效', async () => {
  const s = await deployed();
  const { p } = s;
  try {
    const out = await s.remoteLogin();
    await p.call(p.proxyPort, '/auth/logout', { headers: p.remote, cookie: out, body: {} });
    assert.equal(await s.remoteActor(out), null, '退出');
    const made = await p.call(p.localPort, '/auth/users', {
      cookie: s.local,
      body: { name: '虚构员工', password: 'Fictional-employee-password', level: 'staff' },
    });
    const employee = userList(made.value).find((u: { name: string }) => u.name === '虚构员工');
    assert.ok(employee);
    const staff = await s.remoteLogin({ name: employee.name, password: 'Fictional-employee-password' });
    await p.call(p.localPort, '/auth/users/' + employee.id, { cookie: s.local, body: { disabled: true }, method: 'PUT' });
    assert.equal(await s.remoteActor(staff), null, '停用');
    const later = await s.remoteLogin();
    s.clock.now += 8 * 3600_000 + 1;
    assert.equal(await s.remoteActor(later), null, '到期');
  } finally {
    await s.close();
  }
});

test('部署模式：服务器上命令行重置密码，正在跑的服务里这个账号的会话立即失效', async () => {
  const s = await deployed();
  try {
    const cookie = await s.remoteLogin();
    const cli = new AuthManager(s.file);
    try {
      cli.resetPassword(owner.name);
    } finally {
      cli.close();
    }
    assert.equal(await s.remoteActor(cookie), null);
  } finally {
    await s.close();
  }
});

test('部署模式：改密后当前设备保持登录，同一账号的其他设备立即失效', async () => {
  const s = await deployed();
  try {
    const current = await s.remoteLogin(),
      other = await s.remoteLogin();
    const changed = await s.p.call(s.p.proxyPort, '/auth/password', {
      headers: s.p.remote,
      cookie: current,
      body: { current: owner.password, password: 'Fictional-final-password' },
    });
    assert.equal(changed.code, 200);
    assert.equal((await s.remoteActor(current))?.name, owner.name);
    assert.equal(await s.remoteActor(other), null);
  } finally {
    await s.close();
  }
});

test('从域名进来，助手的语音转写照常能用', async () => {
  const fake = fakeDeepSeek({ asrText: '虚构部署语音' });
  const settings = new AiSettingsManager({ protector: testProtector, transport: fake.transport });
  settings.saveKey({ apiKey: fake.key, expectedRevision: settings.view().revision });
  const store = new Store(':memory:'),
    built = assistantDeps(store, settings),
    assistant = new AssistantManager(built.deps);
  const p = await startProxied(store, { assistant });
  try {
    await p.call(p.localPort, '/auth/setup', { body: owner });
    const cookie = cookieOf(await p.call(p.proxyPort, '/auth/login', { headers: p.remote, body: owner }));
    const heard = await p.call(p.proxyPort, '/assistant/transcribe', {
      headers: { ...p.remote, 'content-type': 'application/octet-stream' },
      cookie,
      raw: Buffer.alloc(16000 * 2),
    });
    assert.equal(heard.code, 200);
    assert.equal(heard.value.text, '虚构部署语音');
  } finally {
    await p.close();
    assistant.registry.close();
    built.close();
    settings.close();
    store.close();
  }
});
