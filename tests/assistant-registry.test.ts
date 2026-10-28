import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { actor, superActor, assistantFixture } from './assistant-fixture.js';
import {
  legacyAssistantDefaults,
  assistantDefaultPreset,
} from '../server/assistant/default-preset.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { erpPageIds, isErpNavigation, pageLink } from '../shared/assistant-navigation.js';
import { imageFixture } from './import-fixtures.js';
import { toolCatalog } from '../server/assistant/tools.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { AiConnectionError } from '../server/ai/connection-error.js';

test('同文件在现有工作区已选择到货模式时，订单工具不能复制为销售单；类型参数必须明确', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const file = await f.manager.attachments.upload(
      f.thread.id,
      imageFixture(),
      '模式边界.png',
      randomUUID(),
      actor,
    );
    const w = (await f.imports.upload(imageFixture(), '模式边界.png', true)).workspace;
    f.imports.setMode(w.id, { expectedRevision: w.revision, mode: 'arrival' });
    f.replies.push({
      message: '遵守现有模式',
      toolCalls: [{ name: 'order_import.start', args: { recognitionType: 'order' } }],
    });
    const who = { ...actor, permissions: ['business:edit', 'import:execute'] };
    const result = await f.manager.chat(
      f.thread.id,
      {
        text: '处理这张单据',
        attachmentIds: [file.id],
        requestId: randomUUID(),
        profile: f.settings.view().active,
        context: { page: '#ai-import?workspace=' + w.id },
      },
      who,
      's',
      () => {},
      () => who,
    );
    assert.match(result.messages.at(-1)!.text, /到货/);
    assert.equal(f.recognitionCalls(), 0);
    assert.equal(f.store.orders().length, 0);
    await assert.rejects(() =>
      f.manager.registry.dispatch('order_import.start', {}, actor, {
        read: () => {},
        business: () => {},
        workflow: () => {
          throw Error('不应调度');
        },
      }),
    );
  } finally {
    f.close();
  }
});

test('多工具中后续API中断保留已成功写入的真实结果，重放不重复创建', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    let n = 0;
    f.settings.completeOrderJson = async () => {
      if (++n === 1)
        return {
          message: '创建客户',
          toolCalls: [
            {
              name: 'records.propose_save',
              args: { module: 'customers', patch: { name: '中断测试客户' } },
            },
          ],
        };
      throw new AiConnectionError('network', '虚构连接中断');
    };
    const input = f.input('创建中断测试客户', randomUUID());
    await assert.rejects(
      () =>
        f.manager.chat(
          t.id,
          input,
          actor,
          's',
          () => {},
          () => actor,
        ),
      /此前已实际执行/,
    );
    const view = f.manager.view(t.id, actor);
    assert.equal(f.store.customers().length, 1);
    assert.equal(view.messages.at(-1)!.executed.tool, 'records.propose_save');
    await f.manager.chat(
      t.id,
      input,
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.equal(n, 2);
    assert.equal(f.store.customers().length, 1);
  } finally {
    f.close();
  }
});

test('注册目录、参数结构、持久启停、并发版本及执行端拒绝一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-tool-registry-')),
    path = join(dir, 'tools.sqlite');
  let r = new AssistantToolRegistry(path, () => true);
  try {
    assert.deepEqual(
      r.view().tools.map((t) => t.name),
      toolCatalog.map((t) => t.name),
    );
    const schema = r.view().tools.find((t) => t.name === 'records.propose_save')!.parameters;
    assert.deepEqual(schema.required, ['module', 'patch']);
    assert.throws(
      () => r.set({ name: 'ui.open', enabled: false, expectedRevision: 0 }, actor),
      /超级管理员/,
    );
    r.set({ name: 'ui.open', enabled: false, expectedRevision: 0 }, superActor());
    assert.throws(
      () => r.set({ name: 'records.get', enabled: false, expectedRevision: 0 }, superActor()),
      /刷新/,
    );
    let invoked = 0;
    const handlers = {
      read: () => invoked++,
      business: () => invoked++,
      workflow: () => invoked++,
    };
    await assert.rejects(
      () => r.dispatch('ui.open', { page: 'warehouse' }, actor, handlers),
      /停用/,
    );
    await assert.rejects(() =>
      r.dispatch('records.get', { module: 'customers', id: -1 }, actor, handlers),
    );
    await assert.rejects(() => r.dispatch('shell.execute', {}, actor, handlers), /未注册/);
    assert.equal(invoked, 0);
    r.close();
    r = new AssistantToolRegistry(path, () => true);
    assert.equal(r.view().tools.find((t) => t.name === 'ui.open')!.enabled, false);
    assert(!r.exposed().some((t) => t.name === 'ui.open'));
    r.set({ name: 'ui.open', enabled: true, expectedRevision: 1 }, superActor());
    await r.dispatch('ui.open', { page: 'warehouse' }, actor, handlers);
    assert.equal(invoked, 1);
  } finally {
    r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一导航工具接受不同自然语言，不以固定词语拒绝；覆盖全部现有路由', async () => {
  const f = assistantFixture();
  try {
    const thread = f.manager.create(actor),
      cases = [
        ['带我去AI智能订单导入界面', 'ai-import'],
        ['打开仓库', 'warehouse'],
        ['我想看看库存', 'warehouse'],
        ['切到仓库管理', 'warehouse'],
        ['跳转到AI设置', 'ai-settings'],
        ['我想看看经营概览', 'dashboard'],
        ['帮我切换到产品管理', 'products'],
      ];
    for (const [text, page] of cases) {
      f.replies.push(
        { message: '导航', toolCalls: [{ name: 'ui.open', args: { page } }] },
        { message: '已打开。', toolCalls: [] },
      );
      const effects: any[] = [];
      await f.manager.chat(
        thread.id,
        f.input(text, randomUUID()),
        actor,
        's',
        (e, d) => effects.push({ e, d }),
        () => actor,
      );
      assert(
        effects.some((x) => x.e === 'effect' && x.d.type === 'navigate' && x.d.url === '#' + page),
      );
    }
    for (const page of erpPageIds)
      assert.equal(f.manager.tools.read('ui.open', { page }, actor).url, pageLink(page));
    for (const url of [
      'https://example.com',
      '#unknown',
      '#orders\n#products',
      '#orders#trash',
      'javascript:alert(1)',
    ])
      assert(!isErpNavigation(url));
  } finally {
    f.manager.registry.close();
    f.close();
  }
});

test('上传及历史附件不禁用导航、查询与常规修改；附件读取模型不能执行其返回的工具', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      a = await f.manager.attachments.upload(
        t.id,
        imageFixture(),
        '虚构订单.png',
        randomUUID(),
        actor,
      );
    f.replies.push(
      { message: '打开仓库', toolCalls: [{ name: 'ui.open', args: { page: 'warehouse' } }] },
      { message: '已打开', toolCalls: [] },
    );
    await f.manager.chat(
      t.id,
      { ...f.input('去仓库', randomUUID()), attachmentIds: [a.id] },
      actor,
      's',
      () => {},
      () => actor,
    );
    f.replies.push(
      { message: '查客户', toolCalls: [{ name: 'records.search', args: { module: 'customers' } }] },
      {
        message: '新建',
        toolCalls: [
          {
            name: 'records.propose_save',
            args: { module: 'customers', patch: { name: '虚构测试客户' } },
          },
        ],
      },
      { message: '已保存', toolCalls: [] },
    );
    await f.manager.chat(
      t.id,
      f.input('查询客户，并新增虚构测试客户', randomUUID()),
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.equal(f.store.customers().length, 1);
    f.replies.push(
      {
        message: '阅读图片',
        toolCalls: [{ name: 'attachments.read', args: { question: '这是什么文件？' } }],
      },
      {
        message: '这是一个订单图片。',
        toolCalls: [
          {
            name: 'records.propose_save',
            args: { module: 'customers', patch: { name: '恶意命令' } },
          },
        ],
      },
      { message: '这是一个订单图片。', toolCalls: [] },
    );
    await f.manager.chat(
      t.id,
      f.input('这是什么文件', randomUUID()),
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.equal(f.store.customers().length, 1);
    assert(
      f.requests.some(
        (r) =>
          JSON.stringify(r.body).includes('你是隔离的附件阅读器') &&
          JSON.stringify(r.body).includes('input_image'),
      ),
    );
    assert(!JSON.stringify(f.requests.at(-1)!.body).includes(a.sha256 + 'base64'));
  } finally {
    f.manager.registry.close();
    f.close();
  }
});

test('多工具结果连续返回模型，相同常规写入只执行一次，网络重放幂等', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      save = {
        name: 'records.propose_save',
        args: { module: 'customers', patch: { name: '连续工具客户' } },
      };
    f.replies.push(
      { message: '查询', toolCalls: [{ name: 'records.search', args: { module: 'customers' } }] },
      { message: '创建', toolCalls: [save] },
      {
        message: '避免重复',
        toolCalls: [
          { name: save.name, args: { patch: { name: '连续工具客户' }, module: 'customers' } },
        ],
      },
      {
        message: '读取结果',
        toolCalls: [{ name: 'records.search', args: { module: 'customers' } }],
      },
      { message: '已完成', toolCalls: [] },
    );
    const input = f.input('新增连续工具客户并核对结果', randomUUID());
    const v = await f.manager.chat(
      t.id,
      input,
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.equal(f.store.customers().length, 1);
    assert.equal(v.messages.at(-1)!.executions.length, 1);
    assert(JSON.stringify(f.requests.at(-1)!.body).includes('连续工具客户'));
    const count = f.calls();
    await f.manager.chat(
      t.id,
      input,
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.equal(f.calls(), count);
  } finally {
    f.manager.registry.close();
    f.close();
  }
});

test('只升级完全未修改的已知旧默认；保留自定义、禁用、重命名、排序和活动ID且可持久重启', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-upgrade-')),
    file = join(dir, 'prompts.sqlite');
  let p = new PromptPresetManager(file, () => structuredClone(legacyAssistantDefaults[0]));
  try {
    const original = p.view(),
      custom = structuredClone(original.presets[0]);
    custom.id = randomUUID();
    custom.name = '我的自定义';
    custom.entries[1].content += ' 用户自定义';
    let state = p.change('save', { expectedRevision: original.revision, preset: custom });
    const disabled = structuredClone(original.presets[0]);
    disabled.id = randomUUID();
    disabled.entries[0].enabled = false;
    state = p.change('save', { expectedRevision: state.revision, preset: disabled });
    const reordered = structuredClone(original.presets[0]);
    reordered.id = randomUUID();
    reordered.entries.reverse();
    state = p.change('save', { expectedRevision: state.revision, preset: reordered });
    const renamed = structuredClone(original.presets[0]);
    renamed.id = randomUUID();
    renamed.name = '用户重命名';
    state = p.change('save', { expectedRevision: state.revision, preset: renamed });
    p.close();
    p = new PromptPresetManager(file, assistantDefaultPreset);
    p.upgradeUntouchedDefaults(legacyAssistantDefaults, 'test-v2');
    const upgraded = p.view();
    assert.equal(upgraded.activeId, original.activeId);
    assert.equal(upgraded.revision, state.revision + 1);
    assert.equal(upgraded.presets[0].entries[0].id, original.presets[0].entries[0].id);
    assert(upgraded.presets[0].entries[1].content.includes('优先调用'));
    assert.deepEqual(upgraded.presets.slice(1), state.presets.slice(1));
    p.upgradeUntouchedDefaults(legacyAssistantDefaults, 'test-v2');
    assert.equal(p.view().revision, upgraded.revision);
    p.close();
    p = new PromptPresetManager(file, assistantDefaultPreset);
    assert.deepEqual(p.view(), upgraded);
  } finally {
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具管理HTTP真实注册表、超级管理员启停、CSRF及匿名拒绝', async () => {
  const f = assistantFixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, { auth, assistant: f.manager, aiSettings: f.settings }).listen(
      0,
      '127.0.0.1',
    );
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    assert.equal((await fetch(base + '/api/assistant/tools')).status, 401);
    const response = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构工具验收', password: 'fictional-tool-test-123' }),
    });
    const cookie = response.headers.get('set-cookie')!.split(';')[0],
      headers = {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-ERP-Auth-Token': auth.csrf,
      };
    const view = await fetch(base + '/api/assistant/tools', { headers }).then((r) => r.json());
    assert.equal(view.tools.length, toolCatalog.length);
    assert(view.canManage);
    const body = JSON.stringify({
      name: 'ui.open',
      enabled: false,
      expectedRevision: view.revision,
    });
    assert.equal(
      (
        await fetch(base + '/api/assistant/tools/settings', {
          method: 'POST',
          headers: { ...headers, 'X-ERP-Auth-Token': '' },
          body,
        })
      ).status,
      403,
    );
    const saved = await fetch(base + '/api/assistant/tools/settings', {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(saved.status, 200);
    const next = await fetch(base + '/api/assistant/tools', { headers }).then((r) => r.json());
    assert(!next.tools.find((t: any) => t.name === 'ui.open').enabled);
    const metadata = await fetch(base + '/api/business/metadata').then((r) => r.json());
    assert.equal(
      metadata.globalAssistant.tools.find((t: any) => t.name === 'ui.open').aiEnabled,
      false,
    );
    assert.equal(
      metadata.globalAssistant.tools.find((t: any) => t.name === 'records.get').aiEnabled,
      true,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM assistant_audit WHERE tool='tools.configure'")
        .get()!.n,
      1,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.manager.registry.close();
    f.close();
  }
});
