// 改全员共用的东西要先进超级管理员模式：账号管理、AI 设置（密钥和识别设置）、提示词、机器人凭据、助手工具启停。
// 从域名进来的超级管理员账号没进模式时被拦（403 super-mode），进了能改；别的账号说没权限；本机管理员不用进。虚构账号。
import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { AuthManager } from '../server/core/auth.js';
import { Store } from '../server/core/db.js';
import { count } from '../server/core/sql.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { assistantDeps } from './assistant-fixture.js';
import { AssistantManager } from '../server/assistant/manager.js';
import { promptModules } from '../shared/ai/index.js';
import { testProtector } from './fake-deepseek.js';
import { cookieOf, startProxied, testAdmin, userList } from './http-fixture.js';

const staff = { name: '虚构业务员', password: 'Fictional-staff-123' };
const assistantModule = promptModules.find((m) => m.id === 'assistant');
assert.ok(assistantModule, '提示词模块里有助手');
const assistantPrompts = assistantModule.apiPath.slice('/api'.length);

async function setup() {
  const clock = { now: Date.now() };
  const store = new Store(':memory:'),
    settings = new AiSettingsManager({ protector: testProtector }),
    built = assistantDeps(store, settings),
    assistant = new AssistantManager(built.deps);
  const p = await startProxied(
    store,
    { assistant, aiSettings: settings, promptModules: built.deps.prompts },
    { makeAuth: (deployment) => new AuthManager(':memory:', () => clock.now, { deployment, localAdministration: true }) },
  );
  const local = cookieOf(await p.call(p.localPort, '/auth/setup', { body: testAdmin }));
  const made = await p.call(p.localPort, '/auth/users', { cookie: local, body: { ...staff, level: 'staff' } });
  assert.equal(made.code, 201);
  const staffAccount = userList(made.value).find((u: { name: string }) => u.name === staff.name);
  assert.ok(staffAccount);
  const login = async (account: typeof staff) =>
    cookieOf(await p.call(p.proxyPort, '/auth/login', { headers: p.remote, body: account }));
  const admin = await login(testAdmin);
  /** 从域名进来的请求 */
  const remote = (path: string, cookie: string, body?: unknown, extra: Record<string, string> = {}) =>
    p.call(p.proxyPort, path, { headers: { ...p.remote, ...extra }, cookie, body });
  const aiToken = z.object({ csrfToken: z.string() }).parse((await remote('/ai/settings', admin)).value).csrfToken;
  return {
    p,
    clock,
    local,
    admin,
    login,
    remote,
    aiToken,
    enter: () => remote('/auth/super-admin/enter', admin, { password: testAdmin.password }),
    staffId: staffAccount.id,
    accounts: () => p.auth.listAccounts().length,
    async close() {
      await p.close();
      assistant.registry.close();
      built.close();
      settings.close();
      store.close();
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** 每个要进模式的写入：路径、请求体、额外请求头 */
const writes = (s: Setup): [string, unknown, Record<string, string>?][] => [
  ['/auth/users', { name: '虚构新号', password: 'Fictional-new-123', level: 'viewer' }],
  ['/auth/users/' + s.staffId + '/password', {}],
  ['/ai/settings/key/save', { apiKey: 'sk-fictional', expectedRevision: 0 }, { 'x-erp-ai-token': s.aiToken }],
  ['/ai/settings/preferences', { expectedRevision: 0, recognitionConcurrency: 2 }, { 'x-erp-ai-token': s.aiToken }],
  [assistantPrompts + '/save', {}, { 'x-erp-ai-token': s.p.auth.csrf }],
  ['/inbox/bots/wecom', { appId: 'fictional', enabled: false }],
  ['/assistant/tools/settings', { name: 'overview.get', enabled: false, expectedRevision: 0 }],
];

test('从域名进来的超级管理员没进模式：账号、AI 设置、提示词、机器人、工具启停的写入都回 403 super-mode', async () => {
  const s = await setup();
  try {
    for (const [path, body, extra] of writes(s)) {
      const r = await s.remote(path, s.admin, body, extra);
      assert.equal(r.code, 403, path);
      assert.equal(r.value.code, 'super-mode', path);
      assert.match(String(r.value.message), /要先在账号菜单的“系统维护”里验证密码，进入超级管理员模式/, path);
    }
    assert.equal(s.accounts(), 2, '账号一个没多');
  } finally {
    await s.close();
  }
});

test('从域名进来的超级管理员进了模式：同样这些写入都过了模式这一关', async () => {
  const s = await setup();
  try {
    assert.equal((await s.enter()).code, 200);
    for (const [path, body, extra] of writes(s)) {
      const r = await s.remote(path, s.admin, body, extra);
      assert.notEqual(r.value?.code, 'super-mode', path);
      assert.notEqual(r.code, 403, path);
    }
    assert.equal(s.accounts(), 3, '新号建好了');
  } finally {
    await s.close();
  }
});

test('没进模式管理账号被拦：同一个会话 5 分钟只记一笔“super-mode-denied”，进了模式的不记', async () => {
  const s = await setup();
  try {
    const denied = () => count(s.p.auth.db, "SELECT COUNT(*) FROM auth_events WHERE action='super-mode-denied'");
    const body = { name: '虚构新号', password: 'Fictional-new-123', level: 'viewer' };
    for (let i = 0; i < 3; i++) assert.equal((await s.remote('/auth/users', s.admin, body)).code, 403);
    assert.equal(denied(), 1);
    s.clock.now += 5 * 60_000;
    assert.equal((await s.remote('/auth/users', s.admin, body)).code, 403);
    assert.equal(denied(), 2, '过了 5 分钟再记');
    await s.enter();
    assert.equal((await s.remote('/auth/users', s.admin, body)).code, 201);
    assert.equal(denied(), 2);
  } finally {
    await s.close();
  }
});

test('“super-mode-denied”和别的登录记录一起清：超过 90 天的，有人登录时清掉', async () => {
  const s = await setup();
  try {
    const old = new Date(s.clock.now - 91 * 24 * 3600_000).toISOString();
    s.p.auth.db.prepare("INSERT INTO auth_events(at,actor_id,action) VALUES(?,NULL,'super-mode-denied')").run(old);
    await s.login(staff);
    assert.equal(count(s.p.auth.db, 'SELECT COUNT(*) FROM auth_events WHERE at=?', old), 0);
  } finally {
    await s.close();
  }
});

test('业务员账号改这些设置回 403 permission，不叫人去进模式', async () => {
  const s = await setup();
  try {
    const cookie = await s.login(staff);
    for (const path of ['/auth/users', '/ai/settings/preferences', '/assistant/tools/settings']) {
      const r = await s.remote(path, cookie, {}, { 'x-erp-ai-token': s.aiToken });
      assert.equal(r.code, 403, path);
      assert.equal(r.value.code, 'permission', path);
    }
  } finally {
    await s.close();
  }
});

test('设置页专用的读接口只给超级管理员账号：业务员、只读、财务账号读 AI 设置、提示词、插件与工具回 403 permission，助手的状态接口照常', async () => {
  const s = await setup();
  try {
    const others = [staff];
    for (const [name, level] of [['虚构只读', 'viewer'], ['虚构财务', 'finance']]) {
      const account = { name, password: 'Fictional-' + level + '-123' };
      assert.equal((await s.p.call(s.p.localPort, '/auth/users', { cookie: s.local, body: { ...account, level } })).code, 201);
      others.push(account);
    }
    const reads = ['/ai/settings', '/ai/prompt-modules', assistantPrompts, '/assistant/plugins'];
    for (const account of others) {
      const cookie = await s.login(account);
      for (const path of reads) {
        const r = await s.remote(path, cookie);
        assert.equal(r.code, 403, account.name + path);
        assert.equal(r.value.code, 'permission', account.name + path);
        assert.match(String(r.value.message), /要用超级管理员账号/, account.name + path);
      }
      // 助手、AI 导入、收件箱要知道的“AI 能不能用、用哪个模型”在这里，照常能读
      const state = await s.remote('/assistant', cookie);
      assert.equal(state.code, 200, account.name);
      assert.ok(state.value.ai, account.name);
    }
    for (const path of reads) assert.equal((await s.remote(path, s.admin)).code, 200, '没进模式的超级管理员能读 ' + path);
  } finally {
    await s.close();
  }
});

test('本机管理员不用进模式就能管理账号', async () => {
  const s = await setup();
  try {
    const r = await s.p.call(s.p.localPort, '/auth/users', {
      cookie: s.local,
      body: { name: '虚构本机建号', password: 'Fictional-new-123', level: 'viewer' },
    });
    assert.equal(r.code, 201);
  } finally {
    await s.close();
  }
});

test('没进模式时看账号列表、待处理申请、AI 设置、查余额照常', async () => {
  const s = await setup();
  try {
    for (const path of ['/auth/users', '/auth/requests', '/ai/settings'])
      assert.equal((await s.remote(path, s.admin)).code, 200, path);
    const balance = await s.remote('/ai/settings/balance', s.admin, {}, { 'x-erp-ai-token': s.aiToken });
    assert.notEqual(balance.code, 403);
  } finally {
    await s.close();
  }
});

test('超级管理员模式 15 分钟后失效，再改账号又被拦', async () => {
  const s = await setup();
  try {
    await s.enter();
    s.clock.now += 15 * 60_000 + 1;
    const r = await s.remote('/auth/users', s.admin, { name: '虚构过期', password: 'Fictional-new-123', level: 'viewer' });
    assert.equal(r.code, 403);
    assert.equal(r.value.code, 'super-mode');
  } finally {
    await s.close();
  }
});

test('助手改提示词：没进模式的超级管理员出不了确认卡片，也存不了', () => {
  const store = new Store(':memory:'),
    settings = new AiSettingsManager({ protector: testProtector }),
    built = assistantDeps(store, settings),
    assistant = new AssistantManager(built.deps);
  try {
    const admin = pageActor({ id: 'fictional-admin', name: '虚构管理员', role: 'super_admin' as const, permissions: [] });
    const superMode = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 'super-mode';
    // 两个入口都收 unknown：空对象原样传进去，没进模式就先被拦
    assert.throws(() => assistant.promptEdit.propose({}, admin), superMode);
    assert.throws(() => assistant.promptEdit.save({}, admin), superMode);
  } finally {
    assistant.registry.close();
    built.close();
    settings.close();
    store.close();
  }
});

test('工具管理页的“能不能改”跟着模式走', async () => {
  const s = await setup();
  try {
    assert.equal((await s.remote('/assistant/tools', s.admin)).value.canManage, false);
    await s.enter();
    assert.equal((await s.remote('/assistant/tools', s.admin)).value.canManage, true);
  } finally {
    await s.close();
  }
});
