import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promptModules } from '../shared/prompt-modules.js';
import { defaultPromptPreset } from '../server/import/default-prompts.js';
import { createPromptManagers } from '../server/ai/recognition-modules.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { assistantFixture } from './assistant-fixture.js';

test('客户订单默认提示词：含税合同用含税单价和税价合计，不把未税金额当行金额', () => {
  const entry = defaultPromptPreset().entries.find((e) => e.name === '金额与精度');
  assert.ok(entry);
  assert.match(entry!.content, /税价合计/);
  assert.match(entry!.content, /含税单价/);
  assert.match(entry!.content, /金额（不含税）/);
});

test('提示词模块目录：五个模块独立标识，旧存储文件保持兼容', () => {
  assert.equal(promptModules.length, 5);
  assert.equal(new Set(promptModules.map((m) => m.id)).size, 5);
  assert.equal(new Set(promptModules.map((m) => m.apiPath)).size, 5);
  const storage = Object.fromEntries(promptModules.map((m) => [m.id, m.storageFile]));
  assert.equal(storage['sales-order'], 'presets.sqlite');
  assert.equal(storage['supplier-delivery'], 'receipts.sqlite');
  assert.equal(storage.assistant, 'assistant.sqlite');
  assert.equal(promptModules.find((m) => m.id === 'sales-order')!.status, 'active');
  assert.equal(promptModules.find((m) => m.id === 'supplier-delivery')!.status, 'active');
  assert.equal(promptModules.find((m) => m.id === 'assistant')!.status, 'active');
  for (const id of ['purchase-order', 'customer-delivery'])
    assert.equal(promptModules.find((m) => m.id === id)!.status, 'generation');
});

test('每个模块独立提示词预设，修改一个模块不影响其他模块并可重开保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-modules-'));
  try {
    let managers = createPromptManagers(dir);
    try {
      assert.match(managers['sales-order'].view().presets[0].name, /标准纸箱订单识别/);
      assert.match(managers['supplier-delivery'].view().presets[0].name, /供应商送货单识别/);
      assert.match(managers.assistant.view().presets[0].name, /全局业务助手/);
      assert.match(managers['purchase-order'].view().presets[0].name, /采购订单识别/);
      assert.match(managers['customer-delivery'].view().presets[0].name, /客户送货单识别/);
      assert.ok(
        managers['customer-delivery']
          .view()
          .presets[0].entries.some((e) => e.name === '客户仓库入库/送检格式'),
      );
      const view = managers['purchase-order'].view(),
        preset = structuredClone(view.presets[0]);
      preset.name = '采购自定义预设';
      managers['purchase-order'].change('save', {
        expectedRevision: view.revision,
        preset,
        activate: true,
      });
      assert.equal(managers['purchase-order'].view().presets[0].name, '采购自定义预设');
      assert.match(managers['customer-delivery'].view().presets[0].name, /客户送货单识别/);
    } finally {
      for (const manager of Object.values(managers)) manager.close();
    }
    managers = createPromptManagers(dir);
    try {
      assert.equal(managers['purchase-order'].view().presets[0].name, '采购自定义预设');
      assert.match(managers['sales-order'].view().presets[0].name, /标准纸箱订单识别/);
    } finally {
      for (const manager of Object.values(managers)) manager.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('提示词模块接口：目录、模块隔离、旧路径兼容和 CSRF 保护', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-api-')),
    managers = createPromptManagers(dir),
    f = assistantFixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, {
      auth,
      aiSettings: f.settings,
      assistant: f.manager,
      promptModules: managers,
    }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '提示词验收', password: 'fictional-prompt-password-123' }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const get = (path: string) => fetch(base + path, { headers: { Cookie: cookie } });
    const list = await get('/api/ai/prompt-modules');
    assert.equal(list.status, 200);
    const modules = (await list.json()) as any[];
    assert.equal(modules.length, 5);
    assert.equal(modules.find((m) => m.id === 'purchase-order')!.status, 'generation');
    const purchase = await get('/api/ai/prompt-modules/purchase-order');
    assert.equal(purchase.status, 200);
    const view = (await purchase.json()) as any;
    assert.match(view.presets[0].name, /采购订单识别/);
    const denied = await fetch(base + '/api/ai/prompt-modules/purchase-order/save', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: view.revision, preset: view.presets[0] }),
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    f.close();
    for (const manager of Object.values(managers)) manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
