// 助手的第二批排查工具（diagnostics.errors、logs.read、accounts.events、source.search、source.read）：直接调用各工具；
// 全部排查工具（连同第一批、系统状态、联网）的机密扫描。联网命令本身的测试在 assistant-web-search.test.ts。
// 数据全是虚构的，库在内存或临时目录里。
import { pageActor } from './actor-fixture.js';
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/core/db.js';
import { AuthManager } from '../server/core/auth.js';
import { ProblemLog } from '../server/core/diagnostics/problem-log.js';
import { RunLog } from '../server/system/run-log.js';
import type { Actor } from '../server/core/index.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { diagnosticsReaders } from '../server/assistant/tools/diagnostics.js';
import { sourceReaders } from '../server/assistant/tools/source.js';
import { adminViewReaders } from '../server/assistant/tools/admin-view.js';
import { webReaders } from '../server/assistant/tools/web.js';
import { historyReaders } from '../server/assistant/tools/history.js';
import { aiStatusReaders } from '../server/assistant/tools/ai-status.js';
import { jobsReaders } from '../server/assistant/tools/jobs.js';
import { guideReaders } from '../server/assistant/tools/guide.js';
import { documentInboxReaders } from '../server/assistant/tools/documents-inbox.js';
import { systemStatus } from '../server/assistant/tools/system.js';
import type { ToolContext, ToolReader, ToolServices } from '../server/assistant/tools/context.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { manualWrite } from '../server/business/service.js';
import { customerSchema } from '../shared/core/domain.js';
import { fakeAiSettings, fakeKey } from './fake-deepseek.js';
import { readAs } from './read-result.js';

const staff = pageActor({ id: 'logs-staff', name: '虚构业务员乙', permissions: ['business:edit'], role: 'admin' });
const boss = pageActor({ id: 'logs-boss', name: '虚构老板', permissions: [], role: 'super_admin' });
const hex64 = 'cd34'.repeat(16);
function directReader(store: Store, services: ToolServices = {}) {
  const tools = new AssistantTools(store);
  tools.connect(services);
  const ctx: ToolContext = { store, services, tools, ops: tools.ops, flow: tools.flow };
  // 网址来源（用户给的、搜索返回的）由聊天那一层判断；这里只测读取本身。
  return (readers: Record<string, ToolReader>, name: string, raw: unknown, who: Actor | null) =>
    readers[name](ctx, raw, who, name, { allowedUrl: (url) => url });
}
const status = (code: number) => (e: unknown) => field(e, 'status') === code;
const problemRows = { 列表: z.array(z.looseObject({})) };
const runLogRows = { 行: z.array(z.looseObject({})) };

/** 临时程序目录：两份虚构代码，一份带像密钥的串 */
function fakeProgram() {
  const base = mkdtempSync(join(tmpdir(), 'erp-assistant-source-')),
    root = join(base, 'app');
  mkdirSync(join(root, 'server/core'), { recursive: true });
  writeFileSync(join(root, 'server/core/receive.ts'), '// 虚构的登记到货\nexport const 到货 = 1;\nthrow new Error("虚构的出错原话");');
  writeFileSync(join(root, 'server/core/keys.ts'), `const apiKey = 'sk-abcdefghijklmnop1234';\nconst session = '${hex64}';\n`);
  return { base, scope: { root, denied: [] } };
}
function problemLog() {
  const log = new ProblemLog();
  for (const [account, message] of [
    [staff.name, '虚构：采购单已被别人改过，请刷新'],
    ['虚构别人', '虚构：没有权限'],
  ])
    log.record({ source: 'server', account, method: 'POST', path: '/api/flow/arrival-receive', operation: '登记到货', category: '版本冲突', status: 409, message });
  return log;
}

test('diagnostics.errors（tools/diagnostics.ts）：普通账号只看自己的，超级管理员看全部；没登录 401；没接上说清楚', () => {
  const problems = problemLog();
  const store = new Store(':memory:');
  try {
    const call = directReader(store, { problems });
    const own = readAs(call(diagnosticsReaders, 'diagnostics.errors', {}, staff), problemRows);
    assert.equal(own.共, 1);
    assert.deepEqual(
      { 账号: own.列表[0].账号, 操作: own.列表[0].操作, 类别: own.列表[0].类别, 请求: own.列表[0].请求 },
      { 账号: staff.name, 操作: '登记到货', 类别: '版本冲突', 请求: 'POST /api/flow/arrival-receive' },
    );
    assert.equal(field(call(diagnosticsReaders, 'diagnostics.errors', {}, boss), '共'), 2);
    assert.equal(field(call(diagnosticsReaders, 'diagnostics.errors', { category: '没权限' }, boss), '共'), 0);
    assert.throws(() => call(diagnosticsReaders, 'diagnostics.errors', {}, null), status(401));
    assert.throws(() => directReader(store)(diagnosticsReaders, 'diagnostics.errors', {}, boss), /出错记录还没接上/);
    // 页面上报的文字谁都能写：超级管理员不传 source 时只给服务端记的；要看页面的，原文放在单独的键里
    problems.record({ source: 'page', account: staff.name, operation: '页面', category: '页面报错', status: 0, message: '虚构：页面发来的话' });
    assert.equal(field(call(diagnosticsReaders, 'diagnostics.errors', {}, boss), '共'), 2);
    const page = readAs(call(diagnosticsReaders, 'diagnostics.errors', { source: 'page' }, boss), problemRows).列表[0];
    assert.equal(page['页面上报的原文（没核实）'], '虚构：页面发来的话');
    assert.equal(page.给用户的话, undefined);
    assert.equal(page.类别, '页面报错');
  } finally {
    problems.close();
    store.close();
  }
});

test('logs.read（tools/diagnostics.ts）：不传条件看最后几行，传 text 就是找；只给超级管理员；没接上说清楚', () => {
  const base = mkdtempSync(join(tmpdir(), 'erp-assistant-log-'));
  const store = new Store(':memory:');
  try {
    const runLog = new RunLog(join(base, 'run.log'));
    runLog.append('虚构启动完成\n', 'out');
    runLog.append('虚构的出错：连不上\n', 'err');
    const call = directReader(store, { runLog });
    const lines = readAs(call(diagnosticsReaders, 'logs.read', { lines: 10 }, boss), runLogRows).行;
    assert.deepEqual(lines.map((l) => l.内容), ['虚构启动完成', '虚构的出错：连不上']);
    const found = readAs(call(diagnosticsReaders, 'logs.read', { text: '连不上' }, boss), runLogRows);
    assert.equal(found.共, 1);
    assert.equal(found.行[0].输出, '错误');
    assert.throws(() => call(diagnosticsReaders, 'logs.read', {}, staff), status(403));
    assert.throws(() => call(diagnosticsReaders, 'logs.read', { text: 'x' }, staff), status(403));
    assert.throws(() => directReader(store)(diagnosticsReaders, 'logs.read', {}, boss), /运行日志还没接上/);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('accounts.events（tools/admin-view.ts）：登录记录只给超级管理员，事件写中文；没接上说清楚', () => {
  const base = mkdtempSync(join(tmpdir(), 'erp-assistant-auth-'));
  const auth = new AuthManager(join(base, 'users.sqlite'));
  const store = new Store(':memory:');
  try {
    auth.event(null, 'login-failed-unknown');
    const call = directReader(store, { accountsDb: auth.db });
    const r = readAs(call(adminViewReaders, 'accounts.events', {}, boss), { 列表: z.array(z.looseObject({ 事件: z.string() })) });
    assert.equal(r.共, 1);
    assert.match(r.列表[0].事件, /登录失败/);
    assert.throws(() => call(adminViewReaders, 'accounts.events', {}, staff), status(403));
    assert.throws(() => directReader(store)(adminViewReaders, 'accounts.events', {}, boss), /账号库还没接上/);
  } finally {
    auth.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('source.search、source.read（tools/source.ts）：只读、只给超级管理员；越出程序目录被拒；没接上说清楚', () => {
  const { base, scope } = fakeProgram();
  const store = new Store(':memory:');
  try {
    const call = directReader(store, { source: scope });
    const found = readAs(call(sourceReaders, 'source.search', { text: '虚构的出错原话' }, boss), { 找到: z.array(z.looseObject({})) });
    assert.deepEqual(found.找到.map((m) => [m.文件, m.行号]), [['server/core/receive.ts', 3]]);
    const file = readAs(call(sourceReaders, 'source.read', { file: 'server/core/receive.ts', from: 2, to: 2 }, boss), {});
    assert.deepEqual(file.内容, [{ 行号: 2, 内容: 'export const 到货 = 1;' }]);
    assert.equal(file.文件共有几行, 3);
    assert.throws(() => call(sourceReaders, 'source.read', { file: '../outside.ts' }, boss), status(403));
    assert.throws(() => call(sourceReaders, 'source.search', { text: '虚构' }, staff), status(403));
    assert.throws(() => directReader(store)(sourceReaders, 'source.read', { file: 'server/core/receive.ts' }, boss), /读程序代码的范围还没接上/);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

/** 字段名像机密的、值像密钥令牌的都算漏（和 tests/diagnostics-reading.test.ts 的 leaks 同一个写法） */
const secretName = /password|passwd|hash|salt|token|csrf|secret|key|cookie|session|credential/i;
const secretValue = [/[0-9a-f]{32,}/i, /\bsk-[A-Za-z0-9]{8,}/, /Fictional-(pass|secret)/];
function leaks(value: unknown, path = '结果'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, path + '[' + i + ']'));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => [...(secretName.test(k) ? [path + '.' + k + '（字段名）'] : []), ...leaks(v, path + '.' + k)]);
  return typeof value === 'string' && secretValue.some((p) => p.test(value)) ? [path + '：' + value] : [];
}

test('机密一律不返回：每个排查工具（和系统状态、联网）的返回里没有机密字段名，也没有像密钥、令牌、口令的值', async () => {
  const { base, scope } = fakeProgram();
  const auth = new AuthManager(join(base, 'users.sqlite'));
  const problems = new ProblemLog(),
    store = new Store(':memory:'),
    registry = new AssistantToolRegistry(':memory:');
  const { settings } = fakeAiSettings({ pages: { 'https://example.com/k': { title: '虚构网页', content: '虚构的网页正文' } } });
  try {
    const c = store.saveCustomer(customerSchema.parse({ name: '虚构客户原名' }));
    manualWrite(store, { entity: 'customers', action: 'update', id: c.id, input: { ...c, name: '虚构客户新名' } }, staff);
    problems.record({
      source: 'page', account: boss.name, path: '/api/x?token=' + hex64, operation: '虚构', category: '页面报错', status: 0,
      message: '密钥 sk-abcdefghijklmnop1234 不对，password=Fictional-pass-1', reason: 'csrf ' + hex64, page: '#x?key=' + hex64,
    });
    auth.event(null, 'login-failed-unknown');
    const runLog = new RunLog(join(base, 'run.log'));
    runLog.append('Authorization: Bearer ' + hex64 + '\nsession=' + hex64 + '\n', 'err');
    const services = {
      problems,
      runLog,
      source: scope,
      accountsDb: auth.db,
      ai: settings,
      registry,
      accounts: { listAccounts: () => [{ id: '1', name: '虚构', level: 'admin', disabled: false }] },
      bots: { views: () => [{ label: '企业微信机器人', appId: 'x', hasSecret: true, enabled: true, status: { state: 'connected' as const } }] },
      deployment: { proxyPort: 1, hosts: new Set(['erp.example.test']), origins: new Set(['https://erp.example.test']) },
    };
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    // 第一批工具要业务编辑权限
    const chief = { ...boss, permissions: ['business:edit'] };
    const call = directReader(store, services);
    const results: Record<string, unknown> = {
      'history.records 按记录': call(historyReaders, 'history.records', { module: 'customers', id: c.id }, chief),
      'history.records 按时间': call(historyReaders, 'history.records', { from: today, to: today }, chief),
      'ai.status': await call(aiStatusReaders, 'ai.status', {}, chief),
      'jobs.status': call(jobsReaders, 'jobs.status', {}, chief),
      'exports.list': call(documentInboxReaders, 'exports.list', {}, chief),
      'settings.view': call(adminViewReaders, 'settings.view', {}, chief),
      'accounts.list': call(adminViewReaders, 'accounts.list', {}, chief),
      'guide.read': call(guideReaders, 'guide.read', { section: '账号' }, chief),
      系统状态: systemStatus({ store, backingUp: false }),
      'diagnostics.errors': call(diagnosticsReaders, 'diagnostics.errors', { source: 'page' }, chief),
      'logs.read': call(diagnosticsReaders, 'logs.read', {}, chief),
      'logs.read 按字找': call(diagnosticsReaders, 'logs.read', { text: 'session' }, chief),
      'accounts.events': call(adminViewReaders, 'accounts.events', {}, chief),
      'source.search': call(sourceReaders, 'source.search', { text: 'const' }, chief),
      'source.read': call(sourceReaders, 'source.read', { file: 'server/core/keys.ts' }, chief),
    };
    // 联网结果是外面网站的原文（不打码）；这里查的是我们自己不往结果里加机密：密钥、页面凭证、机密字段名
    results['web.search'] = await call(webReaders, 'web.search', { queries: ['虚构'] }, chief);
    results['web.read'] = await call(webReaders, 'web.read', { url: 'https://example.com/k' }, chief);
    for (const [name, result] of Object.entries(results)) {
      assert.ok(JSON.stringify(result).length > 20, name + '有内容');
      assert.deepEqual(leaks(result, name), [], name);
      const text = JSON.stringify(result);
      assert.ok(!text.includes(fakeKey) && !text.includes(settings.csrfToken), name);
    }
  } finally {
    problems.close();
    auth.close();
    settings.close();
    registry.close();
    store.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('出纳账号的助手能用联网、使用说明、自己的出错记录，仍然读不了业务数据', async () => {
  const cashier = pageActor({ id: 'logs-cashier', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'], role: 'admin' });
  const store = new Store(':memory:'),
    problems = problemLog(),
    registry = new AssistantToolRegistry(':memory:');
  const { settings } = fakeAiSettings();
  try {
    const tools = new AssistantTools(store);
    tools.connect({ ai: settings, problems });
    assert.ok(readAs(tools.read('guide.read', {}, cashier), { 章节: z.array(z.unknown()) }).章节.length > 0);
    assert.equal(readAs(tools.read('diagnostics.errors', {}, cashier), {}).共, 0, '只看到自己的，别人的看不到');
    assert.equal(readAs(await tools.read('web.search', { queries: ['虚构'] }, cashier), { 结果: z.array(z.unknown()) }).结果.length, 1);
    for (const name of ['records.search', 'history.records', 'exports.list'])
      assert.throws(() => tools.read(name, { module: 'customers' }, cashier), /出纳账号只能查看财务数据/, name);
    const permitted = new Map(registry.view(cashier).tools.map((t) => [t.name, t.permitted]));
    for (const name of ['web.search', 'web.read', 'guide.read', 'diagnostics.errors']) assert.equal(permitted.get(name), true, name);
    for (const name of ['records.search', 'logs.read', 'source.read']) assert.equal(permitted.get(name), false, name);
  } finally {
    registry.close();
    settings.close();
    problems.close();
    store.close();
  }
});
