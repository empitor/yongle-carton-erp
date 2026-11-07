import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantFixture, actor } from './assistant-fixture.js';
import { Store } from '../server/db.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { compactSchema } from '../server/assistant/compact-schema.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { toolCatalog } from '../server/assistant/tools.js';
import { builtinPluginFor } from '../server/assistant/plugins.js';
import { askedInChat } from '../server/assistant/task-routing.js';
import { AssistantExtraTools } from '../server/assistant/extra-tools.js';
import { MarkImportService } from '../server/marks/mark-import.js';
import { MarkService } from '../server/marks/service.js';
import { productSchema } from '../shared/domain.js';
import { legacyAssistantDefaults, assistantDefaultPreset } from '../server/assistant/default-preset.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==',
  'base64',
);
const admin: any = localAdministratorActor({ ...actor, role: 'super_admin' } as any);
const ctx = (over: any = {}) =>
  ({
    threadId: over.threadId || randomUUID(),
    actor: admin,
    requestId: randomUUID(),
    text: over.text ?? '',
    files: over.files ?? [],
    check: () => admin,
    signal: new AbortController().signal,
    emit: () => {},
    ...over,
  }) as any;

test('工具目录：旧的采购分批到货工具去掉了，新工具都在，归到对的插件', () => {
  const names = toolCatalog.map((t) => t.name);
  assert.equal(names.includes('purchase.propose_receipt' as any), false);
  assert.equal(new Set(names).size, names.length, '不能重名');
  for (const name of ['system.status', 'system.check', 'system.backup', 'management.reset_preview', 'marks.recognize', 'marks.attach', 'marks.add', 'marks.remove', 'inbox.add', 'arrival.recognize'])
    assert.ok(names.includes(name as any), name);
  assert.equal(builtinPluginFor('system.backup'), 'system-maintenance');
  assert.equal(builtinPluginFor('management.reset'), 'system-maintenance');
  assert.equal(builtinPluginFor('chat.delete'), 'chat-records');
  assert.equal(builtinPluginFor('arrival.recognize'), 'order-import');
  assert.equal(builtinPluginFor('marks.remove'), 'erp-business');
});

test('系统维护只给本机最高管理员看；普通账号拿不到', () => {
  const f = assistantFixture();
  try {
    const view = (who: any) => f.manager.registry.view(who).tools.find((t) => t.name === 'system.status')!;
    assert.equal(view({ ...actor, localAdministrator: false, role: 'admin' }).permitted, false);
  } finally {
    f.close();
  }
});

test('系统状态和体检：数据如实', () => {
  const store = new Store(':memory:');
  try {
    const tools = new AssistantExtraTools(store, {} as any);
    const status: any = tools.read('system.status', {}, admin);
    assert.equal(status.records.customers, 0);
    assert.ok(status.schemaVersion > 0);
    assert.equal(status.backups.configured, false);
    const ok: any = tools.read('system.check', {}, admin);
    assert.equal(ok.healthy, true);
    const preview: any = tools.read('management.reset_preview', { scope: 'business' }, admin);
    assert.equal(preview.total, 0);
    assert.throws(() => tools.read('management.reset_preview', { scope: 'nope' }, admin));
  } finally {
    store.close();
  }
});

test('手动备份写到配置的目录；没配置就明确报错；状态里能看到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-extra-'));
  const store = new Store(join(dir, 'erp.sqlite'));
  try {
    const tools = new AssistantExtraTools(store, {} as any);
    await assert.rejects(tools.call('system.backup', {}, ctx()), /没有配置备份目录/);
    tools.backup = { dataDir: dir, backupRoot: join(dir, 'backups-out') };
    const r: any = await tools.call('system.backup', {}, ctx());
    assert.equal(r.verified, true);
    assert.ok(existsSync(join(dir, 'backups-out', r.name, 'manifest.json')));
    const status: any = tools.read('system.status', {}, admin);
    assert.equal(status.backups.total, 1);
    assert.equal(status.backups.latest[0].kind, '手动');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('收件箱手动添加文字和附件；不给内容就报错', async () => {
  const store = new Store(':memory:');
  try {
    const file = { meta: { name: '虚构.png', mime: 'image/png' }, bytes: png };
    const tools = new AssistantExtraTools(store, { file: () => file } as any);
    const text: any = await tools.call('inbox.add', { text: '虚构客户说月底对账' }, ctx());
    assert.equal(text.status, 'pending');
    const attached: any = await tools.call('inbox.add', {}, ctx({ files: [{ id: randomUUID() }] }));
    assert.ok(attached.id);
    await assert.rejects(tools.call('inbox.add', {}, ctx()));
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM inbox_items').get()!.n), 2);
  } finally {
    store.close();
  }
});

test('唛头：直接挂到产品；移除要用户明确说；只影响唛头', async () => {
  const store = new Store(':memory:');
  try {
    const product = store.saveProduct(productSchema.parse({ name: '虚构箱' }));
    const file = { meta: { name: '虚构唛头.png', mime: 'image/png' }, bytes: png };
    const tools = new AssistantExtraTools(store, { file: () => file } as any);
    tools.marks = new MarkImportService({} as any, { store } as any);
    const added: any = await tools.call('marks.add', { productId: product.id }, ctx({ files: [{ id: randomUUID() }] }));
    const service = new MarkService(store);
    assert.equal(service.list(product.id).length, 1);
    assert.equal(service.list(product.id)[0].fileName, '虚构唛头.png');
    const args = { id: added.id, expectedVersion: service.get(added.id).version };
    await assert.rejects(tools.call('marks.remove', args, ctx({ text: '今天有什么事' })), /明确说/);
    assert.equal(service.list(product.id).length, 1, '没授权不动');
    const removed: any = await tools.call('marks.remove', args, ctx({ text: '把这个产品的唛头移除' }));
    assert.equal(removed.verified, true);
    assert.equal(service.list(product.id).length, 0);
    assert.ok(store.product(product.id), '产品还在');
    await assert.rejects(tools.call('marks.add', { productId: product.id }, ctx()), /哪一份附件/);
    const bad = { meta: { name: '虚构.docx', mime: 'application/msword' }, bytes: png };
    const strict = new AssistantExtraTools(store, { file: () => bad } as any);
    strict.marks = tools.marks;
    await assert.rejects(strict.call('marks.add', { productId: product.id }, ctx({ files: [{ id: randomUUID() }] })), /只支持/);
  } finally {
    store.close();
  }
});

test('授权判断：要用户本人说，确认只在上一条说了时才算', () => {
  const p = /唛头.{0,6}移除/;
  assert.equal(askedInChat(p, '唛头都移除'), true);
  assert.equal(askedInChat(p, '确认', '唛头都移除'), true);
  assert.equal(askedInChat(p, '确认'), false);
  assert.equal(askedInChat(p, '看看库存', '唛头都移除'), false);
});

test('上一版默认提示词能被认出来升级；新版带系统维护和新工具名', () => {
  const current = assistantDefaultPreset();
  const text = current.entries.map((e) => e.content).join('\n');
  for (const name of ['marks.recognize', 'arrival.recognize', 'inbox.add', 'system.backup', 'chat.delete'])
    assert.ok(text.includes(name), name);
  assert.ok(current.entries.some((e) => e.name === '系统维护'));
  assert.equal(text.includes('order_import.recognize_mark'), false);
  const previous = legacyAssistantDefaults[2];
  const old = previous.entries.map((e) => e.content).join('\n');
  assert.ok(old.includes('order_import.recognize_mark'), '上一版用的旧名字');
  assert.equal(old.includes('chat.delete'), false);
  assert.equal(old.includes('arrival.recognize'), false);
  assert.equal(previous.entries.some((e) => e.name === '系统维护'), false);
  void writeFileSync;
});

test('工具参数压成短写法：字段、选填、可选值、数组都不丢，体积小很多', () => {
  assert.equal(compactSchema({ type: 'object', required: ['id'], properties: { id: { type: 'integer' }, note: { type: 'string' } } }), '{id:int,note?:str}');
  assert.equal(compactSchema({ enum: ['a', 'b'] }), 'a|b');
  assert.equal(compactSchema({ type: 'array', items: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } }), '[{x:num}]');
  assert.equal(compactSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }), 'str|null');
  assert.equal(compactSchema({ type: 'string', format: 'uuid' }), 'uuid');
  assert.equal(compactSchema({ type: 'object', additionalProperties: { type: 'string' } }), 'map<str>');
  const r = new AssistantToolRegistry(':memory:', () => true);
  try {
    const tools = r.view().tools;
    const full = tools.reduce((n, t) => n + JSON.stringify(t.parameters).length, 0);
    const short = tools.reduce((n, t) => n + compactSchema(t.parameters).length, 0);
    assert.ok(short < full / 2.5, '压缩后 ' + short + ' 压缩前 ' + full);
    // 每个工具的必填字段都要出现在短写法里
    for (const t of tools) {
      const required: string[] = (t.parameters as any)?.required || [];
      const text = compactSchema(t.parameters);
      for (const key of required) assert.ok(text.includes(key + ':'), t.name + ' 缺 ' + key);
    }
    const arrival = compactSchema(tools.find((t) => t.name === 'arrival.receive')!.parameters);
    assert.match(arrival, /purchaseId:int/);
    assert.match(arrival, /requestId:uuid/);
  } finally {
    r.db.close();
  }
});
