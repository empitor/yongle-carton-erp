// AI 设置（server/ai/settings-manager.ts）：一把加密保存的密钥、保存并测试、并发数、存储出错时不降级、HTTP 设置接口和账号权限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { defaultAiSettingsPath } from '../server/ai/credential-store.js';
import { defaultPromptSettingsPath } from '../server/ai/prompt-presets.js';
import { createApp } from '../server/app.js';
import { listen, startHttp } from './http-fixture.js';
import { Store } from '../server/core/db.js';
import { ImportManager } from '../server/import/manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { defaultPromptPreset } from '../server/import/default-prompts/sales-order.js';
import { fakeAiSettings, fakeDeepSeek, fakeKey, httpError } from './fake-deepseek.js';
import { settingsAt, storedSettings, withTempDir } from './ai-settings-fixture.js';

const newKey = 'sk-fictional-second-key-only';
/** 抛出的错带着这个类别、说明对得上 */
const failed = (code: string, message: RegExp) => (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === code && message.test(e.message);
/** 库里那一行的格式号 */
const storedFormat = z.looseObject({ format: z.number() });
/** 接口回答（只认用到的字段） */
const settingsAnswer = z.looseObject({
  hasKey: z.boolean(),
  revision: z.number(),
  check: z.looseObject({ state: z.string() }),
  balance: z.looseObject({ balances: z.array(z.looseObject({ total: z.string() })) }).optional(),
});
const balanceAnswer = z.looseObject({ available: z.boolean() });
const errorAnswer = z.looseObject({ code: z.string().optional(), message: z.string().optional() });
const requestList = z.looseObject({ requests: z.array(z.looseObject({ id: z.string(), name: z.string() })) });

test('只有一个加密保存的密钥：跨重启保留，状态和视图里都不出现密钥', () =>
  withTempDir('erp-ai-key-', (dir) => {
    const file = join(dir, 'settings.sqlite');
    let m = settingsAt(file);
    assert.deepEqual(m.status(), { ready: false, model: 'deepseek-flash', message: m.status().message });
    assert.match(m.status().message, /还没填写 DeepSeek 密钥/);
    assert.equal(m.view().check.state, 'missing');
    m.saveKey({ apiKey: fakeKey, expectedRevision: m.view().revision });
    assert.equal(m.view().hasKey, true);
    assert.equal(m.view().check.state, 'saved');
    m.close();
    m = settingsAt(file);
    assert.equal(m.status().ready, true);
    assert.equal(m.view().check.state, 'saved');
    assert.ok(!JSON.stringify(m.view()).includes(fakeKey));
    assert.ok(!JSON.stringify(m.status()).includes(fakeKey));
    const stored = String(storedSettings(file).document);
    assert.ok(!stored.includes(fakeKey), '库里只存加密后的密钥');
    assert.equal(storedFormat.parse(JSON.parse(stored)).format, 2);
    m.removeKey({ confirmed: true, expectedRevision: m.view().revision });
    assert.equal(m.status().ready, false);
    m.close();
  }));

test('保存并测试：查余额通过才保存；密钥不对、连不上都不保存，余额不足照样保存', async () => {
  const fake = fakeDeepSeek();
  const m = settingsAt(undefined, fake);
  try {
    // 密钥不对：假服务只认 fakeKey
    await assert.rejects(m.saveAndTestKey({ apiKey: newKey, expectedRevision: 0 }), failed('authentication', /密钥不对/));
    assert.equal(m.view().hasKey, false);
    // 连不上
    fake.next('/user/balance', () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    });
    await assert.rejects(m.saveAndTestKey({ apiKey: fakeKey, expectedRevision: 0 }), failed('network', /解析不了/));
    assert.equal(m.view().hasKey, false);
    // 余额不足：402 也保存，状态标余额不足
    fake.next('/user/balance', httpError(402).response());
    const low = await m.saveAndTestKey({ apiKey: fakeKey, expectedRevision: 0 });
    assert.equal(low.hasKey, true);
    assert.equal(low.check.state, 'low-balance');
    // 余额接口说不可用
    fake.next('/user/balance', new Response(JSON.stringify({ is_available: false, balance_infos: [] }), { status: 200 }));
    const tested = await m.testKey({ expectedRevision: m.view().revision });
    assert.equal(tested.check.state, 'low-balance');
    assert.equal(tested.balance.available, false);
    // 正常
    const ok = await m.testKey({ expectedRevision: m.view().revision });
    assert.equal(ok.check.state, 'ok');
    assert.deepEqual(ok.balance.balances, [{ currency: 'CNY', total: '100.00', granted: '0.00', toppedUp: '100.00' }]);
    assert.equal(m.status().ready, true);
    // 只查余额，不调对话
    assert.equal(fake.chatCalls().length, 0);
    assert.ok(fake.calls.every((c) => c.path === '/user/balance' && c.method === 'GET'));
    // 密钥里有空格、中文拒收
    assert.throws(() => m.saveKey({ apiKey: 'sk 中文', expectedRevision: m.view().revision }), /不能包含/);
  } finally {
    m.close();
  }
});

test('识别并发数默认 3，只收 1～6', () => {
  const { settings } = fakeAiSettings();
  try {
    assert.equal(settings.view().recognitionConcurrency, 3);
    assert.equal(settings.preferences({ expectedRevision: settings.view().revision, recognitionConcurrency: 1 }).recognitionConcurrency, 1);
    assert.throws(() => settings.preferences({ expectedRevision: settings.view().revision, recognitionConcurrency: 7 }));
  } finally {
    settings.close();
  }
});

test('解密失败：调用 AI 报要重新填写、不降级成明文，存新密钥被拒、库文件不动', () =>
  withTempDir('erp-ai-atomic-', async (dir) => {
    const file = join(dir, 'settings.sqlite');
    const saved = settingsAt(file);
    saved.saveKey({ apiKey: fakeKey, expectedRevision: 0 });
    saved.close();
    const broken = {
      protect() {
        throw new Error('unavailable');
      },
      unprotect() {
        throw new Error('unavailable');
      },
    };
    const m = new AiSettingsManager({ file, protector: broken, transport: fakeDeepSeek().transport });
    try {
      await assert.rejects(m.completeChatTools([{ role: 'user', content: 'x' }], []), failed('storage', /重新填写/));
      assert.equal(m.credentialWarning(), '当前服务账号或平台无法解密已保存的 AI 密钥，请在此账号下重新填写。');
      const before = readFileSync(file);
      assert.throws(() => m.saveKey({ apiKey: newKey, expectedRevision: m.view().revision }));
      assert.deepEqual(readFileSync(file), before);
    } finally {
      m.close();
    }
  }));

test('设置库和提示词库的默认位置不随工作目录变', () => {
  const original = process.cwd(),
    home = defaultAiSettingsPath(),
    prompts = defaultPromptSettingsPath();
  try {
    process.chdir(tmpdir());
    assert.equal(defaultAiSettingsPath(), home);
    assert.equal(defaultPromptSettingsPath(), prompts, '提示词库的默认位置也不随工作目录变');
  } finally {
    process.chdir(original);
  }
});

test('HTTP 设置接口：要 CSRF、密钥不回显、删除要确认；业务表不受影响', async () => {
  const fake = fakeDeepSeek(),
    m = settingsAt(undefined, fake),
    store = new Store(':memory:'),
    server = await listen(createApp(store, { aiSettings: m }));
  const base = server.origin + '/api/ai/settings';
  const post = (path: string, body: unknown, token = m.csrfToken) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': token },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/key', { apiKey: fakeKey, expectedRevision: 0 }, '')).status, 403);
    assert.equal((await fetch(base, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const initial = await fetch(base);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    const wrong = await post('/key', { apiKey: newKey, expectedRevision: 0 });
    assert.equal(wrong.status, 422);
    assert.equal(errorAnswer.parse(await wrong.json()).code, 'authentication');
    const saved = settingsAnswer.parse(await (await post('/key', { apiKey: fakeKey, expectedRevision: 0 })).json());
    assert.ok(!JSON.stringify(saved).includes(fakeKey));
    assert.equal(saved.hasKey, true);
    assert.equal(saved.check.state, 'ok');
    assert.equal(saved.balance?.balances[0].total, '100.00');
    const balance = balanceAnswer.parse(await (await post('/balance', {})).json());
    assert.equal(balance.available, true);
    assert.equal((await post('/preferences', { recognitionConcurrency: 2, expectedRevision: saved.revision })).status, 200);
    assert.equal((await post('/key/delete', { expectedRevision: saved.revision + 1 })).status, 400);
    const removed = await post('/key/delete', { confirmed: true, expectedRevision: saved.revision + 1 });
    assert.equal(removed.status, 200);
    assert.equal(settingsAnswer.parse(await removed.json()).hasKey, false);
    const later = settingsAnswer.parse(await (await post('/key/save', { apiKey: fakeKey, expectedRevision: saved.revision + 2 })).json());
    assert.equal(later.check.state, 'saved');
    assert.deepEqual([store.customers().length, store.products().length, store.orders().length], [0, 0, 0]);
  } finally {
    await server.close();
    m.close();
    store.close();
  }
});

test('只读和业务账号不能改 AI 设置；只读账号不能动导入工作区和提示词', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-review-'));
  const store = new Store(':memory:'),
    { settings } = fakeAiSettings(),
    prompts = new PromptPresetManager(':memory:', defaultPromptPreset),
    imports = new ImportManager({
      directory: join(dir, 'imports'),
      settings,
      promptPresets: prompts,
    }),
    h = await startHttp(store, { aiSettings: settings, imports }),
    base = h.api,
    auth = h.auth;
  const send = (path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}) =>
    h.send(path, body, cookie, { headers: extra });
  try {
    const admin = h.cookie;
    // 批准申请、删密钥、改提示词都要先进超级管理员模式
    await h.enterSuperMode();
    const account = async (name: string, level: string) => {
      const password = 'Fictional-account-1';
      await send('/auth/apply', { name, password, note: '虚构' });
      const { requests } = requestList.parse(await (await send('/auth/requests', undefined, admin)).json());
      const request = requests.find((r) => r.name === name);
      if (!request) throw new Error('没有找到申请：' + name);
      assert.equal((await send('/auth/requests/' + request.id + '/approve', { level }, admin)).status, 200);
      return h.login(name, password);
    };
    const viewer = await account('虚构只读', 'viewer'),
      staff = await account('虚构业务', 'staff');
    const settingsToken = { 'X-ERP-AI-Token': settings.csrfToken },
      importToken = { 'X-ERP-AI-Token': imports.csrfToken };
    for (const cookie of [viewer, staff])
      assert.equal(
        (await send('/ai/settings/key/delete', { confirmed: true }, cookie, settingsToken)).status,
        403,
        'AI 设置只有管理员能改',
      );
    assert.notEqual((await send('/ai/settings/key/delete', { confirmed: true }, admin, settingsToken)).status, 403);
    // 能读当前配置，聊天要用
    assert.equal((await send('/ai/settings', undefined, viewer)).status, 200);
    const upload = await fetch(base + '/ai/imports/upload', {
      method: 'POST',
      headers: {
        Cookie: viewer,
        'Content-Type': 'application/octet-stream',
        'X-ERP-Auth-Token': 'x',
        'X-File-Name': encodeURIComponent('虚构.png'),
        'X-Upload-Id': randomUUID(),
        ...importToken,
      },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(upload.status, 403, '只读账号不能上传');
    assert.equal(
      (await send('/ai/imports/batch', { action: 'archive', items: [{ id: randomUUID(), version: 0 }] }, viewer, importToken)).status,
      403,
      '只读账号不能归档工作区',
    );
    assert.equal((await send('/ai/prompt-modules/sales-order/activate', {}, viewer, importToken)).status, 403);
    // 提示词全员共用：业务人员也不能改，和 AI 设置一样要超级管理员账号（读照旧）
    const promptToken = { 'X-ERP-AI-Token': auth.csrf };
    const staffChange = await send('/ai/prompt-modules/sales-order/activate', {}, staff, promptToken);
    assert.equal(staffChange.status, 403, '业务人员不能改提示词');
    assert.match(errorAnswer.parse(await staffChange.json()).message ?? '', /超级管理员/);
    assert.equal((await send('/ai/prompt-modules/sales-order', undefined, staff)).status, 200, '业务人员能读提示词');
    assert.notEqual((await send('/ai/prompt-modules/sales-order/activate', {}, admin, promptToken)).status, 403, '超级管理员照常');
    assert.equal((await send('/ai/imports', undefined, viewer)).status, 200, '可以看');
  } finally {
    await h.close();
    imports.close();
    prompts.close();
    settings.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
