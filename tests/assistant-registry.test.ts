// 助手工具注册表（tool-registry.ts）：目录和参数结构只定义一处；启停只有超级管理员能改、重开还在；
// 分派前按账号核对权限（界限 1 的分派层）；没注册的命令不执行。内存库或临时目录、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AssistantToolRegistry, superAdminTools } from '../server/assistant/tool-registry.js';
import { toolCatalog, toolDefinitions } from '../server/assistant/tool-catalog.js';
import { pageToolDefinitions } from '../server/assistant/tools/page.js';
import { sessionTools } from '../server/assistant/tools/session.js';
import { orderImportTools } from '../server/assistant/tools/order-import.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { pragmaInteger } from '../server/core/sql.js';
import { erpPageIds, isErpNavigation, pageLink } from '../shared/assistant/assistant-navigation.js';
import { assistantFixture } from './assistant-fixture.js';
import { actor, grant, superActor } from './actor-fixture.js';
import { readAs } from './read-result.js';

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
// Windows 上杀毒扫描会短暂占住刚建的 SQLite 文件，删目录要重试几次
const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const counting = () => {
  let count = 0;
  const run = () => void count++;
  return { handlers: { read: run, business: run, workflow: run }, count: () => count };
};

function named<T extends { name: string }>(items: readonly T[], name: string) {
  const item = items.find((entry) => entry.name === name);
  assert.ok(item, name);
  return item;
}

test('工具定义只写一处：目录和定义一一对应、每个都带参数结构；页面、会话、AI 导入的参数照常校验', () => {
  assert.equal(new Set(toolDefinitions.map((t) => t.name)).size, toolDefinitions.length);
  assert.deepEqual(toolCatalog.map((t) => t.name), toolDefinitions.map((t) => t.name));
  for (const t of toolCatalog) assert.equal('schema' in t, false, t.name);
  for (const t of toolDefinitions) assert.ok(t.schema, t.name);
  const observe = named(pageToolDefinitions, 'page.observe').schema;
  assert.equal(observe.safeParse({ mode: '不认识的' }).success, false);
  assert.equal(observe.safeParse({ mode: 'summary' }).success, true);
  assert.deepEqual(pageToolDefinitions.map((t) => t.name), ['page.observe'], '看页面只有这一个工具');
  const deleteChat = named(sessionTools, 'chat.delete').schema;
  assert.equal(deleteChat.safeParse({ all: true }).success, true);
  assert.equal(deleteChat.safeParse({ threadIds: ['不是UUID'] }).success, false);
  assert.deepEqual(named(orderImportTools, 'order_import.start').schema.parse({}), { recognitionType: 'order' });
  assert.equal(named(orderImportTools, 'order_import.get').schema.safeParse({ taskId: randomUUID(), extra: 1 }).success, false);
  const registry = new AssistantToolRegistry(':memory:');
  try {
    assert.deepEqual(registry.view().tools.map((t) => t.name), toolCatalog.map((t) => t.name));
    const schema = named(registry.view().tools, 'records.propose_save').parameters;
    // 改一条、新建一条传 patch，一次新建几条传 items：两样都不是必填，二选一由校验管
    assert.deepEqual(schema.required, ['module']);
    assert.ok(schema.properties?.patch && schema.properties?.items);
  } finally {
    registry.close();
  }
});

test('启停：只有超级管理员能改、版本过期拒绝；停用的模型看不到、分派也拒绝；重开还在；参数不对和没注册的不执行', async () => {
  const dir = tempDir('erp-tool-registry-'),
    path = join(dir, 'tools.sqlite');
  let r = new AssistantToolRegistry(path);
  const { handlers, count } = counting();
  try {
    assert.throws(() => r.set({ name: 'ui.open', enabled: false, expectedRevision: 0 }, actor), /超级管理员/);
    r.set({ name: 'ui.open', enabled: false, expectedRevision: 0 }, superActor());
    assert.throws(() => r.set({ name: 'records.get', enabled: false, expectedRevision: 0 }, superActor()), /刷新/);
    await assert.rejects(() => r.dispatch('ui.open', { module: 'warehouse' }, actor, handlers), /停用/);
    await assert.rejects(() => r.dispatch('records.get', { module: 'customers', id: -1 }, actor, handlers));
    await assert.rejects(() => r.dispatch('shell.execute', {}, actor, handlers), /未注册/);
    assert.equal(count(), 0);
    r.close();
    r = new AssistantToolRegistry(path);
    assert.equal(named(r.view().tools, 'ui.open').enabled, false);
    assert(!r.exposed().some((t) => t.name === 'ui.open'));
    r.set({ name: 'ui.open', enabled: true, expectedRevision: 1 }, superActor());
    await r.dispatch('ui.open', { module: 'warehouse' }, actor, handlers);
    assert.equal(count(), 1);
  } finally {
    r.close();
    removeDir(dir);
  }
});

test('写入类一律要编辑权限（清单和分派一致）；本机专用的只认服务器本机的最高管理员；执行中身份或权限变了就拒绝', async () => {
  const registry = new AssistantToolRegistry();
  const { handlers, count } = counting();
  const none = { ...actor, permissions: [] };
  try {
    for (const [name, args] of [
      ['records.propose_save', { module: 'customers', patch: { name: '虚构客户' } }],
      ['chat.delete', { all: true }],
    ] as const) {
      assert.equal(named(registry.view(none).tools, name).permitted, false);
      await assert.rejects(() => registry.dispatch(name, args, none, handlers), /权限/);
      await registry.dispatch(name, args, actor, handlers);
    }
    assert.equal(count(), 2);
    await assert.rejects(
      () => registry.dispatch('system.backup', {}, { ...superActor(), localAdministrator: true }, handlers),
      /只能在服务器本机用最高管理员账号做/,
    );
    await registry.dispatch('system.backup', {}, localAdministratorActor(superActor()), handlers);
    assert.equal(count(), 3);
    const save = { module: 'customers', patch: { name: '虚构客户' } };
    await assert.rejects(() => registry.dispatch('records.propose_save', save, actor, handlers, { check: () => none }), /权限/);
    await assert.rejects(
      () => registry.dispatch('records.propose_save', save, actor, handlers, { check: () => ({ ...actor, id: 'different' }) }),
      /登录身份/,
    );
    assert.equal(count(), 3);
  } finally {
    registry.close();
  }
});

test('只给超级管理员的工具：业务人员调每一个都 403，清单里也是不可用；超级管理员账号（不用进模式）照常可用', async () => {
  const registry = new AssistantToolRegistry(':memory:');
  try {
    const sample: Record<string, unknown> = {
      'source.search': { text: '虚构' },
      'source.read': { file: 'server/core/receive.ts' },
      'prompts.propose': { module: 'assistant', presetId: randomUUID(), entryId: randomUUID(), expectedRevision: 0, content: '虚构' },
      'production.correct': { id: 1, expectedVersion: 1, reason: '虚构', goodQuantity: '1' },
    };
    const handlers = { read: () => ({}), business: () => ({}), workflow: () => ({}) };
    const boss = { ...actor, role: 'super_admin' as const };
    for (const name of superAdminTools) {
      await assert.rejects(
        () => registry.dispatch(name, sample[name] ?? {}, actor, handlers),
        (e: unknown) => typeof e === 'object' && e !== null && 'status' in e && e.status === 403,
        name,
      );
      assert.equal(named(registry.view(actor).tools, name).usable, false, name);
      assert.equal(named(registry.view(boss).tools, name).permitted, true, name);
    }
    assert.equal(named(registry.view(actor).tools, 'prompts.get').permitted, true, '读提示词照旧');
  } finally {
    registry.close();
  }
});

test('ui.open 能开全部页面（财务页要财务权限）；不是本系统页面的链接不认', () => {
  const f = assistantFixture();
  try {
    const finance = { ...actor, permissions: grant(...actor.permissions, 'finance:view') };
    for (const page of erpPageIds) {
      assert.equal(readAs(f.manager.tools.read('ui.open', { module: page }, finance), {}).url, pageLink(page));
      if (page.startsWith('finance')) assert.throws(() => f.manager.tools.read('ui.open', { module: page }, actor), /权限/);
      else assert.equal(readAs(f.manager.tools.read('ui.open', { module: page }, actor), {}).url, pageLink(page));
    }
    for (const url of ['https://example.com', '#unknown', '#orders\n#products', '#orders#trash', 'javascript:alert(1)'])
      assert(!isErpNavigation(url), url);
  } finally {
    f.close();
  }
});

test('0.8.4 的助手工具设置库（没记版本）打开时删掉重建，工具和插件回到默认启用；比程序新的拒绝打开', () => {
  const dir = tempDir('erp-tool-registry-084-'),
    path = join(dir, 'tools.sqlite');
  try {
    // 照 0.8.4 的建表语句造一个虚构的库，没有版本号：停用了一个工具和一个插件，改过 3 次
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tool_settings(name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tool_settings_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT INTO tool_settings_revision(id,revision) VALUES(1,3);`);
    const insert = old.prepare('INSERT INTO tool_settings(name,enabled,updated_at) VALUES(?,?,?)');
    insert.run('ui.open', 0, '2026-10-01T00:00:00.000Z');
    insert.run('plugin:chat-records', 0, '2026-10-02T00:00:00.000Z');
    old.close();
    const settingsRows = () => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return { version: pragmaInteger(db, 'user_version'), rows: db.prepare('SELECT * FROM tool_settings').all() };
      } finally {
        db.close();
      }
    };
    let r = new AssistantToolRegistry(path);
    let revision: number;
    try {
      assert.deepEqual(settingsRows(), { version: 2, rows: [] }, '按当前结构重建，旧的启停记录不留');
      assert.equal(named(r.view().tools, 'ui.open').enabled, true, '回到默认启用');
      assert.equal(r.pluginsView().plugins.find((p) => p.id === 'chat-records')?.enabled, true);
      revision = r.view().revision;
      r.set({ name: 'ui.open', enabled: false, expectedRevision: revision }, superActor());
    } finally {
      r.close();
    }
    r = new AssistantToolRegistry(path);
    try {
      assert.equal(r.view().revision, revision + 1, '当前版本原样打开，刚改的还在');
    } finally {
      r.close();
    }
    const newer = new DatabaseSync(path);
    newer.exec('PRAGMA user_version=3');
    newer.close();
    const bytes = readFileSync(path);
    assert.throws(() => new AssistantToolRegistry(path), /助手工具设置库比当前程序新，不能打开：它是第 3 版/);
    assert.deepEqual(readFileSync(path), bytes);
  } finally {
    removeDir(dir);
  }
});
