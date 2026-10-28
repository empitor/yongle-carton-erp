import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { actor, superActor, assistantFixture } from './assistant-fixture.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import {
  aiSettingsTab,
  assistantManagementHash,
  normalizeAiSettingsHash,
  pageLink,
} from '../shared/assistant-navigation.js';
import { PluginManagementView } from '../src/AssistantPlugins.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';

test('导航统一到AI设置工具页签，旧插件/工具链接和兼容参数可用，左侧不再有插件一级菜单', () => {
  assert.equal(assistantManagementHash, '#ai-settings?tab=tools');
  for (const old of ['#ai-plugins', '#ai-settings?tab=tools', '#ai-settings?tab=plugins']) {
    assert.equal(aiSettingsTab(old), 'tools');
    assert.equal(normalizeAiSettingsHash(old), assistantManagementHash);
  }
  assert.equal(
    normalizeAiSettingsHash('#ai-plugins?plugin=erp-page'),
    '#ai-settings?plugin=erp-page&tab=tools',
  );
  assert.equal(pageLink('ai-plugins'), assistantManagementHash);
  assert.equal(aiSettingsTab('#ai-settings?tab=api'), 'api');
  assert.equal(aiSettingsTab('#ai-prompts?assistant=1'), 'prompts');
  const nav = readFileSync(new URL('../src/Navigation.tsx', import.meta.url), 'utf8');
  assert(!nav.includes("item('ai-plugins'"));
  assert(nav.includes("item('ai-settings'"));
  const chat = readFileSync(new URL('../src/GlobalAssistant.tsx', import.meta.url), 'utf8');
  assert(chat.includes('location.hash = assistantManagementHash'));
});

test('插件关闭保留独立工具开关；重启后按原设置恢复，模型可见和执行端一致拒绝停用工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-plugin-ui-')),
    file = join(dir, 'tools.sqlite');
  let registry = new AssistantToolRegistry(file, () => true);
  const admin = superActor();
  let calls = 0;
  const handlers = { read: () => ++calls, business: () => ++calls, workflow: () => ++calls };
  try {
    registry.set({ name: 'page.observe', enabled: false, expectedRevision: 0 }, admin);
    registry.setPlugin({ id: 'erp-page', enabled: false, expectedRevision: 1 }, admin);
    const group = registry.pluginsView(actor).plugins.find((p) => p.id === 'erp-page')!;
    assert(
      group.tools.some((t) => t.name === 'page.act' && t.toolEnabled && !t.enabled && !t.usable),
    );
    assert(group.tools.some((t) => t.name === 'page.observe' && !t.toolEnabled));
    assert(!registry.exposed(actor).some((t) => t.pluginId === group.id));
    await assert.rejects(
      () => registry.dispatch('page.act', { action: 'navigate', url: '#orders' }, actor, handlers),
      /停用/,
    );
    registry.close();
    registry = new AssistantToolRegistry(file, () => true);
    registry.setPlugin({ id: 'erp-page', enabled: true, expectedRevision: 2 }, admin);
    const tools = registry.view(actor).tools;
    assert.equal(tools.find((t) => t.name === 'page.observe')!.toolEnabled, false);
    assert.equal(tools.find((t) => t.name === 'page.observe')!.usable, false);
    assert.equal(tools.find((t) => t.name === 'page.act')!.usable, true);
    await assert.rejects(() => registry.dispatch('page.observe', {}, actor, handlers), /停用/);
    await registry.dispatch('page.act', { action: 'navigate', url: '#orders' }, actor, handlers);
    assert.equal(calls, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实权限和服务状态分别参与当前可用状态，动态工具分组和数量自动来自注册表', async () => {
  let connected = false;
  const registry = new AssistantToolRegistry(':memory:', () => connected);
  try {
    const ordinary = registry.view(actor).tools;
    const limited = registry
      .view({ ...actor, permissions: [] })
      .tools.find((t) => t.name === 'page.act')!;
    assert.equal(limited.permitted, true);
    assert.equal(limited.permissionLimited, true);
    assert(limited.permissionNote.includes('仅可导航'));
    assert.equal(ordinary.find((t) => t.name === 'management.execute')!.permitted, false);
    assert.equal(ordinary.find((t) => t.name === 'order_import.execute')!.permitted, false);
    assert.equal(ordinary.find((t) => t.name === 'order_import.get')!.permitted, true);
    assert.equal(ordinary.find((t) => t.name === 'order_import.get')!.available, false);
    connected = true;
    const importActor = { ...actor, permissions: ['business:edit', 'import:execute'] };
    assert.equal(
      registry.view(importActor).tools.find((t) => t.name === 'order_import.execute')!.usable,
      true,
    );
    const owner = localAdministratorActor(superActor());
    assert.equal(
      registry.view(owner).tools.find((t) => t.name === 'management.execute')!.permitted,
      true,
    );
    assert(
      !registry
        .exposed(actor)
        .some((t) => t.name === 'management.execute' || t.name === 'order_import.execute'),
    );
    registry.registerPlugin(
      {
        id: 'dynamic-test',
        name: '动态验收插件',
        version: '2.1',
        description: '来自真实注册器',
        capabilities: ['读取'],
      },
      [
        {
          name: 'dynamic.query',
          description: '动态工具',
          arguments: {},
          kind: 'read',
          risk: 'read',
          permissions: ['fixture:read'],
          schema: z.strictObject({}),
          available: () => connected,
          execute: () => ({ ok: true }),
        },
      ],
    );
    let tool = registry.pluginsView(actor).plugins.find((p) => p.id === 'dynamic-test')!.tools[0];
    assert.equal(tool.toolEnabled, true);
    assert.equal(tool.available, true);
    assert.equal(tool.permitted, false);
    assert.equal(tool.usable, false);
    connected = false;
    tool = registry
      .view({ ...actor, permissions: ['fixture:read'] })
      .tools.find((t) => t.name === 'dynamic.query')!;
    assert.equal(tool.permitted, true);
    assert.equal(tool.available, false);
    assert.equal(tool.usable, false);
    await assert.rejects(
      () =>
        registry.dispatch(tool.name, {}, actor, {
          read: () => {},
          business: () => {},
          workflow: () => {},
        }),
      /服务未连接/,
    );
    assert.equal(
      registry.pluginsView(actor).plugins.flatMap((p) => p.tools).length,
      registry.view(actor).tools.length,
    );
  } finally {
    registry.close();
  }
});

test('层级界面展示注册工具、参数/权限/状态/日志和独立开关，插件关闭时勾选状态保留', () => {
  const registry = new AssistantToolRegistry(':memory:', () => true);
  try {
    registry.setPlugin({ id: 'erp-page', enabled: false, expectedRevision: 0 }, superActor());
    const data = registry.pluginsView(actor);
    const state = {
      ...data,
      canManage: true,
      plugins: data.plugins.map((p) => ({
        ...p,
        logs: [{ tool: p.tools[0]?.name, state: 'completed', at: '2026-10-28T00:00:00Z' }],
      })),
    };
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
      assert(html.includes('共 ' + p.tools.length + ' 个工具'));
      for (const t of p.tools) {
        assert(html.includes('工具 ' + t.name));
        assert(html.includes('单独启用工具 ' + t.name));
      }
    }
    assert.match(html, /aria-label="单独启用工具 page.act"[^>]*checked/);
    assert(!/aria-label="启用插件 ERP页面控制"[^>]*checked/.test(html));
    for (const label of [
      '参数结构',
      '权限要求',
      '账号权限',
      '执行服务',
      '当前账号操作日志',
      '独立工具设置已保留',
    ])
      assert(html.includes(label));
  } finally {
    registry.close();
  }
});

test('HTTP统一分组保留账号日志和服务权限状态，旧工具查询接口保持兼容', async () => {
  const f = assistantFixture(),
    auth = new AuthManager(':memory:');
  const server = createApp(f.store, { auth, assistant: f.manager, aiSettings: f.settings }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({
        name: '虚构统一管理测试',
        password: 'fictional-unified-plugin-password',
      }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const headers = {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-ERP-Auth-Token': auth.csrf,
    };
    const me = await (await fetch(base + '/api/auth/state', { headers })).json();
    f.store.db
      .prepare(
        'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,NULL,?,?,?,?)',
      )
      .run(me.actor.id, 'page.observe', 'completed', '{}', new Date().toISOString());
    const noise = f.store.db.prepare(
      'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,NULL,?,?,?,?)',
    );
    for (let i = 0; i < 305; i++)
      noise.run(me.actor.id, 'provider.diagnostic', 'completed', '{}', new Date().toISOString());
    const grouped = await (await fetch(base + '/api/assistant/plugins', { headers })).json();
    const page = grouped.plugins.find((p: any) => p.id === 'erp-page');
    assert(page.logs.some((r: any) => r.tool === 'page.observe'));
    assert.equal(
      page.tools.find((t: any) => t.name === 'page.observe').lastExecution.state,
      'completed',
    );
    assert.equal(
      grouped.plugins.find((p: any) => p.id === 'order-import').tools[0].available,
      false,
    );
    assert.equal(
      grouped.plugins
        .find((p: any) => p.id === 'erp-business')
        .tools.find((t: any) => t.name === 'management.execute').permitted,
      false,
    );
    const flat = await (await fetch(base + '/api/assistant/tools', { headers })).json();
    assert.deepEqual(
      grouped.plugins
        .flatMap((p: any) => p.tools)
        .map((t: any) => t.name)
        .sort(),
      flat.tools.map((t: any) => t.name).sort(),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});
