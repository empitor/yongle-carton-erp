// 机器人设置库（server/inbox/bots/settings.ts）、总管的视图和来源列表、设置接口 /api/inbox/bots
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '../server/core/index.js';
import { AuthManager } from '../server/accounts/index.js';
import { startHttp } from './http-fixture.js';
import { BotSettings } from '../server/inbox/bots/settings.js';
import { BotManager, inboxChannelList } from '../server/inbox/bots/manager.js';
import { botChannels } from '../shared/import/inbox.js';

const SECRET = 'fictional-bot-secret-value';
const protector = {
  protect: (s: string) => 'enc:' + Buffer.from(s).toString('base64'),
  unprotect: (s: string) => Buffer.from(s.slice(4), 'base64').toString(),
};
/** 不会真的打开的套接字：设置接口的用例不需要连上。 */
class IdleSocket {
  readyState = 0;
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {
    // 不会真的打开，也就没有事件要发
  }
}
const idleManager = (settings: BotSettings) =>
  new BotManager(settings, {
    ingest: () => {},
    exists: () => false,
    WebSocketImpl: IdleSocket,
  });

test('凭据：每家一行，Secret 只存密文，留空沿用，停用不返回；视图没有 Secret；缺项按后台原名提示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-bots-'));
  const file = join(dir, 'bots.sqlite');
  const settings = new BotSettings(file, protector);
  try {
    assert.equal(settings.credentials('wecom_bot'), null);
    assert.throws(() => settings.save('wecom_bot', { appId: ' ', secret: SECRET, enabled: true }), /请填写 Bot ID/);
    assert.throws(() => settings.save('wecom_bot', { appId: 'b', enabled: true }), /请填写 Secret/);
    settings.save('wecom_bot', { appId: ' b ', secret: ` ${SECRET} `, enabled: true });
    assert.deepEqual(settings.view('wecom_bot'), { appId: 'b', hasSecret: true, enabled: true });
    assert.deepEqual(settings.credentials('wecom_bot'), { appId: 'b', secret: SECRET });
    assert.equal(settings.save('wecom_bot', { appId: 'c', enabled: true }).secretChanged, false);
    assert.deepEqual(settings.credentials('wecom_bot'), { appId: 'c', secret: SECRET });
    settings.save('wecom_bot', { appId: 'c', enabled: false });
    assert.equal(settings.credentials('wecom_bot'), null);
    assert.ok(!readFileSync(file).includes(SECRET));
    assert.throws(() => settings.save('wecom_bot', { appId: 'c', enabled: true, extra: 1 }));
    assert.equal(settings.credentialWarning(), undefined);
  } finally {
    settings.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('解不开的 Secret 启动时提示是哪家；比程序新的设置库拒绝打开、文件不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-bots-version-'));
  const file = join(dir, 'bots.sqlite');
  try {
    const settings = new BotSettings(file, protector);
    settings.save('wecom_bot', { appId: 'fictional-bot', secret: SECRET, enabled: true });
    settings.close();
    const broken = new BotSettings(file, { ...protector, unprotect: () => assert.fail('解不开') });
    assert.match(broken.credentialWarning() ?? '', /无法解密已保存的企业微信机器人 Secret/);
    broken.close();
    const newer = new DatabaseSync(file);
    newer.exec('PRAGMA user_version=2');
    newer.close();
    const bytes = readFileSync(file);
    assert.throws(() => new BotSettings(file, protector), /机器人设置库比当前程序新，不能打开：它是第 2 版/);
    assert.deepEqual(readFileSync(file), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('来源列表：手动添加和各家机器人；填好并启用才算配好，没接上总管时都算没配', () => {
  assert.deepEqual(
    inboxChannelList().map((c) => [c.id, c.configured]),
    [['manual', true], ...botChannels.map((c) => [c, false])],
  );
  const settings = new BotSettings(':memory:', protector);
  try {
    const manager = idleManager(settings);
    settings.save('wecom_bot', { appId: 'fictional-bot', secret: SECRET, enabled: true });
    const wecom = inboxChannelList(manager).find((c) => c.id === 'wecom_bot');
    assert.deepEqual(wecom, { id: 'wecom_bot', label: '企业微信机器人', configured: true, state: 'off' });
    assert.ok(!JSON.stringify(manager.views()).includes(SECRET));
  } finally {
    settings.close();
  }
});

/** 账号库里直接加一个账号（虚构的名字和密码） */
function addUser(authPath: string, name: string, password: string, role: string) {
  const salt = 'fictional-salt-' + name;
  const db = new DatabaseSync(authPath);
  db.prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)').run(
    randomUUID(),
    name,
    salt,
    scryptSync(password, salt, 64).toString('hex'),
    JSON.stringify(['business:edit', 'import:execute']),
    role,
  );
  db.close();
}

/** 设置接口那条用的整套服务：一个超级管理员、一个普通管理员，记下哪几家被重连 */
async function botsHttp() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-bots-http-'));
  const authPath = join(dir, 'users.sqlite');
  const auth = new AuthManager(authPath);
  addUser(authPath, '虚构管理员', 'Fictional-Admin-2026', 'super_admin');
  addUser(authPath, '虚构业务员', 'Fictional-Staff-2026', 'admin');
  const store = new Store(':memory:');
  const settings = new BotSettings(':memory:', protector);
  const bots = idleManager(settings);
  const restarted: string[] = [];
  const realRestart = bots.restart.bind(bots);
  bots.restart = (channel) => {
    restarted.push(channel);
    realRestart(channel);
  };
  const h = await startHttp(store, { auth, bots, admin: false });
  const auditDocument = z.object({ document: z.string() });
  return {
    h,
    auth,
    restarted,
    post: (headers: Record<string, string>, channel: string, body: unknown) =>
      fetch(h.api + '/inbox/bots/' + channel, { method: 'POST', headers, body: JSON.stringify(body) }),
    audits: () =>
      store.db
        .prepare("SELECT document FROM business_audit WHERE action='bot-settings' ORDER BY id")
        .all()
        .map((r) => auditDocument.parse(r).document),
    close: async () => {
      bots.stop();
      await h.close();
      settings.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
/** 来源列表、设置视图的一行（接口回答，只认用到的字段，别的原样留着比对） */
const channelRows = z.array(z.looseObject({ id: z.string() }));
const viewRows = z.array(z.looseObject({ channel: z.string(), hasSecret: z.boolean().optional(), label: z.string().optional() }));
const auditFields = z.looseObject({ appIdChanged: z.boolean(), secretChanged: z.boolean() });

test('接口：只有管理员能看和改，要 CSRF，不回显 Secret，审计不含应用编号和 Secret，保存后只重连那一家', async () => {
  const { h, auth, restarted, post, audits, close } = await botsHttp(),
    base = h.api,
    login = h.login;
  try {
    assert.equal((await fetch(base + '/inbox/bots')).status, 401);
    const staffHeaders = {
      Cookie: await login('虚构业务员', 'Fictional-Staff-2026'),
      'X-ERP-Auth-Token': auth.csrf,
      'Content-Type': 'application/json',
    };
    const staffRead = await fetch(base + '/inbox/bots', { headers: staffHeaders });
    assert.equal(staffRead.status, 403);
    // 拒绝的说法和类别跟全站一致（server/core/http/permissions.ts 的 superModeDenied）
    assert.deepEqual(await staffRead.json(), { message: '设置机器人要用超级管理员账号，当前账号没有这个权限。', code: 'permission' });
    const fields = { appId: 'fictional-bot', secret: SECRET, enabled: true };
    assert.equal((await post(staffHeaders, 'wecom_bot', fields)).status, 403);
    const channels = channelRows.parse(await (await fetch(base + '/inbox/channels', { headers: staffHeaders })).json());
    assert.deepEqual(channels.find((c) => c.id === 'wecom_bot'), {
      id: 'wecom_bot',
      label: '企业微信机器人',
      configured: false,
      state: 'off',
    });

    const adminHeaders = { ...staffHeaders, Cookie: await login('虚构管理员', 'Fictional-Admin-2026') };
    await h.enterSuperMode(adminHeaders.Cookie, 'Fictional-Admin-2026');
    assert.equal((await post({ ...adminHeaders, 'X-ERP-Auth-Token': 'wrong' }, 'wecom_bot', fields)).status, 403);
    assert.equal((await post(adminHeaders, 'sms_bot', fields)).status, 400);
    assert.deepEqual(restarted, []);
    const saved = await post(adminHeaders, 'wecom_bot', fields);
    assert.equal(saved.status, 200);
    const text = await saved.text();
    assert.ok(!text.includes(SECRET));
    const wecom = viewRows.parse(JSON.parse(text)).find((v) => v.channel === 'wecom_bot');
    assert.equal(wecom?.hasSecret, true);
    assert.equal(wecom?.label, '企业微信机器人');
    assert.deepEqual(restarted, ['wecom_bot']);
    await post(adminHeaders, 'wecom_bot', { appId: 'fictional-bot', enabled: true });
    const [first, second] = audits();
    for (const doc of [first, second]) {
      assert.ok(!doc.includes(SECRET));
      assert.ok(!doc.includes('fictional-bot'), '应用编号也不进审计，只记改没改');
    }
    assert.deepEqual(JSON.parse(first), {
      channel: 'wecom_bot',
      enabled: true,
      enabledChanged: true,
      appIdChanged: true,
      secretChanged: true,
    });
    assert.equal(auditFields.parse(JSON.parse(second)).appIdChanged, false);
    assert.equal(auditFields.parse(JSON.parse(second)).secretChanged, false);
    const read = await fetch(base + '/inbox/bots', { headers: adminHeaders });
    assert.equal(read.headers.get('cache-control'), 'no-store', '有应用编号，不让浏览器和代理缓存');
    const views = viewRows.parse(await read.json());
    assert.deepEqual(views.map((v) => v.channel), [...botChannels]);
    assert.ok(!JSON.stringify(views).includes(SECRET));
  } finally {
    await close();
  }
});

test('已存的 Secret 在这台机器上解不开：记成连接被拒并显示原因，要重填才再连，不显示“未启用”', (t) => {
  t.mock.method(console, 'error', () => {});
  // 存的时候能加密，读的时候解不开：模拟换了服务器、平台或服务账号
  const broken = new BotSettings(':memory:', { ...protector, unprotect: () => { throw new Error('fictional decrypt failure'); } });
  const manager = idleManager(broken);
  try {
    broken.save('wecom_bot', { appId: 'fictional-bot', secret: SECRET, enabled: true });
    manager.restart('wecom_bot');
    const wecom = manager.views().find((v) => v.channel === 'wecom_bot');
    assert.equal(wecom?.status.state, 'auth_failed');
    assert.equal(wecom?.status.lastError, '已保存的 Secret 在这台机器上解不开（换了服务器、平台或服务账号），请重新填写 Secret。');
    assert.equal(wecom?.enabled, true);
  } finally {
    manager.stop();
    broken.close();
  }
});
