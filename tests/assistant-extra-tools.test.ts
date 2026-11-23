// 助手的系统维护（状态、体检、备份、清空预览）、收件箱手动添加和读取、唛头挂上和移除这几个工具本身（extra-tools.ts、tools/system.ts、
// tools/documents-inbox.ts）。
// 内存库或临时目录、虚构数据。
import { sales, MarkService } from '../server/sales/index.js';
import { z } from 'zod';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantDeps, assistantFixture, confirmCard, makeSettings, systemDeps } from './assistant-fixture.js';
import { Store, count, type Actor, localAdministratorActor } from '../server/core/index.js';
import { toolCatalog } from '../server/assistant/tool-catalog.js';
import { builtinPluginFor } from '../server/assistant/plugins.js';
import { AssistantExtraTools } from '../server/assistant/extra-tools.js';
import { AssistantAttachments } from '../server/assistant/attachments.js';
import type { ToolContext } from '../server/assistant/tools/context.js';
import type { WorkflowContext } from '../server/assistant/order-import-state.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { documentInboxTools } from '../server/assistant/tools/documents-inbox.js';
import { resetPreview, systemBackup, systemCheck, systemStatus } from '../server/assistant/tools/system.js';
import { productSchema } from '../shared/core/domain.js';
import type { AssistantAttachment } from '../shared/core/index.js';
import { actor } from './actor-fixture.js';
import { readAs } from './read-result.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==',
  'base64',
);
const admin = localAdministratorActor({ ...actor, role: 'super_admin' });
function ctx(files: AssistantAttachment[] = []): WorkflowContext {
  return {
    threadId: files[0]?.threadId ?? randomUUID(),
    actor: admin,
    requestId: randomUUID(),
    files,
    check: () => admin,
    signal: new AbortController().signal,
    emit: () => {},
  };
}

function attachedFile(store: Store, file: Pick<AssistantAttachment, 'name' | 'mime' | 'kind' | 'transfer'>) {
  const meta: AssistantAttachment = {
    ...file,
    id: randomUUID(),
    threadId: randomUUID(),
    size: png.byteLength,
    sha256: createHash('sha256').update(png).digest('hex'),
    createdAt: '2026-11-13T08:00:00.000Z',
    deleted: false,
  };
  const attachments = new AssistantAttachments(store);
  attachments.file = () => ({ meta, bytes: png });
  const { deps } = assistantDeps(store, makeSettings());
  const tools = new AssistantExtraTools({ store, attachments, receiptAi: deps.receiptAi, imports: deps.imports, backup: deps.backup });
  return { tools, context: ctx([meta]) };
}

const pngInfo = { mime: 'image/png', kind: 'image', transfer: 'image' } as const;
const inboxListShape = { rows: z.array(z.looseObject({ id: z.number() })) };

test('系统维护、唛头、收件箱、到货识别这些工具都在目录里，归到对的插件', () => {
  const names = toolCatalog.map((t) => t.name);
  for (const name of ['system.status', 'system.check', 'system.backup', 'management.reset_preview', 'marks.add', 'marks.remove', 'inbox.add', 'arrival.recognize'])
    assert.ok(names.some((registered) => registered === name), name);
  assert.equal(builtinPluginFor('system.backup'), 'system-maintenance');
  assert.equal(builtinPluginFor('management.reset'), 'system-maintenance');
  assert.equal(builtinPluginFor('chat.delete'), 'chat-records');
  assert.equal(builtinPluginFor('arrival.recognize'), 'order-import');
  assert.equal(builtinPluginFor('marks.remove'), 'inbox-marks');
});

test('聊天里让助手备份：只出确认卡片，写明会多出一份什么备份；人点了才备份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-extra-'));
  const f = assistantFixture([], { deps: { backup: { dataDir: dir, backupRoot: join(dir, 'backups-out') } } });
  try {
    const local = localAdministratorActor({ ...actor, role: 'super_admin' });
    const t = f.manager.create(local);
    // 模型连着要备份两次：两张卡片，一份都没做
    f.replies.push({ message: '', toolCalls: [{ name: 'system.backup', args: {} }, { name: 'system.backup', args: {} }] }, { message: '请在卡片上确认。' });
    const view = await f.manager.chat(t.id, f.input('备份一下', randomUUID()), local, 's', () => {}, () => local);
    const plans = view.messages.at(-1)?.plans;
    assert.ok(plans);
    assert.equal(plans.length, 2);
    assert.equal(plans[0].label, '马上做一次完整备份');
    const summary = plans[0].summary?.[0].value;
    assert.ok(typeof summary === 'string');
    assert.match(summary, /一份完整备份：整个数据目录/);
    assert.equal(existsSync(join(dir, 'backups-out')), false, '没点确认不备份');
    const done = readAs(await confirmCard(f, view, 0, local, 's'), { name: z.string() });
    assert.ok(existsSync(join(dir, 'backups-out', done.name, 'manifest.json')));
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** 读收件箱只给库：外壳、业务服务、AI 导入一碰就报错 */
const untouched = (what: string): never => {
  throw new Error('读收件箱不该碰 ' + what);
};
function inboxReadContext(store: Store): ToolContext {
  return {
    store,
    get services() {
      return untouched('ctx.services');
    },
    get ops() {
      return untouched('ctx.ops');
    },
    get flow() {
      return untouched('ctx.flow');
    },
    get imports() {
      return untouched('ctx.imports');
    },
    get tools() {
      return untouched('ctx.tools');
    },
  };
}

test('收件箱：手动添加文字和附件，不给内容就报错；列表里正文只给前 200 个字，按编号读全文；没登录不给读', async () => {
  const store = new Store(':memory:');
  try {
    const { tools, context } = attachedFile(store, { name: '虚构.png', ...pngInfo });
    const text = readAs(await tools.call('inbox.add', { text: '虚构客户说月底对账' }, ctx()), {});
    assert.equal(text.status, 'pending');
    const attached = readAs(await tools.call('inbox.add', {}, context), {});
    assert.ok(attached.id);
    await assert.rejects(tools.call('inbox.add', {}, ctx()));
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM inbox_items'), 2);
    const long = '虚'.repeat(250);
    const added = readAs(await tools.call('inbox.add', { text: long }, ctx()), { id: z.number() });
    const readCtx = inboxReadContext(store);
    // 直接调收件箱的定义（不经外壳：这个现场里外壳一碰就报错）
    const inboxList = documentInboxTools.find((d) => d.name === 'inbox.list');
    const read = (args: unknown, who: Actor | null = actor) => inboxList?.check(args).read?.(readCtx, who);
    const listed = readAs(read({ limit: 5 }), inboxListShape);
    assert.equal(listed.rows.find((r) => r.id === added.id)?.text, '虚'.repeat(200));
    assert.equal(field(read({ id: added.id }), 'text'), long);
    for (const args of [{ id: added.id }, {}]) assert.throws(() => read(args, null), (e: unknown) => field(e, 'status') === 401);
  } finally {
    store.close();
  }
});

test('唛头：挂到产品、从产品上移除；只影响唛头（聊天里这两件事都先出确认卡片，见 assistant-boundaries）', async () => {
  const store = new Store(':memory:');
  try {
    const product = sales(store).createProduct(productSchema.parse({ name: '虚构箱' }));
    const { tools, context } = attachedFile(store, { name: '虚构唛头.png', ...pngInfo });
    const added = readAs(await tools.call('marks.add', { productId: product.id }, context), { id: z.number() });
    const service = new MarkService(store);
    assert.equal(service.list(product.id).length, 1);
    assert.equal(service.list(product.id)[0].fileName, '虚构唛头.png');
    const args = { id: added.id, expectedVersion: service.get(added.id).version };
    const removed = await tools.call('marks.remove', args, ctx());
    assert.equal(field(removed, 'verified'), true);
    assert.equal(service.list(product.id).length, 0);
    assert.ok(sales(store).product(product.id), '产品还在');
    await assert.rejects(tools.call('marks.add', { productId: product.id }, ctx()), /哪一份附件/);
    const bad = attachedFile(store, { name: '虚构.docx', mime: 'application/msword', kind: 'office', transfer: 'file' });
    await assert.rejects(bad.tools.call('marks.add', { productId: product.id }, bad.context), /只支持/);
  } finally {
    store.close();
  }
});

test('系统状态、体检、清空预览、备份如实（tools/system.ts 只要库和备份设置）：备份进行中拒绝第二个、结束后标记复原', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-system-'));
  const store = new Store(':memory:');
  try {
    const deps = { ...systemDeps(store, [1, 2]), backup: { dataDir: dir, backupRoot: join(dir, 'out') } };
    const status = systemStatus(deps);
    assert.equal(status.records.customers, 0);
    assert.ok(status.schemaVersion > 0);
    assert.equal(status.databaseMegabytes, null);
    assert.equal(status.backups.total, 0);
    assert.equal(systemCheck(deps).healthy, true);
    const preview = resetPreview(deps, { scope: 'all' }, admin);
    assert.equal(preview.workspaces, 2);
    assert.equal(preview.message, '这只是预览，什么都没删。');
    assert.equal(resetPreview(deps, { scope: 'business' }, admin).workspaces, undefined);
    assert.throws(() => resetPreview(deps, { scope: 'nope' }, admin));
    deps.backingUp = true;
    await assert.rejects(systemBackup(deps, { check: () => admin }), /已经有一个备份在进行中/);
    deps.backingUp = false;
    const done = await systemBackup(deps, { check: () => admin });
    assert.equal(done.verified, true);
    assert.equal(deps.backingUp, false);
    assert.equal(systemStatus(deps).backups.total, 1);
    assert.equal(systemStatus(deps).backups.latest[0].kind, '手动');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
