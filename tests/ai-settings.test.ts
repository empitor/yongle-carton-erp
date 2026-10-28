import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { defaultAiSettingsPath, type SecretProtector } from '../server/ai/credential-store.js';
import { normalizeProfile, isPublicIPv4, resolvePublicAddress } from '../server/ai/endpoint.js';
import {
  probeModel,
  safeConnectionError,
  readModelIds,
  connectCompatible,
} from '../server/ai/adapters.js';
import { aiProviders, type AiProfile } from '../shared/ai-settings.js';
import type { AiTransport, WireRequest, WireResponse } from '../server/ai/transport.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { parsePublicDns } from '../server/ai/public-dns.js';

const key = 'sk-unit-test-placeholder-not-a-real-key';
const profile: AiProfile = {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
};
const input = {
  name: '日常模型（测试）',
  endpoint: 'https://api.example.com/v1',
  model: 'unit-model',
};
function fakeReply(request: WireRequest): WireResponse {
  const marker = JSON.stringify(request.body).match(/ERP_OK_[a-f0-9]{12}/)?.[0];
  assert.ok(marker);
  const path = request.url.pathname;
  if (path.endsWith('/responses'))
    return {
      status: 200,
      body: {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: marker }],
          },
        ],
      },
    };
  if (path.endsWith('/chat/completions'))
    return {
      status: 200,
      body: { choices: [{ finish_reason: 'stop', message: { content: marker } }] },
    };
  if (path.endsWith(':generateContent'))
    return {
      status: 200,
      body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: marker }] } }] },
    };
  if (path.endsWith('/messages'))
    return {
      status: 200,
      body: { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: marker }] },
    };
  return { status: 200, body: { done: true, done_reason: 'stop', message: { content: marker } } };
}
const transport: AiTransport = async (r) =>
  r.method === 'GET'
    ? r.headers.Authorization
      ? { status: 200, body: { data: [{ id: 'unit-model' }, { id: 'other-model' }] } }
      : { status: 401, body: {} }
    : fakeReply(r);
// 非 Windows CI 的测试替身使用真实 AES-GCM，生产代码始终用 DPAPI。
const aesKey = randomBytes(32);
const protector: SecretProtector = {
  protect(s) {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', aesKey, iv);
    const data = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  },
  unprotect(s) {
    const b = Buffer.from(s, 'base64'),
      c = createDecipheriv('aes-256-gcm', aesKey, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString('utf8');
  },
};
const managerFor = (extra: ConstructorParameters<typeof AiSettingsManager>[0] = {}) =>
  new AiSettingsManager({ transport, protector, ...extra });
async function enable(m: AiSettingsManager, fields = input, apiKey: string | undefined = key) {
  const result = await m.test({
    ...fields,
    ...(apiKey ? { apiKey } : {}),
    expectedRevision: m.view().revision,
  });
  return m.save({ testToken: result.testToken, expectedRevision: m.view().revision });
}

test('预设与加密密钥跨管理器重启持久恢复，默认不伪报连接成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-presets-')),
    file = join(dir, 'settings.sqlite');
  let m = managerFor({ file });
  try {
    const saved = await enable(m);
    assert.equal(saved.active?.name, input.name);
    assert.equal(saved.presets[0].hasApiKey, true);
    assert.ok(!JSON.stringify(saved).includes(key));
    m.close();
    assert.ok(!readFileSync(file).includes(Buffer.from(key)));
    m = managerFor({ file });
    await m.startup();
    assert.equal(m.view().active?.model, input.model);
    assert.equal(m.view().presets[0].hasApiKey, true);
    assert.equal(m.view().connection.status, 'unverified');
    assert.equal(m.view().autoConnect, false);
    const p = m.view().presets[0];
    await m.connect({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      model: p.model,
      expectedRevision: m.view().revision,
    });
    assert.equal(m.view().connection.status, 'verified');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'Windows DPAPI 在独立 Node 进程中解密；密钥不在数据库和公共视图中',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erp-dpapi-')),
      file = join(dir, 'settings.sqlite');
    const m = new AiSettingsManager({ file, transport });
    try {
      await enable(m);
      m.close();
      const script = `import {AiSettingsManager} from './server/ai/settings-manager.ts'; const m=new AiSettingsManager({file:process.argv[1],transport:async r=>({status:r.headers.Authorization==='Bearer sk-unit-test-placeholder-not-a-real-key'?200:401,body:r.headers.Authorization?{data:[]}:null})}); const p=m.view().presets[0]; await m.connect({id:p.id,name:p.name,endpoint:p.endpoint,model:p.model,expectedRevision:m.view().revision}); if(m.view().connection.status!=='verified')process.exitCode=1; m.close();`;
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, file],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      );
      assert.equal(child.status, 0, '独立进程未能恢复 DPAPI 凭据');
      assert.ok(!child.stdout.includes(key));
      assert.ok(!readFileSync(file).includes(Buffer.from(key)));
    } finally {
      try {
        m.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('新增第二预设、编辑、切换、删除确认与重启保留，地址变化不会串用密钥', async () => {
  const m = managerFor();
  try {
    const a = (await enable(m)).active!;
    const b = (
      await enable(
        m,
        { ...input, name: '备用', endpoint: 'https://backup.example.com/v1', model: 'other-model' },
        'second-test-key',
      )
    ).active!;
    assert.equal(m.view().presets.length, 2);
    m.activate({ id: a.id, expectedRevision: m.view().revision });
    await m.test({ id: a.id, ...input, expectedRevision: m.view().revision });
    await assert.rejects(
      m.test({ id: a.id, ...input, endpoint: b.endpoint, expectedRevision: m.view().revision }),
      (e: any) => e.code === 'key_required',
    );
    assert.throws(() => m.remove({ id: b.id, expectedRevision: m.view().revision }));
    const edited = m.saveDraft({
      id: a.id,
      ...input,
      name: '日常已改名',
      expectedRevision: m.view().revision,
    });
    assert.equal(edited.active?.name, '日常已改名');
    m.remove({ id: b.id, confirmed: true, expectedRevision: m.view().revision });
    assert.equal(m.view().presets.length, 1);
    assert.throws(() => m.activate({ id: b.id, expectedRevision: m.view().revision }));
  } finally {
    m.close();
  }
});

test('自动连接开关、最后启用预设跨重启保留，只发 GET；失败保留密钥及配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-auto-')),
    file = join(dir, 'settings.sqlite');
  let m = managerFor({ file });
  try {
    await enable(m);
    m.preferences({ autoConnect: true, expectedRevision: m.view().revision });
    m.close();
    const calls: WireRequest[] = [];
    m = managerFor({
      file,
      transport: async (r) => {
        calls.push(r);
        return transport(r);
      },
    });
    await m.startup();
    assert.equal(m.view().autoConnect, true);
    assert.equal(m.view().connection.status, 'verified');
    assert.ok(calls.length > 0 && calls.every((r) => r.method === 'GET' && r.body === undefined));
    m.close();
    m = managerFor({
      file,
      transport: async () => ({ status: 401, body: { error: { message: key } } }),
    });
    await m.startup();
    assert.equal(m.view().connection.code, 'authentication');
    assert.equal(m.view().presets[0].hasApiKey, true);
    assert.equal(m.view().active?.model, input.model);
    assert.ok(!JSON.stringify(m.view()).includes(key));
    m.preferences({ autoConnect: false, expectedRevision: m.view().revision });
    m.close();
    m = managerFor({
      file,
      transport: async () => {
        throw new Error('不应发请求');
      },
    });
    await m.startup();
    assert.equal(m.view().connection.status, 'unverified');
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('连接 API、模型目录和推理分离；公开目录及不支持模型目录不虚报认证成功', async () => {
  const p: AiProfile = { provider: 'compatible', endpoint: input.endpoint, model: input.model };
  assert.equal((await connectCompatible(p, key, transport)).status, 'verified');
  assert.equal(
    (await connectCompatible(p, key, async () => ({ status: 200, body: { data: [] } }))).status,
    'unverified',
  );
  for (const body of [null, {}, '<html>'])
    assert.equal(
      (await connectCompatible(p, key, async () => ({ status: 200, body }))).status,
      'unverified',
    );
  for (const status of [404, 405, 501]) {
    const m = managerFor({
      transport: async (r) => (r.method === 'GET' ? { status, body: {} } : fakeReply(r)),
    });
    try {
      assert.equal(
        (await m.connect({ ...input, model: '', apiKey: key, expectedRevision: 0 })).status,
        'unverified',
      );
      await assert.rejects(m.models({ ...input, apiKey: key, expectedRevision: 0 }));
      await enable(m);
      assert.ok(m.view().active);
    } finally {
      m.close();
    }
  }
  await assert.rejects(
    connectCompatible(p, key, async () => ({ status: 401, body: {} })),
    (e: any) => e.code === 'authentication',
  );
});

test('过期、伪造及旧修订凭证不可保存；并发请求防重；HTTP200空结果不产生凭证', async () => {
  const m = managerFor({ receiptTtlMs: 5 });
  try {
    const tested = await m.test({ ...input, apiKey: key, expectedRevision: 0 });
    assert.equal(m.view().active, null);
    assert.throws(() => m.save({ testToken: 'a'.repeat(64), expectedRevision: 0 }));
    await delay(15);
    assert.throws(() => m.save({ testToken: tested.testToken, expectedRevision: 0 }));
    const second = await m.test({ ...input, apiKey: key, expectedRevision: 0 });
    m.preferences({ autoConnect: true, expectedRevision: 0 });
    assert.throws(() => m.save({ testToken: second.testToken, expectedRevision: 1 }));
  } finally {
    m.close();
  }
  const failure = managerFor({ transport: async () => ({ status: 200, body: {} }) });
  try {
    await assert.rejects(failure.test({ ...input, apiKey: key, expectedRevision: 0 }));
    assert.equal(failure.view().presets.length, 0);
  } finally {
    failure.close();
  }
  const slow = managerFor({
    transport: async (r) => {
      await delay(20);
      return transport(r);
    },
  });
  try {
    const pending = slow.connect({ ...input, apiKey: key, expectedRevision: 0 });
    await assert.rejects(
      slow.connect({ ...input, apiKey: key, expectedRevision: 0 }),
      (e: any) => e.code === 'busy',
    );
    await pending;
  } finally {
    slow.close();
  }
});

test('存储或解密失败不清空密钥、无明文降级；旧配置只迁移一次并保留原文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-migrate-')),
    file = join(dir, 'settings.sqlite'),
    legacyFile = join(dir, 'old.json');
  writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      profiles: [{ provider: 'compatible', endpoint: input.endpoint, model: input.model }],
    }),
  );
  let m = managerFor({ file, legacyFile });
  try {
    assert.equal(m.view().presets.length, 1);
    assert.equal(m.view().presets[0].hasApiKey, false);
    const p = m.view().presets[0];
    await enable(m, { ...input, id: p.id } as any);
    m.close();
    m = managerFor({
      file,
      protector: {
        protect() {
          throw new Error('DPAPI unavailable');
        },
        unprotect() {
          throw new Error('DPAPI unavailable');
        },
      },
    });
    await assert.rejects(m.test({ ...input, id: p.id, expectedRevision: m.view().revision }));
    assert.equal(m.view().presets[0].hasApiKey, true);
    m.close();
    m = managerFor({ file, legacyFile });
    assert.equal(m.view().presets.length, 1);
    assert.ok(readFileSync(legacyFile, 'utf8').includes(input.model));
    const before = defaultAiSettingsPath();
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      assert.equal(defaultAiSettingsPath(), before);
    } finally {
      process.chdir(original);
    }
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP配置接口要求CSRF，密钥不回显，用户确认删除；业务表不受影响', async () => {
  const m = managerFor(),
    store = new Store(':memory:'),
    server = createApp(store, { aiSettings: m }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/ai/settings`;
  const post = (path: string, body: unknown, token = m.csrfToken) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': token },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post('/connect', { ...input, apiKey: key, expectedRevision: 0 }, '')).status,
      403,
    );
    assert.equal((await fetch(base, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const initial = await fetch(base);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.equal(
      (await post('/connect', { ...input, model: '', apiKey: key, expectedRevision: 0 })).status,
      200,
    );
    assert.equal(
      (await post('/models', { ...input, model: '', apiKey: key, expectedRevision: 0 })).status,
      200,
    );
    const tested = await (
      await post('/test', { ...input, apiKey: key, expectedRevision: 0 })
    ).json();
    const saved = await (
      await post('/save', { testToken: tested.testToken, expectedRevision: 0 })
    ).json();
    assert.ok(!JSON.stringify(saved).includes(key));
    assert.ok(saved.active.hasApiKey);
    const id = saved.active.id;
    assert.equal((await post('/delete', { id, expectedRevision: 1 })).status, 400);
    assert.equal((await post('/delete', { id, confirmed: true, expectedRevision: 1 })).status, 200);
    assert.deepEqual(
      [store.customers().length, store.products().length, store.orders().length],
      [0, 0, 0],
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    m.close();
    store.close();
  }
});
test('五种供应商探针使用各自协议；只发固定短文本，不发业务元数据或记录（传输桩）', async () => {
  const requests: WireRequest[] = [];
  for (const p of aiProviders) {
    const config: AiProfile = {
      provider: p.id,
      endpoint: p.endpoint || 'https://api.example.com/v1',
      model: p.model || 'unit-model',
    };
    await probeModel(normalizeProfile(config), p.requiresKey ? key : null, async (req) => {
      requests.push(req);
      return fakeReply(req);
    });
  }
  assert.equal(requests[0].url.pathname, '/v1/responses');
  assert.equal((requests[0].body as any).store, false);
  assert.equal(requests[1].url.pathname, '/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(requests[1].headers['x-goog-api-key'], key);
  assert.ok((requests[1].body as any).contents);
  assert.equal(requests[2].url.pathname, '/v1/messages');
  assert.equal(requests[2].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[2].headers['x-api-key'], key);
  assert.equal(requests[3].url.pathname, '/v1/chat/completions');
  assert.ok((requests[3].body as any).messages);
  assert.equal(requests[4].url.pathname, '/api/chat');
  assert.deepEqual(requests[4].headers, {});
  assert.equal(requests[4].local, true);
  for (const req of requests) {
    assert.ok(!req.url.href.includes(key));
    assert.ok(!JSON.stringify(req.body).includes(key));
    assert.ok(!('tools' in (req.body as any)));
    assert.ok(!('catalog' in (req.body as any)));
  }
});
test('真实 HTTP 失败码分类并屏蔽供应商回显的密钥（传输桩）', async () => {
  const cases: [number, unknown, string][] = [
    [401, { error: { message: key } }, 'authentication'],
    [403, { error: { message: key } }, 'permission'],
    [404, {}, 'model'],
    [429, { error: { code: 'insufficient_quota', message: key } }, 'quota'],
    [429, {}, 'rate_limit'],
    [503, {}, 'upstream'],
    [302, {}, 'endpoint'],
    [400, {}, 'model'],
    [
      400,
      {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }],
          message: key,
        },
      },
      'authentication',
    ],
  ];
  for (const [status, body, code] of cases)
    await assert.rejects(
      probeModel(profile, key, async () => ({ status, body })),
      (e: any) => e.code === code && !e.message.includes(key),
    );
  assert.equal(safeConnectionError({ code: 'ENOTFOUND' }).code, 'dns');
  assert.equal(safeConnectionError({ name: 'AbortError' }).code, 'timeout');
  assert.equal(safeConnectionError({ code: 'CERT_HAS_EXPIRED' }).code, 'tls');
  assert.equal(safeConnectionError({ code: 'ECONNREFUSED', message: key }).code, 'network');
});
test('200 空结果、错误协议和截断不能伪装为连接成功，失败不产生启用凭证', async () => {
  for (const body of [
    null,
    {},
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] },
  ])
    await assert.rejects(
      probeModel(profile, key, async () => ({ status: 200, body })),
      (e: any) => e.code === 'response',
    );
});
test('阻止未受控地址、URL 凭证、内网、IPv6/数字 IP 与 DNS 重绑定候选', async () => {
  for (const endpoint of [
    'http://api.example.com/v1',
    'https://127.0.0.1/v1',
    'https://2130706433/v1',
    'https://[::1]/v1',
    'https://api.example.com:8443/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?key=abc',
    'https://api.example.com/v1#secret',
    'https://api.example.com/%2e/v1',
  ])
    assert.throws(() =>
      normalizeProfile({ provider: 'compatible', endpoint, model: 'unit-model' }),
    );
  assert.throws(() => normalizeProfile({ ...profile, endpoint: 'https://other.example.com/v1' }));
  assert.throws(() =>
    normalizeProfile({
      provider: 'ollama',
      endpoint: 'http://192.168.1.2:11434',
      model: 'unit-model',
    }),
  );
  assert.equal(
    normalizeProfile({
      provider: 'ollama',
      endpoint: 'http://localhost:11434/',
      model: 'unit-model',
    }).endpoint,
    'http://127.0.0.1:11434',
  );
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::ffff:127.0.0.1',
    '224.0.0.1',
  ])
    assert.equal(isPublicIPv4(ip), false);
  assert.equal(isPublicIPv4('8.8.8.8'), true);
  await assert.rejects(
    resolvePublicAddress('api.example.com', (async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]) as any),
    (e: any) => e.code === 'endpoint',
  );
});
test('代理虚拟 IP 使用独立公网解析，仍拒绝内网结果和混合地址', async () => {
  const fake = (async () => [{ address: '198.18.0.5', family: 4 }]) as any;
  assert.equal(
    await resolvePublicAddress('api.example.com', fake, async () => ['8.8.8.8']),
    '8.8.8.8',
  );
  await assert.rejects(
    resolvePublicAddress('api.example.com', fake, async () => ['127.0.0.1']),
    (e: any) => e.code === 'endpoint',
  );
  await assert.rejects(
    resolvePublicAddress('api.example.com', fake, async () => ['8.8.8.8', '169.254.169.254']),
    (e: any) => e.code === 'endpoint',
  );
  const raw = {
    Status: 0,
    Question: [{ name: 'api.example.com.', type: 1 }],
    Answer: [
      { name: 'api.example.com.', type: 5, data: 'cdn.example.com.' },
      { name: 'cdn.example.com.', type: 1, data: '8.8.8.8' },
      { name: 'unrelated.example.com.', type: 1, data: '10.0.0.1' },
    ],
  };
  assert.deepEqual(parsePublicDns(raw, 'api.example.com'), ['8.8.8.8']);
  assert.throws(() => parsePublicDns(raw, 'other.example.com'));
});
test('中转站支持完整路径自动识别以及 Responses 请求和响应（传输桩）', async () => {
  const p = normalizeProfile({
    provider: 'compatible',
    endpoint: 'https://api.example.com/v1/responses',
    model: 'unit-model',
  });
  assert.equal(p.endpoint, 'https://api.example.com/v1');
  assert.equal(p.apiStyle, 'responses');
  await probeModel(p, key, async (r) => {
    assert.equal(r.url.pathname, '/v1/responses');
    assert.equal((r.body as any).store, false);
    return fakeReply(r);
  });
  const q = normalizeProfile({
    provider: 'compatible',
    endpoint: 'https://api.example.com/v1/chat/completions/',
    model: 'unit-model',
  });
  assert.equal(q.endpoint, 'https://api.example.com/v1');
  assert.equal(q.apiStyle, 'chat-completions');
});
test('可用模型读取为只读 GET，过滤无效或含密钥的 ID，不产生启用配置（传输桩）', async () => {
  const p: AiProfile = {
    provider: 'compatible',
    endpoint: 'https://api.example.com/v1',
    model: 'gpt6.1sol',
  };
  const listTransport: AiTransport = async (request) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.pathname, '/v1/models');
    assert.equal(request.body, undefined);
    assert.equal(request.headers.Authorization, 'Bearer ' + key);
    return {
      status: 200,
      body: {
        data: [
          { id: 'gpt-6.1-sol' },
          { id: key },
          { id: '<script>' },
          { id: 'gpt-6.1-sol' },
          { id: null },
        ],
      },
    };
  };
  const result = await readModelIds(p, key, listTransport);
  assert.deepEqual(result.models, ['gpt-6.1-sol']);
});

test('Base URL 统一规范化且固定 Chat Completions，不接受 Responses', async () => {
  const calls: WireRequest[] = [];
  const m = managerFor({
    transport: async (r) => {
      calls.push(r);
      return transport(r);
    },
  });
  try {
    for (const endpoint of [
      'https://api.example.com',
      'https://api.example.com/',
      'https://api.example.com/v1/',
      'https://api.example.com/v1/models',
      'https://api.example.com/v1/chat/completions/',
    ]) {
      await m.connect({ ...input, endpoint, model: '', apiKey: key, expectedRevision: 0 });
      assert.equal(calls.at(-1)?.url.pathname, '/v1/models');
    }
    await assert.rejects(
      m.connect({
        ...input,
        endpoint: 'https://api.example.com/v1/responses',
        apiKey: key,
        expectedRevision: 0,
      }),
      (e: any) => e.code === 'endpoint',
    );
    await assert.rejects(
      m.test({ ...input, model: '', apiKey: key, expectedRevision: 0 }),
      (e: any) => e.code === 'validation',
    );
    await assert.rejects(
      m.connect({ ...input, name: key, apiKey: key, expectedRevision: 0 }),
      (e: any) => e.code === 'validation',
    );
  } finally {
    m.close();
  }
});

test('未保存的密钥或模型测试不篡改当前启用连接状态', async () => {
  const m = managerFor();
  try {
    const p = (await enable(m)).active!;
    const before = m.view().connection;
    await m.connect({
      ...input,
      id: p.id,
      apiKey: 'changed-test-only-key',
      expectedRevision: m.view().revision,
    });
    assert.deepEqual(m.view().connection, before);
    await m.test({
      ...input,
      id: p.id,
      model: 'another-model',
      expectedRevision: m.view().revision,
    });
    assert.deepEqual(m.view().connection, before);
    assert.equal(m.view().active?.model, input.model);
  } finally {
    m.close();
  }
});

test('加密失败与多实例修订冲突均不覆盖已有持久配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-ai-atomic-')),
    file = join(dir, 'settings.sqlite');
  const a = managerFor({ file });
  let b: AiSettingsManager | undefined;
  try {
    await enable(a);
    const before = readFileSync(file);
    a.close();
    const failing = managerFor({
      file,
      protector: {
        ...protector,
        protect() {
          throw new Error('unavailable');
        },
      },
    });
    try {
      assert.throws(() =>
        failing.saveDraft({
          ...input,
          id: failing.view().presets[0].id,
          expectedRevision: failing.view().revision,
        }),
      );
      assert.deepEqual(readFileSync(file), before);
    } finally {
      failing.close();
    }
    const first = managerFor({ file });
    b = managerFor({ file });
    try {
      first.preferences({ autoConnect: true, expectedRevision: first.view().revision });
      assert.throws(() =>
        b!.preferences({ autoConnect: false, expectedRevision: b!.view().revision }),
      );
    } finally {
      first.close();
    }
    b.close();
    b = managerFor({ file });
    assert.equal(b.view().autoConnect, true);
    assert.equal(b.view().presets[0].hasApiKey, true);
  } finally {
    try {
      a.close();
    } catch {}
    b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
