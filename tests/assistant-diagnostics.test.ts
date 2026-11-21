// 助手排查问题用的只读工具（history.records、ai.status、jobs.status、exports.list、settings.view、accounts.list、guide.read，
// 以及放开给超级管理员的系统状态）：直接调用各工具。机密扫描和第二批工具一起在 assistant-logs-web.test.ts。数据全是虚构的，库在内存里。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/index.js';
import { manualWrite } from '../server/business/service.js';
import { customerSchema } from '../shared/core/domain.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import type { ToolContext, ToolReader } from '../server/assistant/tools/context.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { historyReaders } from '../server/assistant/tools/history.js';
import { aiStatusReaders } from '../server/assistant/tools/ai-status.js';
import { jobsReaders } from '../server/assistant/tools/jobs.js';
import { adminViewReaders } from '../server/assistant/tools/admin-view.js';
import { guideReaders } from '../server/assistant/tools/guide.js';
import express from 'express';
import { userManualRouter } from '../server/system/user-manual.js';
import { documentInboxReaders } from '../server/assistant/tools/documents-inbox.js';
import { managementReaders } from '../server/assistant/tools/management.js';
import { systemStatus } from '../server/assistant/tools/system.js';
import { insertExport } from '../server/documents/export-records.js';
import { defaultDocumentTemplates } from '../shared/documents/document-templates.js';
import { fakeAiSettings } from './fake-deepseek.js';
import { ctxOf } from './assistant-fixture.js';
import { listen } from './http-fixture.js';
import { readAs } from './read-result.js';

const staff = pageActor({ id: 'diag-staff', name: '虚构业务员甲', permissions: ['business:edit'], role: 'admin' });
const viewer = pageActor({ id: 'diag-viewer', name: '虚构只读', permissions: [], role: 'admin' });
// 从域名访问的超级管理员：不是本机最高管理员会话
const boss = pageActor({ id: 'diag-boss', name: '虚构老板', permissions: ['business:edit'], role: 'super_admin' });
const call = (readers: Record<string, ToolReader>, name: string, ctx: ToolContext, raw: unknown, who: Actor | null) =>
  readers[name](ctx, raw, who, name);
const denied = (status: number) => (e: unknown) => field(e, 'status') === status;
const listedRows = z.looseObject({ 列表: z.array(z.looseObject({})) });
const historyView = { 修改历史: listedRows };
const lastCheck = z.looseObject({ 结果: z.string() });
/** 和页面一样改一次客户名字（manualWrite 办完写修改记录） */
function renamedCustomer(store: Store, who = staff) {
  const c = store.saveCustomer(customerSchema.parse({ name: '虚构客户原名' }));
  manualWrite(store, { entity: 'customers', action: 'update', id: c.id, input: { ...c, name: '虚构客户新名' } }, who);
  return c;
}

test('history.records（tools/history.ts）：按记录查给关联记录和中文的修改历史；能看记录的只读账号也能查，纯财务账号不能；按人按时间只给超级管理员', () => {
  const store = new Store(':memory:');
  try {
    const c = renamedCustomer(store),
      ctx = ctxOf(store);
    const one = readAs(call(historyReaders, 'history.records', ctx, { module: 'customers', id: c.id }, staff), historyView);
    assert.equal(one.记录, '客户 ' + c.id);
    assert.equal(one.修改历史.共, 1);
    assert.equal(one.修改历史.列表[0].谁, staff.name);
    assert.match(JSON.stringify(one.修改历史.列表[0].改了什么), /虚构客户新名/);
    // 能看记录的人就能看这条记录的修改历史（只读账号以前被拒）
    assert.equal(readAs(call(historyReaders, 'history.records', ctx, { module: 'customers', id: c.id }, viewer), historyView).修改历史.共, 1);
    const cashier = pageActor({ id: 'diag-cashier', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'], role: 'admin' });
    assert.throws(() => call(historyReaders, 'history.records', ctx, { module: 'customers', id: c.id }, cashier), denied(403));
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const range = { from: today, to: today, person: staff.name };
    assert.throws(() => call(historyReaders, 'history.records', ctx, range, staff), denied(403));
    const trail = listedRows.parse(call(historyReaders, 'history.records', ctx, range, boss));
    assert.equal(trail.共, 1);
    assert.equal(trail.列表[0].记录, '客户 ' + c.id);
    assert.throws(() => call(historyReaders, 'history.records', ctx, { from: today }, boss), /from 和 to/);
  } finally {
    store.close();
  }
});

test('ai.status（tools/ai-status.ts）：密钥和上次检查结果；余额只给超级管理员现查，业务人员不发余额请求；没接上说清楚；要业务编辑权限', async () => {
  const store = new Store(':memory:');
  const { settings, fake } = fakeAiSettings({ balance: { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] } });
  try {
    const balanceCalls = () => fake.calls.filter((c) => c.path === '/user/balance').length;
    const ctx = ctxOf(store, { ai: settings });
    const plain = readAs(await call(aiStatusReaders, 'ai.status', ctx, {}, staff), { 余额: z.string(), 上次检查: lastCheck });
    assert.match(plain.余额, /只有超级管理员能查余额/);
    assert.equal(balanceCalls(), 0, '业务人员不发余额请求');
    assert.equal(plain.上次检查.结果, '保存后还没检查', '也不改全员共用的上次检查');
    const status = readAs(await call(aiStatusReaders, 'ai.status', ctx, {}, boss), {
      密钥: z.string(),
      余额: z.looseObject({ 明细: z.array(z.looseObject({})) }),
      上次检查: lastCheck,
      最近七天助手用量: z.looseObject({}),
    });
    assert.equal(balanceCalls(), 1);
    assert.match(status.密钥, /^已保存/);
    assert.equal(status.余额.够不够用, '余额不足');
    assert.equal(status.余额.明细[0].总余额, '0.00');
    assert.equal(status.上次检查.结果, '余额不足');
    assert.equal(status.最近识别失败, '识别导入没有接上');
    assert.deepEqual(status.最近七天助手用量.按天, []);
    await assert.rejects(async () => call(aiStatusReaders, 'ai.status', ctxOf(store), {}, staff), /还没接上/);
    await assert.rejects(async () => call(aiStatusReaders, 'ai.status', ctx, {}, viewer), denied(403));
  } finally {
    settings.close();
    store.close();
  }
});

test('exports.list 和 jobs.status（tools/documents-inbox.ts、tools/jobs.ts）：普通账号只看自己导出的，超级管理员看全部；没交付完的进后台事项', () => {
  const store = new Store(':memory:');
  const { settings } = fakeAiSettings();
  try {
    const add = (actorId: string, completed = false) => {
      const id = randomUUID();
      insertExport(store, {
        id, digest: 'd', kind: 'purchase', recordId: 7, actorId, format: 'docx', filename: '虚构订货单.docx', sha256: 'a'.repeat(64),
        templateId: 'purchase-default', templateRevision: 1, batchNumber: null, shipDate: null,
        options: { markOrdered: false, markShipped: false, expectedVersion: 1, draft: false, statusBefore: '待订货' }, templateSnapshot: defaultDocumentTemplates().templates[0], bytes: Buffer.from('x'),
      });
      if (completed) store.db.prepare('UPDATE document_exports SET delivered_at=?,completed_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), id);
      return id;
    };
    const mine = add(staff.id);
    add('someone-else');
    add(staff.id, true);
    const ctx = ctxOf(store, { ai: settings });
    const own = readAs(call(documentInboxReaders, 'exports.list', ctx, {}, staff), {});
    assert.equal(own.共, 2);
    assert.equal(field(call(documentInboxReaders, 'exports.list', ctx, {}, boss), '共'), 3);
    const jobs = readAs(call(jobsReaders, 'jobs.status', ctx, {}, staff), { 没交付完的导出: listedRows, 识别: z.looseObject({}) });
    assert.deepEqual(jobs.没交付完的导出.列表.map((e) => e.导出编号), [mine]);
    assert.equal(jobs.没交付完的导出.列表[0].单据, '采购单 7');
    assert.equal(jobs.没交付完的导出.列表[0].交付, '已生成，还没下载');
    assert.deepEqual(jobs.识别.排队, { 正在识别: 0, 排队: 0, 同时最多: 3 });
    assert.equal(jobs.自动备份, '最近没有失败');
    assert.throws(() => call(jobsReaders, 'jobs.status', ctx, {}, viewer), denied(403));
  } finally {
    settings.close();
    store.close();
  }
});

test('accounts.list、settings.view（tools/admin-view.ts）：只给超级管理员，级别写中文，设置只给状态不给密钥和机器人编号', () => {
  const store = new Store(':memory:');
  const { settings } = fakeAiSettings(),
    registry = new AssistantToolRegistry(':memory:');
  try {
    const services = {
      ai: settings,
      accounts: { listAccounts: () => [{ id: '1', name: '虚构出纳', level: 'cashier', disabled: true }] },
      bots: { views: () => [{ label: '企业微信机器人', appId: 'bot-虚构编号', hasSecret: true, enabled: false, status: { state: 'off' as const } }] },
      deployment: null,
      registry,
    };
    const ctx = ctxOf(store, services);
    assert.deepEqual(field(call(adminViewReaders, 'accounts.list', ctx, {}, boss), '列表'), [
      { 名字: '虚构出纳', 级别: '出纳', 状态: '已停用', 账号编号: '1' },
    ]);
    assert.throws(() => call(adminViewReaders, 'accounts.list', ctx, {}, staff), denied(403));
    assert.throws(() => call(adminViewReaders, 'accounts.list', ctxOf(store), {}, boss), /还没接上/);
    const view = readAs(call(adminViewReaders, 'settings.view', ctx, {}, boss), { 助手工具: z.looseObject({}) });
    assert.deepEqual(view.机器人, { 企业微信机器人: { 凭据: '已填写', 启用: '没启用', 连接: '未启用' } });
    assert.deepEqual(view.部署, { 方式: '本机运行' });
    assert.equal(view.同时识别几个文件, 3);
    assert.deepEqual(view.助手工具.停用的工具, []);
    assert.ok(!JSON.stringify(view).includes('bot-虚构编号'));
    assert.equal(field(call(adminViewReaders, 'settings.view', ctxOf(store), {}, boss), '同时识别几个文件'), '还没接上');
    assert.throws(() => call(adminViewReaders, 'settings.view', ctx, {}, staff), denied(403));
  } finally {
    registry.close();
    settings.close();
    store.close();
  }
});

test('guide.read（tools/guide.ts）：不传章节给目录，传了给那一节；标题对不上按关键词找小节；都没有说清有哪些', () => {
  const store = new Store(':memory:');
  try {
    const ctx = ctxOf(store);
    const toc = readAs(call(guideReaders, 'guide.read', ctx, {}, viewer), { 章节: z.array(z.string()) }).章节;
    assert.ok(toc.includes('备份') && toc.includes('送货'), toc.join('、'));
    const backup = readAs(call(guideReaders, 'guide.read', ctx, { section: '备份' }, viewer), { 内容: z.string() });
    assert.equal(backup.章节, '备份');
    assert.ok(backup.内容.length > 0);
    assert.throws(() => call(guideReaders, 'guide.read', ctx, { section: '虚构章节' }, viewer), /有这些/);
    // 标题里没有的词（“收款”在“财务”一节的小标题里）按关键词在全文里找，不让模型一次次猜章节名
    const pay = readAs(call(guideReaders, 'guide.read', ctx, { section: '收款' }, viewer), {
      对得上的小节: z.array(z.looseObject({ 小节: z.string(), 内容: z.string() })),
    });
    assert.ok(pay.对得上的小节.some((b) => b.小节 === '财务 › 收款和付款' && b.内容.includes('收款')), JSON.stringify(pay).slice(0, 300));
    assert.throws(() => call(guideReaders, 'guide.read', ctx, {}, null), denied(401));
  } finally {
    store.close();
  }
});

test('使用说明只有一份：“使用说明”页的 GET /api/guide 和 guide.read 读的是同一份使用手册，章节和正文一样', async () => {
  const app = express().use('/api/guide', userManualRouter());
  const server = await listen(app);
  const store = new Store(':memory:');
  try {
    const port = server.port;
    const page = readAs(await (await fetch('http://127.0.0.1:' + port + '/api/guide')).json(), {
      intro: z.string(),
      sections: z.array(z.looseObject({ title: z.string(), body: z.string() })),
    });
    assert.equal(page.title, '使用手册');
    assert.ok(page.intro.length > 0, '第一节之前的引言也给页面');
    const ctx = ctxOf(store);
    assert.deepEqual(field(call(guideReaders, 'guide.read', ctx, {}, viewer), '章节'), page.sections.map((s) => s.title));
    for (const words of ['送货', '备份']) {
      const shown = page.sections.find((s) => s.title.includes(words));
      assert.ok(shown, words);
      assert.equal(field(call(guideReaders, 'guide.read', ctx, { section: words }, viewer), '内容'), shown.body, words);
    }
  } finally {
    store.close();
    await server.close();
  }
});

test('本机专用的只读工具放开给从域名访问的超级管理员：系统状态、体检、记录上下文、删除预览能用，备份、清空、数据管理命令仍只限本机', () => {
  const store = new Store(':memory:'),
    registry = new AssistantToolRegistry(':memory:');
  try {
    const usable = new Map(registry.view(boss).tools.map((t) => [t.name, t.permitted]));
    for (const name of ['system.status', 'system.check', 'management.context', 'management.delete_preview'])
      assert.equal(usable.get(name), true, name);
    for (const name of ['system.backup', 'management.reset', 'management.reset_preview', 'management.execute'])
      assert.equal(usable.get(name), false, name);
    assert.equal(new Map(registry.view(staff).tools.map((t) => [t.name, t.permitted])).get('system.status'), false);
    const status = systemStatus({ store, backingUp: false });
    assert.equal(typeof status.uptimeMinutes, 'number');
    assert.equal(status.disk, null);
    const c = renamedCustomer(store);
    const context = readAs(call(managementReaders, 'management.context', ctxOf(store), { module: 'customers', id: c.id }, boss), { history: z.array(z.unknown()) });
    assert.equal(context.history.length, 1);
    assert.throws(() => call(managementReaders, 'management.context', ctxOf(store), { module: 'customers', id: c.id }, staff), denied(403));
  } finally {
    registry.close();
    store.close();
  }
});
