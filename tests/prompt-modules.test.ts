// 提示词模块（shared/ai/prompt-modules.ts、server/ai/recognition-modules.ts）：三个模块各自存、互不影响；默认提示词的口径；
// 比程序新的库拒绝打开；HTTP 接口（目录、读、凭证、改动）。临时目录、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { promptModules } from '../shared/ai/prompt-modules.js';
import { orderFormTool } from '../shared/import/order-form.js';
import { defaultPromptPreset } from '../server/ai/default-prompts/sales-order.js';
import { supplierDefaultPreset } from '../server/ai/default-prompts/supplier-delivery.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { createPromptManagers } from '../server/ai/recognition-modules.js';
import { startHttp } from './http-fixture.js';
import { assistantFixture } from './assistant-fixture.js';

const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
/** 接口回答：模块目录的一行、一个模块的设置视图（只认用到的字段） */
const moduleRows = z.array(z.looseObject({ id: z.string() }));
const settingsView = z.looseObject({
  revision: z.number(),
  csrfToken: z.string(),
  presets: z.array(z.looseObject({ name: z.string() })),
});

test('客户订单默认提示词只放表上放不下的口径：本公司是谁、含税合同按含税单价和价税合计；档案对应、单位换算不在里面', () => {
  const all = defaultPromptPreset().entries.map((e) => e.content).join('');
  assert.match(all, /宁波甬勒包装制品有限公司/);
  assert.match(all, /价税合计/);
  assert.match(all, /含税单价/);
  assert.doesNotMatch(all, /档案|needs-review|JSON|后端/, '档案对应由程序做，状态和格式写在表上');
  // 数量单位照原文写、不换算，写在表上
  assert.match(JSON.stringify(orderFormTool()), /数量单位：照原文写（只、个、箱等），不换算/);
});

// 比当前版本旧的库删掉重建是统一规则（versioned-sqlite.test.ts）
test('提示词库比程序新：拒绝打开，文件不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-newer-')),
    file = join(dir, 'receipts.sqlite');
  try {
    new PromptPresetManager(file, supplierDefaultPreset).close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=3');
    db.close();
    const bytes = readFileSync(file);
    assert.throws(() => new PromptPresetManager(file, supplierDefaultPreset), /提示词库比当前程序新，不能打开：它是第 3 版/);
    assert.deepEqual(readFileSync(file), bytes);
  } finally {
    removeDir(dir);
  }
});

test('提示词模块目录：只有会发给模型的三个模块（唛头不识别），各自独立标识和存储文件', () => {
  assert.deepEqual(
    promptModules.map((m) => m.id),
    ['sales-order', 'supplier-delivery', 'assistant'],
  );
  assert.equal(new Set(promptModules.map((m) => m.apiPath)).size, 3);
  assert.equal(new Set(promptModules.map((m) => m.storageFile)).size, 3);
  const storage = Object.fromEntries(promptModules.map((m) => [m.id, m.storageFile]));
  assert.equal(storage['sales-order'], 'presets.sqlite');
  assert.equal(storage['supplier-delivery'], 'receipts.sqlite');
  assert.equal(storage.assistant, 'assistant.sqlite');
  for (const module of promptModules) {
    assert.equal(module.status, 'active');
    assert.equal(module.apiPath, '/api/ai/prompt-modules/' + module.id);
  }
});

test('每个模块独立提示词预设，修改一个模块不影响其他模块并可重开保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-modules-'));
  try {
    let managers = createPromptManagers(dir);
    try {
      assert.deepEqual(Object.keys(managers).sort(), promptModules.map((m) => m.id).sort());
      assert.match(managers['sales-order'].view().presets[0].name, /标准纸箱订单识别/);
      assert.match(managers['supplier-delivery'].view().presets[0].name, /供应商送货单识别/);
      assert.match(managers.assistant.view().presets[0].name, /全局业务助手/);
      const view = managers['supplier-delivery'].view(),
        preset = structuredClone(view.presets[0]);
      preset.name = '虚构送货单自定义预设';
      managers['supplier-delivery'].change('save', { expectedRevision: view.revision, preset, activate: true });
      assert.equal(managers['supplier-delivery'].view().presets[0].name, '虚构送货单自定义预设');
      assert.match(managers['sales-order'].view().presets[0].name, /标准纸箱订单识别/);
    } finally {
      for (const manager of Object.values(managers)) manager.close();
    }
    managers = createPromptManagers(dir);
    try {
      assert.equal(managers['supplier-delivery'].view().presets[0].name, '虚构送货单自定义预设');
      assert.match(managers['sales-order'].view().presets[0].name, /标准纸箱订单识别/);
    } finally {
      for (const manager of Object.values(managers)) manager.close();
    }
  } finally {
    removeDir(dir);
  }
});

test('提示词模块接口：列目录、读一个模块不带密钥；不带 AI 凭证或跨站 403；进了超级管理员模式五个动作都能用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-api-')),
    managers = createPromptManagers(dir),
    f = assistantFixture(),
    h = await startHttp(f.store, { aiSettings: f.settings, assistant: f.manager, promptModules: managers });
  try {
    const signedIn = { Cookie: h.cookie, 'X-ERP-Auth-Token': h.auth.csrf };
    const list = await fetch(h.api + '/ai/prompt-modules', { headers: signedIn });
    assert.deepEqual(moduleRows.parse(await list.json()).map((m) => m.id), promptModules.map((m) => m.id));
    const url = h.api + '/ai/prompt-modules/supplier-delivery';
    let response = await fetch(url, { headers: signedIn }),
      view = settingsView.parse(await response.json());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(view.presets[0].name, /供应商送货单识别/);
    assert.ok(!JSON.stringify(view).includes('sk-fictional'));
    assert.equal((await fetch(url, { headers: { ...signedIn, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const preset = { ...supplierDefaultPreset(), id: randomUUID(), name: '虚构送货单模板' };
    preset.entries = preset.entries.map((e) => ({ ...e, id: randomUUID() }));
    const post = (action: string, body: object, token?: string) =>
      fetch(url + '/' + action, {
        method: 'POST',
        headers: { ...signedIn, 'Content-Type': 'application/json', ...(token ? { 'X-ERP-AI-Token': token } : {}) },
        body: JSON.stringify(body),
      });
    assert.equal((await post('save', { expectedRevision: view.revision, preset })).status, 403, '不带 AI 凭证');
    await h.enterSuperMode();
    for (const action of ['save', 'copy', 'activate', 'restore', 'delete']) {
      const body = action === 'save' ? { preset } : { id: preset.id, ...(['delete', 'restore'].includes(action) ? { confirmed: true } : {}) };
      response = await post(action, { expectedRevision: view.revision, ...body }, view.csrfToken);
      assert.equal(response.status, 200, action);
      view = settingsView.parse(await response.json());
    }
  } finally {
    await h.close();
    f.close();
    for (const manager of Object.values(managers)) manager.close();
    removeDir(dir);
  }
});
