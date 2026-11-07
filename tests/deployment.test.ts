import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/auth.js';
import { Store } from '../server/db.js';
import { readDeployment } from '../server/deployment.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { AssistantManager, assistantDefaultPreset } from '../server/assistant/manager.js';
import { setSpeechEngineForTests, speechModelInstalled } from '../server/speech/engine.js';

test('部署代理入口校验 Host、来源和访客地址，管理员能力和会话按入口及重启隔离', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'erp-deployment-test-'));
  const file = join(directory, 'users.sqlite');
  const store = new Store(':memory:');
  const settings = new AiSettingsManager();
  const prompts = new PromptPresetManager(':memory:', assistantDefaultPreset);
  const assistant = new AssistantManager(store, settings, prompts, { disableLocalFeatures: true });
  let handle: (req: IncomingMessage, res: ServerResponse) => void;
  const handler = (req: IncomingMessage, res: ServerResponse) => handle(req, res);
  const local = createServer(handler);
  const proxy = createServer(handler);
  const listen = async (server: typeof local) => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
  };
  const localPort = await listen(local),
    proxyPort = await listen(proxy);
  const host = 'erp.example.invalid';
  const deployment = readDeployment(
    {
      ERP_DEPLOYMENT: '1',
      ERP_ALLOWED_HOSTS: host,
      ERP_PROXY_PORT: String(proxyPort),
    },
    localPort,
  )!;
  let now = Date.now();
  let auth = new AuthManager(file, () => now, { deployment, localAdministration: true });
  const init = () => {
    handle = createApp(store, { auth, deployment, assistant });
  };
  init();
  const owner = { name: '虚构维护员', password: 'Fictional-owner-password' };
  async function call(
    port: number,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      cookie?: string;
      method?: string;
      raw?: Buffer;
    } = {},
  ) {
    const data = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
    return await new Promise<{ code: number; headers: IncomingMessage['headers']; value: any }>(
      (done, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api' + path,
            method: options.method ?? (data ? 'POST' : 'GET'),
            headers: {
              'content-type': 'application/json',
              'x-erp-auth-token': auth.csrf,
              ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
              ...(options.cookie ? { cookie: options.cookie } : {}),
              ...options.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              done({
                code: res.statusCode!,
                headers: res.headers,
                value: raw.startsWith('{') ? JSON.parse(raw) : raw,
              });
            });
          },
        );
        req.on('error', reject);
        req.end(data);
      },
    );
  }
  const remote = { host, origin: 'https://' + host, 'x-erp-client-ip': '192.0.2.8' };
  try {
    for (const headers of [
      { host },
      { ...remote, host: 'localhost' },
      { ...remote, host: 'other.example.invalid' },
      { ...remote, 'x-erp-client-ip': '192.0.2.8, 192.0.2.9' },
    ])
      assert.equal((await call(proxyPort, '/health', { headers })).code, 403);
    assert.equal((await call(localPort, '/health', { headers: remote })).code, 403);
    assert.equal(
      (await call(localPort, '/health', { headers: { 'x-forwarded-for': '127.0.0.1' } })).code,
      403,
    );
    assert.equal(
      (await call(proxyPort, '/auth/setup', { headers: remote, body: owner })).code,
      403,
    );
    // SSH 隧道把维护端口映射到别的本机端口：来源和 Host 一致才放行，来源对不上 Host 仍拒绝。
    const tunnel = 'http://127.0.0.1:13001';
    assert.equal(
      (await call(localPort, '/auth/setup', { headers: { origin: tunnel }, body: {} })).code,
      403,
    );
    assert.notEqual(
      (
        await call(localPort, '/auth/setup', {
          headers: { host: '127.0.0.1:13001', origin: tunnel },
          body: {},
        })
      ).code,
      403,
    );
    const localLogin = await call(localPort, '/auth/setup', { body: owner });
    assert.equal(localLogin.code, 200);
    assert.equal(localLogin.headers['strict-transport-security'], undefined);
    assert.doesNotMatch(localLogin.headers['set-cookie']![0], /; Secure/);
    const localCookie = localLogin.headers['set-cookie']![0].split(';')[0];
    assert.equal(
      (await call(localPort, '/auth/state', { cookie: localCookie })).value.actor
        .localAdministrator,
      true,
    );
    assert.equal(
      (
        await call(proxyPort, '/auth/login', {
          headers: { ...remote, origin: 'https://bad.invalid' },
          body: owner,
        })
      ).code,
      403,
    );
    for (let i = 0; i < 6; i++) {
      const response = await call(proxyPort, '/auth/login', {
        body: { ...owner, password: 'Fictional-wrong-password' },
        headers: { ...remote, 'x-forwarded-for': '198.51.100.' + i },
      });
      assert.equal(response.code, i < 5 ? 401 : 429);
    }
    // 同一公网 IP 下的其他账号不受影响：办公室共用出口时，一个人输错不能锁住全公司。
    assert.equal(
      (
        await call(proxyPort, '/auth/login', {
          body: { name: '虚构同事', password: 'Fictional-wrong-password' },
          headers: remote,
        })
      ).code,
      401,
    );
    remote['x-erp-client-ip'] = '192.0.2.9';
    const login = await call(proxyPort, '/auth/login', { headers: remote, body: owner });
    assert.equal(login.code, 200);
    assert.match(login.headers['set-cookie']![0], /; Secure/);
    assert.equal(login.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(login.headers['x-content-type-options'], 'nosniff');
    assert.ok(login.headers['x-frame-options']);
    const cookie = login.headers['set-cookie']![0].split(';')[0];
    const tokenHash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.ok(db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash=?').get(tokenHash));
      assert.deepEqual(
        db
          .prepare('PRAGMA table_info(auth_sessions)')
          .all()
          .map((r) => r.name),
        ['token_hash', 'user_id', 'expires'],
      );
    } finally {
      db.close();
    }
    const state = () => call(proxyPort, '/auth/state', { headers: remote, cookie });
    assert.equal((await state()).value.actor.superAdminMode, false);
    assert.equal(
      (
        await call(proxyPort, '/auth/super-admin/enter', {
          headers: remote,
          cookie,
          body: { password: owner.password },
        })
      ).value.actor.superAdminMode,
      true,
    );
    assert.equal(
      (
        await call(proxyPort, '/admin/permanent-deletions/preview', {
          headers: remote,
          cookie,
          body: {},
        })
      ).code,
      403,
    );
    const assistantState = (await call(proxyPort, '/assistant', { headers: remote, cookie })).value;
    assert.equal(assistantState.localFeaturesAvailable, false);
    assert.equal(
      assistantState.tools.find((tool: { name: string }) => tool.name === 'page.observe').usable,
      true,
    );
    assert.equal(
      assistantState.tools.find((tool: { name: string }) => tool.name === 'browser.capture').usable,
      false,
    );
    assert.throws(() => assistant.registry.assertAvailable('browser.act'), /部署模式已关闭/);
    assert.match(
      (await call(proxyPort, '/assistant/browser/connect', { headers: remote, cookie, body: {} }))
        .value.message,
      /部署模式已关闭/,
    );
    // 语音不跟服务器浏览器一起关：录音传到本服务器识别，模型在就能用。
    assert.equal(assistantState.speechAvailable, speechModelInstalled());
    setSpeechEngineForTests({ transcribe: () => '虚构语音内容' });
    try {
      assert.equal(
        (await call(proxyPort, '/assistant', { headers: remote, cookie })).value.speechAvailable,
        true,
      );
      const spoken = await call(proxyPort, '/assistant/transcribe', {
        headers: { ...remote, 'content-type': 'application/octet-stream' },
        cookie,
        raw: Buffer.alloc(16000 * 2),
      });
      assert.equal(spoken.code, 200);
      assert.equal(spoken.value.text, '虚构语音内容');
    } finally {
      setSpeechEngineForTests(null);
    }
    auth.close();
    auth = new AuthManager(file, () => now, { deployment, localAdministration: true });
    init();
    assert.equal((await state()).value.actor.name, owner.name);
    assert.equal((await state()).value.actor.superAdminMode, false);
    assert.equal(
      (await call(proxyPort, '/auth/logout', { headers: remote, cookie, body: {} })).code,
      200,
    );
    assert.equal((await state()).value.actor, null);
    const staffLogin = await call(proxyPort, '/auth/login', { headers: remote, body: owner });
    const staffCookie = staffLogin.headers['set-cookie']![0].split(';')[0];
    const account = await call(localPort, '/auth/users', {
      cookie: localCookie,
      body: { name: '虚构员工', password: 'Fictional-employee-password', level: 'staff' },
    });
    const employee = account.value.users.find((user: { name: string }) => user.name === '虚构员工');
    const staff = await call(proxyPort, '/auth/login', {
      headers: remote,
      body: { name: employee.name, password: 'Fictional-employee-password' },
    });
    const employeeCookie = staff.headers['set-cookie']![0].split(';')[0];
    for (const disabled of [true, false]) {
      assert.equal(
        (
          await call(localPort, '/auth/users/' + employee.id, {
            cookie: localCookie,
            body: { disabled },
            method: 'PUT',
          })
        ).code,
        200,
      );
      assert.equal(
        (await call(proxyPort, '/auth/state', { headers: remote, cookie: employeeCookie })).value
          .actor,
        null,
      );
    }
    const cli = new AuthManager(file);
    let temporary = '';
    try {
      temporary = cli.resetPassword(owner.name);
    } finally {
      cli.close();
    }
    assert.equal(
      (await call(proxyPort, '/auth/state', { headers: remote, cookie: staffCookie })).value.actor,
      null,
    );
    const updated = await call(proxyPort, '/auth/login', {
      headers: remote,
      body: { ...owner, password: temporary },
    });
    const updatedCookie = updated.headers['set-cookie']![0].split(';')[0];
    const otherDevice = await call(proxyPort, '/auth/login', {
      headers: remote,
      body: { ...owner, password: temporary },
    });
    const otherCookie = otherDevice.headers['set-cookie']![0].split(';')[0];
    assert.equal(
      (
        await call(proxyPort, '/auth/password', {
          headers: remote,
          cookie: updatedCookie,
          body: { current: temporary, password: 'Fictional-final-password' },
        })
      ).code,
      200,
    );
    // 改密后当前设备保持登录，其他设备立即失效，和页面提示一致。
    assert.equal(
      (await call(proxyPort, '/auth/state', { headers: remote, cookie: updatedCookie })).value.actor
        .name,
      owner.name,
    );
    assert.equal(
      (await call(proxyPort, '/auth/state', { headers: remote, cookie: otherCookie })).value.actor,
      null,
    );
    const current = await call(proxyPort, '/auth/login', {
      headers: remote,
      body: { ...owner, password: 'Fictional-final-password' },
    });
    const expiredCookie = current.headers['set-cookie']![0].split(';')[0];
    now += 9 * 3600_000;
    assert.equal(
      (await call(proxyPort, '/auth/state', { headers: remote, cookie: expiredCookie })).value
        .actor,
      null,
    );
    // 申请账号和忘记密码走公网入口，记录的是访客地址，不是代理地址。
    assert.equal(
      (
        await call(proxyPort, '/auth/apply', {
          headers: remote,
          body: { name: '虚构申请人', password: 'Fictional-applicant-1', note: '虚构仓库' },
        })
      ).code,
      202,
    );
    assert.equal(
      (await call(proxyPort, '/auth/forgot', { headers: remote, body: { name: '查无此人' } })).code,
      202,
    );
    const reviewer = await call(proxyPort, '/auth/login', {
      headers: remote,
      body: { ...owner, password: 'Fictional-final-password' },
    });
    const pending = await call(proxyPort, '/auth/requests', {
      headers: remote,
      cookie: reviewer.headers['set-cookie']![0].split(';')[0],
    });
    assert.deepEqual(
      pending.value.requests.map((r: any) => [r.name, r.client]),
      [['虚构申请人', remote['x-erp-client-ip']]],
    );
  } finally {
    await Promise.all(
      [local, proxy].map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
    auth.close();
    assistant.registry.close();
    settings.close();
    prompts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
