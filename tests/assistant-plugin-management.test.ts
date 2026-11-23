import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { assistantFixture } from './assistant-fixture.js';
import { count, localAdministratorActor } from '../server/core/index.js';
import { pageParams } from '../shared/core/index.js';
import { assistantManagementHash, pageLink } from '../shared/assistant/assistant-navigation.js';
import { PluginManagementView } from '../src/assistant/AssistantPlugins.js';
import { startHttp } from './http-fixture.js';
import { AuthManager } from '../server/accounts/index.js';
import { toolCatalog } from '../server/assistant/tool-catalog.js';
import { actor, grant, superActor } from './actor-fixture.js';
import { readAs } from './read-result.js';

function toolNamed<T extends { name: string }>(tools: readonly T[], name: string) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, name);
  return tool;
}

const listedTool = z.looseObject({ name: z.string(), usable: z.boolean() });

test('工具管理在 AI 设置的工具页签：助手按名字打开设置里的页签', () => {
  assert.equal(assistantManagementHash, '#ai-settings?tab=tools');
  assert.equal(pageParams('ai-settings', assistantManagementHash).tab, 'tools');
  assert.equal(pageLink('ai-plugins'), assistantManagementHash);
  assert.equal(pageLink('ai-prompts'), '#ai-settings?tab=prompts');
  assert.equal(pageParams('ai-settings', '#ai-settings?tab=api').tab, 'api');
  assert.equal(pageParams('ai-settings', '#ai-settings?tab=prompts&assistant=1').tab, 'prompts');
});

test('启停只有超级管理员能改；整组停用保留单个工具的开关，重开后照旧；模型看不到、执行端也拒绝停用的工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-plugin-ui-')),
    file = join(dir, 'tools.sqlite');
  let registry = new AssistantToolRegistry(file);
  const admin = superActor();
  let calls = 0;
  const handlers = { read: () => ++calls, business: () => ++calls, workflow: () => ++calls };
  try {
    assert.throws(() => registry.set({ name: 'page.observe', enabled: false, expectedRevision: 0 }, actor), /超级管理员/);
    assert.throws(() => registry.setPlugin({ id: 'erp-page', enabled: false, expectedRevision: 0 }, actor), /超级管理员/);
    registry.set({ name: 'page.observe', enabled: false, expectedRevision: 0 }, admin);
    registry.setPlugin({ id: 'erp-page', enabled: false, expectedRevision: 1 }, admin);
    const group = registry.pluginsView(actor).plugins.find((p) => p.id === 'erp-page');
    assert.ok(group);
    assert(
      group.tools.some((t) => t.name === 'ui.open' && t.toolEnabled && !t.enabled && !t.usable),
    );
    assert(group.tools.some((t) => t.name === 'page.observe' && !t.toolEnabled));
    assert(!registry.exposed(actor).some((t) => t.pluginId === group.id));
    await assert.rejects(
      () => registry.dispatch('ui.open', { module: 'orders' }, actor, handlers),
      /停用/,
    );
    registry.close();
    registry = new AssistantToolRegistry(file);
    registry.setPlugin({ id: 'erp-page', enabled: true, expectedRevision: 2 }, admin);
    const tools = registry.view(actor).tools;
    const observe = toolNamed(tools, 'page.observe');
    assert.equal(observe.toolEnabled, false);
    assert.equal(observe.usable, false);
    assert.equal(toolNamed(tools, 'ui.open').usable, true);
    await assert.rejects(() => registry.dispatch('page.observe', {}, actor, handlers), /停用/);
    await registry.dispatch('ui.open', { module: 'orders' }, actor, handlers);
    assert.equal(calls, 1);
  } finally {
    registry.close();
    // Windows 上杀毒扫描会短暂占住刚建的 SQLite 文件，删目录要重试几次
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('真实权限参与当前可用状态，分组里的工具数和注册表一致', async () => {
  const registry = new AssistantToolRegistry(':memory:');
  try {
    const ordinary = registry.view(actor).tools;
    const limited = toolNamed(registry.view({ ...actor, permissions: [] }).tools, 'page.observe');
    assert.equal(limited.permitted, true);
    assert.equal(toolNamed(ordinary, 'management.execute').permitted, false);
    assert.equal(toolNamed(ordinary, 'order_import.execute').permitted, false);
    const getImport = toolNamed(ordinary, 'order_import.get');
    assert.equal(getImport.permitted, true);
    const importActor = { ...actor, permissions: grant('business:edit', 'import:execute') };
    assert.equal(
      toolNamed(registry.view(importActor).tools, 'order_import.execute').usable,
      true,
    );
    const owner = localAdministratorActor(superActor());
    assert.equal(
      toolNamed(registry.view(owner).tools, 'management.execute').permitted,
      true,
    );
    assert(
      !registry
        .exposed(actor)
        .some((t) => t.name === 'management.execute' || t.name === 'order_import.execute'),
    );
    assert.equal(
      registry.pluginsView(actor).plugins.flatMap((p) => p.tools).length,
      registry.view(actor).tools.length,
    );
  } finally {
    registry.close();
  }
});

test('分组界面：每组名字、说明、整组开关，组里每个工具的状态和单独开关；整组停用时工具勾选保留', () => {
  const registry = new AssistantToolRegistry(':memory:');
  try {
    registry.setPlugin({ id: 'erp-page', enabled: false, expectedRevision: 0 }, superActor());
    const data = registry.pluginsView(actor);
    const state = { ...data, canManage: true };
    const html = renderToStaticMarkup(
      createElement(PluginManagementView, {
        state,
        busy: false,
        onPluginToggle: () => {},
        onToolToggle: () => {},
      }),
    );
    for (const p of state.plugins) {
      assert(html.includes(p.name));
      assert(html.includes('工具（' + p.tools.length + '）'));
      for (const t of p.tools) {
        assert(html.includes('工具 ' + t.name));
        assert(html.includes('单独启用工具 ' + t.name));
      }
    }
    assert.match(html, /aria-label="单独启用工具 ui.open"[^>]*checked/);
    assert(!/aria-label="启用分组 ERP页面"[^>]*checked/.test(html));
    assert(html.includes('独立工具设置已保留'));
    // 版本号、参数结构、权限细节和操作日志这些排查信息不再放在这页
    for (const gone of ['参数结构', '权限要求', '当前账号操作日志']) assert(!html.includes(gone), gone);
    assert.doesNotMatch(html, /版本 [0-9]/);
  } finally {
    registry.close();
  }
});

test('经接口管工具：未登录 401、没页面凭证 403；整组和单个启停照改、记审计，版本过期 409；分组接口和工具接口一致', async () => {
  const f = assistantFixture(),
    // 本机管理：从本机进来的最高管理员能管工具
    h = await startHttp(f.store, { assistant: f.manager, aiSettings: f.settings, auth: new AuthManager(':memory:', Date.now, { localAdministration: true }) });
  try {
    for (const path of ['/assistant/plugins', '/assistant/tools']) assert.equal((await h.send(path)).status, 401);
    const grouped = readAs(await (await fetch(h.api + '/assistant/plugins', { headers: h.headers })).json(), {
      plugins: z.array(z.looseObject({ id: z.string(), tools: z.array(listedTool) })),
    });
    const flat = readAs(await (await fetch(h.api + '/assistant/tools', { headers: h.headers })).json(), {
      canManage: z.boolean(), revision: z.number(), tools: z.array(listedTool),
    });
    assert(flat.canManage);
    assert.equal(flat.tools.length, toolCatalog.length);
    assert.deepEqual(grouped.plugins.flatMap((p) => p.tools).map((t) => t.name).sort(), flat.tools.map((t) => t.name).sort());

    const tool = { name: 'ui.open', enabled: false, expectedRevision: flat.revision };
    assert.equal((await h.post('/assistant/tools/settings', tool, null)).status, 403);
    assert.equal((await h.post('/assistant/tools/settings', tool)).status, 200);
    const plugin = { id: 'erp-page', enabled: false, expectedRevision: flat.revision + 1 };
    assert.equal((await h.post('/assistant/plugins/settings', plugin)).status, 200);
    assert.equal((await h.post('/assistant/plugins/settings', plugin)).status, 409);
    const after = readAs(await (await fetch(h.api + '/assistant/tools', { headers: h.headers })).json(), {
      tools: z.array(z.looseObject({ pluginId: z.string(), enabled: z.boolean() })),
    });
    assert(after.tools.filter((t) => t.pluginId === 'erp-page').every((t) => !t.enabled));
    assert.equal(count(f.store.db, "SELECT COUNT(*) FROM assistant_audit WHERE tool='tools.configure'"), 1);
  } finally {
    await h.close();
    f.close();
  }
});
