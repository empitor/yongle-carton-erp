// 排查用的诊断记录：最近出错（服务端记录、页面上报、分类、留存、按账号看）和登录记录。
// 不起整个系统：express 只挂请求关卡、要测的路由和统一出错回答；库都是 :memory: 或临时目录，账号和数据都是虚构的。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './http-fixture.js';
import express from 'express';
import { z } from 'zod';
import { AuthManager } from '../server/accounts/index.js';
import {
  type Actor,
  AppError,
  ConflictError,
  ProblemLog,
  readRecentProblems,
  errorReason,
  pageProblemRouter,
} from '../server/core/index.js';
import { problemCategory, stackLines } from '../server/core/diagnostics/problem-kinds.js';
import { operationName, routePath } from '../server/core/diagnostics/operation-names.js';
import { readLoginRecords } from '../server/accounts/index.js';
import { installRequestGuards } from '../server/http-guards.js';
import { apiErrorHandler } from '../server/http-errors.js';
import { createProblemReporter } from '../src/ui/problem-report.js';

const boss: Actor = pageActor({ id: 'a1', name: '虚构管理员', permissions: [], role: 'super_admin' });
const clerk: Actor = pageActor({ id: 's1', name: '虚构业务员', permissions: ['business:edit'], role: 'admin' });

test('分类：401 和页面凭证过期不记，其余按状态和类别分成中文类别', () => {
  assert.equal(problemCategory(200, undefined, ''), null);
  assert.equal(problemCategory(401, 'authentication', '请先登录账号。'), null);
  assert.equal(problemCategory(403, undefined, '页面凭证已过期，请刷新页面。'), null);
  assert.equal(problemCategory(403, undefined, '登录页面已过期，请刷新。'), null);
  assert.equal(problemCategory(403, 'permission', '没有权限'), '没权限');
  assert.equal(problemCategory(400, 'validation', '请选择产品'), '校验没过');
  assert.equal(problemCategory(415, undefined, '请使用 JSON 请求'), '校验没过');
  assert.equal(problemCategory(409, undefined, '记录已被其他页面修改，请刷新后重试'), '版本冲突');
  assert.equal(problemCategory(409, 'duplicate', '本工作区已导入'), '重复提交');
  assert.equal(problemCategory(409, undefined, '用户名已存在。'), '冲突');
  assert.equal(problemCategory(404, undefined, '不存在'), '不存在');
  assert.equal(problemCategory(429, undefined, '太多'), '太频繁');
  assert.equal(problemCategory(500, 'data-rule', '数据没有保存'), '数据规则');
  assert.equal(problemCategory(500, undefined, '保存失败'), '出错');
});

test('堆栈只留前 5 行的函数名、文件和行号；原因摘要是类名加第一行并打码', () => {
  const error = new TypeError('读不到 total\n第二行不要');
  error.stack = [
    'TypeError: 读不到 total',
    ...Array.from({ length: 7 }, (_, i) => `    at fn${i} (${join(process.cwd(), 'server', 'flow', 'service.ts')}:${10 + i}:5)`),
  ].join('\n');
  const lines = stackLines(error);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'fn0 server/flow/service.ts:10');
  assert.equal(errorReason(error), 'TypeError: 读不到 total');
  assert.match(errorReason(new Error('连接 sk-abcdefghijklmnop1234 失败')), /\*\*\*/);
});

test('操作叫法按接口对应，对不上的叫其他操作', () => {
  assert.equal(operationName('POST', '/api/order-batches/12/receive'), '登记到货');
  assert.equal(operationName('POST', '/api/flow/88/confirm'), '核对入库');
  assert.equal(operationName('PUT', '/api/orders/3'), '修改订单');
  assert.equal(operationName('GET', '/api/warehouse/movements'), '查看库存流水');
  assert.equal(operationName('POST', '/api/finance/vouchers'), '保存凭证');
  assert.equal(operationName('POST', '/api/auth/login'), '登录');
  assert.equal(operationName('GET', '/api/nothing-here'), '其他操作');
  assert.equal(routePath('/api/Order-Batches/12/receive?x=1'), '/api/order-batches/12');
  assert.equal(routePath('/api/flow/abc.DEF_ghi$%'), '/api/flow/abcdefghi');
  assert.equal(routePath('/api/NOTE-TO-ASSISTANT.call-tools'), '/api');
  assert.equal(routePath('/api'), '/api');
  assert.ok(routePath('/api/flow/' + 'x'.repeat(200)).length <= 80);
});

test('最近出错：筛选、分页、默认 24 小时、30 天和 5000 条的上限、打码', () => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const log = new ProblemLog(':memory:', () => now);
  const add = (account: string | null, category: '出错' | '校验没过', message = '虚构的说法') =>
    log.record({ source: 'server', account, method: 'POST', path: '/api/orders?x=1', operation: '保存订单', category, status: category === '出错' ? 500 : 400, message });
  add('虚构业务员', '校验没过');
  now += 31 * 24 * 3600_000;
  add('虚构业务员', '出错', 'token=' + 'a1'.repeat(20));
  add(null, '校验没过');
  // 30 天前那条在记新的时候清掉了
  assert.equal(log.list({ from: '2026-01-01' }).total, 2);
  const all = log.list();
  assert.equal(all.total, 2);
  assert.equal(all.items[0].account, '未登录');
  assert.equal(all.items[1].path, '/api/orders', '查询串不存');
  assert.equal(all.items[1].message, 'token=***');
  assert.equal(log.list({ category: '出错' }).total, 1);
  assert.equal(log.list({ operation: '订单' }).total, 2);
  assert.equal(log.list({ account: '虚构业务员' }).total, 1);
  assert.deepEqual(
    [log.list({ limit: 1 }).more, log.list({ limit: 1, offset: 1 }).more],
    [true, false],
  );
  // 不给时间段只看最近 24 小时
  now += 2 * 24 * 3600_000;
  assert.equal(log.list().total, 0);
  assert.throws(() => log.list({ from: '不是时间' }), /时间写法不对/);
  // 登录账号的服务端记录最多 3500 条，没登录的那一条不会被它挤掉
  for (let i = 0; i < 3510; i++) add('虚构业务员', '校验没过');
  assert.equal(log.list({ from: '2026-01-01' }).total, 3501);
  assert.equal(log.list({ from: '2026-01-01', operation: '订单', limit: 50, offset: 3500 }).items[0].account, '未登录');
  log.close();
});

test('读最近出错：没登录拒绝，超级管理员看全部，别的账号只看自己的', () => {
  const log = new ProblemLog();
  for (const account of ['虚构业务员', '虚构仓管'])
    log.record({ source: 'server', account, operation: '保存订单', category: '校验没过', status: 400, message: '缺产品' });
  assert.throws(() => readRecentProblems(log, null), (e: AppError) => e.status === 401);
  assert.equal(readRecentProblems(log, boss).total, 2);
  const own = readRecentProblems(log, clerk, { account: '虚构仓管' });
  assert.deepEqual(own.items.map((i) => i.account), ['虚构业务员']);
  log.close();
});

/** 起一个只挂请求关卡、几条测试路由和统一出错回答的服务 */
async function serve(auth: AuthManager, log: ProblemLog) {
  const app = express();
  installRequestGuards(app, { auth, problems: log });
  app.use('/api/auth', auth.router());
  app.use('/api/diagnostics', pageProblemRouter(log, (req) => auth.actor(req)));
  app.post('/api/orders', (req) => {
    z.strictObject({ name: z.string().min(1) }).parse(req.body);
  });
  app.put('/api/orders/:id', () => {
    throw new ConflictError();
  });
  app.post('/api/flow/:id/confirm', () => {
    throw new TypeError('虚构的程序错误');
  });
  app.get('/api/products', () => {
    throw new AppError('没有权限看产品', 403, 'permission');
  });
  app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));
  app.use(apiErrorHandler);
  const server = await listen(app);
  const base = server.origin;
  let cookie = '';
  const send = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf, Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
  return { send, stop: () => server.close() };
}

test('服务端：被拒和出错的请求都记下（中文类别、操作、账号、5xx 堆栈），请求体不存，401 不记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-diag-'));
  const auth = new AuthManager(join(dir, 'users.sqlite')),
    log = new ProblemLog();
  const s = await serve(auth, log);
  try {
    assert.equal((await s.send('/orders', { name: '' })).status, 401, '没登录');
    assert.equal(log.list().total, 0, '没登录不记');
    assert.equal((await s.send('/auth/setup', { name: '虚构管理员', password: 'Fictional-pass-1' })).status, 200);
    assert.equal((await s.send('/orders', { name: '', password: 'Fictional-secret-1' })).status, 400);
    assert.equal((await s.send('/orders/1', { name: 'x' }, 'PUT')).status, 409);
    assert.equal((await s.send('/flow/9/confirm', {})).status, 500);
    assert.equal((await s.send('/products')).status, 403);
    assert.equal((await s.send('/nothing')).status, 404);
    const { items } = log.list();
    assert.deepEqual(
      items.map((i) => [i.operation, i.category, i.status, i.account]).reverse(),
      [
        ['保存订单', '校验没过', 400, '虚构管理员'],
        ['修改订单', '版本冲突', 409, '虚构管理员'],
        ['核对入库', '出错', 500, '虚构管理员'],
        ['查看产品', '没权限', 403, '虚构管理员'],
        ['其他操作', '不存在', 404, '虚构管理员'],
      ],
    );
    const crash = items.find((i) => i.status === 500);
    assert.ok(crash, '记下了 500 那一次');
    assert.equal(crash.reason, 'TypeError: 虚构的程序错误');
    const stack = crash.stack;
    assert.ok(stack && stack.length > 0 && stack.length <= 5);
    assert.match(stack[0], /diagnostics-records\.test\.ts:\d+$/);
    assert.equal(crash.message, '保存失败，请检查服务日志后重试');
    assert.ok(!JSON.stringify(log.db.prepare('SELECT * FROM recent_problems').all()).includes('Fictional-secret-1'));
  } finally {
    await s.stop();
    auth.close();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面上报：标明来自页面、按类别记，401 不记；格式不对回 400；每个账号限量，超了直接丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-diag-'));
  const auth = new AuthManager(join(dir, 'users.sqlite')),
    log = new ProblemLog();
  const s = await serve(auth, log);
  try {
    await s.send('/auth/setup', { name: '虚构管理员', password: 'Fictional-pass-1' });
    const problems = [
      { kind: 'request', status: 409, method: 'POST', path: '/api/order-batches/3/receive?x=1', message: '订货单已更新，请刷新后重填。', page: '#warehouse' },
      { kind: 'request', status: 401, path: '/api/orders', message: '请先登录账号。' },
      { kind: 'network', path: '/api/orders', message: '连不上服务器' },
      { kind: 'script', message: 'Cannot read properties of undefined', page: '#orders' },
      { kind: 'notice', message: '安排送货没办成' },
    ];
    assert.equal((await s.send('/diagnostics/page-problems', { problems })).status, 202);
    const items = log.list({ source: 'page' }).items.reverse();
    assert.deepEqual(
      items.map((i) => [i.source, i.category, i.operation]),
      [
        ['页面', '页面请求失败', '登记到货'],
        ['页面', '连不上服务器', '操作订单'],
        ['页面', '页面报错', '页面'],
        ['页面', '出错提示', '页面'],
      ],
    );
    assert.equal(items[0].path, '/api/order-batches/3', '地址按路由归一');
    assert.equal(items[0].page, '#warehouse');
    assert.equal((await s.send('/diagnostics/page-problems', { problems: [{ kind: 'x', message: '' }] })).status, 400);
    assert.equal((await s.send('/diagnostics/page-problems', { problems: [], extra: 1 })).status, 400);
    assert.equal(log.list({ source: 'server' }).total, 0, '上报接口自己的失败不记');
    for (let i = 0; i < 10; i++)
      await s.send('/diagnostics/page-problems', { problems: Array.from({ length: 10 }, (_, n) => ({ kind: 'script', message: '报错' + i + '-' + n })) });
    assert.equal(log.list({ source: 'page' }).total, 60);
  } finally {
    await s.stop();
    auth.close();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('前端上报器：攒一批发、同样的 1 分钟只报一次、每分钟最多 20 条、截短，401 和上报接口自己不报', () => {
  let now = 0;
  const batches: Parameters<Parameters<typeof createProblemReporter>[0]['send']>[0][] = [],
    timers: (() => void)[] = [];
  /** 到点发出攒着的那一批 */
  const flushNext = () => {
    const flush = timers.shift();
    assert.ok(flush, '有攒着等发的一批');
    flush();
  };
  const report = createProblemReporter({
    now: () => now,
    page: () => '#orders',
    send: (problems) => batches.push(problems),
    schedule: (flush) => timers.push(flush),
  });
  report({ kind: 'request', status: 401, path: '/api/orders', message: '请先登录' });
  report({ kind: 'request', status: 500, path: '/api/diagnostics/page-problems', message: 'x' });
  report({ kind: 'script', message: 'x'.repeat(900) + '\n第二行' });
  report({ kind: 'script', message: 'x'.repeat(900) + '\n第二行' });
  report({ kind: 'request', status: 409, method: 'post', path: '/api/orders/1?debug=1', message: '版本冲突' });
  assert.equal(timers.length, 1);
  flushNext();
  assert.equal(batches.length, 1);
  const [first, second] = batches[0];
  assert.equal(first.message.length, 500);
  assert.equal(first.page, '#orders');
  assert.deepEqual([second.method, second.path], ['POST', '/api/orders/1']);
  for (let i = 0; i < 30; i++) report({ kind: 'notice', message: '提示' + i });
  while (timers.length) flushNext();
  assert.equal(batches.flat().length, 20, '一分钟最多 20 条');
  assert.ok(batches.every((b) => b.length <= 10));
  now += 61_000;
  report({ kind: 'script', message: 'x'.repeat(900) });
  flushNext();
  assert.equal(batches.flat().length, 21, '过了一分钟同样的可以再报');
  const broken = createProblemReporter({ send: () => { throw new Error('断网'); }, schedule: (f) => f() });
  assert.doesNotThrow(() => broken({ kind: 'script', message: '不影响页面' }));
});

test('登录记录：成功、失败、没有这个账号、被限流（只记一次）都记，不记口令；只给超级管理员看', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-diag-'));
  const auth = new AuthManager(join(dir, 'users.sqlite')),
    log = new ProblemLog();
  const s = await serve(auth, log);
  try {
    await s.send('/auth/setup', { name: '虚构管理员', password: 'Fictional-pass-1' });
    for (let i = 0; i < 7; i++) await s.send('/auth/login', { name: '虚构管理员', password: 'Fictional-wrong-' + i });
    await s.send('/auth/login', { name: 'Fictional-typed-password', password: 'x' });
    const all = readLoginRecords(auth.db, boss, { limit: 50 });
    const events = all.items.map((i) => i.event).reverse();
    assert.deepEqual(events.slice(0, 6), ['登录成功', ...Array<string>(5).fill('登录失败（密码不对）')]);
    assert.equal(events.filter((e) => e === '登录被限流（输错次数太多）').length, 1);
    assert.equal(events.at(-1), '登录失败（没有这个账号）');
    assert.equal(all.items[0].account, '—');
    const text = JSON.stringify(all);
    assert.ok(!text.includes('Fictional-wrong') && !text.includes('Fictional-typed-password'));
    assert.equal(readLoginRecords(auth.db, boss, { event: '登录失败' }).total, 6);
    assert.equal(readLoginRecords(auth.db, boss, { event: '不存在的事件' }).total, 0);
    assert.equal(readLoginRecords(auth.db, boss, { account: '虚构管理员', event: '成功' }).total, 1);
    assert.throws(() => readLoginRecords(auth.db, clerk), (e: AppError) => e.status === 403);
    assert.throws(() => readLoginRecords(auth.db, null), (e: AppError) => e.status === 401);
  } finally {
    await s.stop();
    auth.close();
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('请求体超过接口上限：回 413，并说出这个接口的上限', async () => {
  const app = express();
  app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '2mb' }), (_req, res) => res.json({ ok: true }));
  app.use(apiErrorHandler);
  const server = await listen(app);
  try {
    const r = await fetch(server.origin + '/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    });
    assert.equal(r.status, 413);
    assert.match(z.object({ message: z.string() }).parse(await r.json()).message, /最多 2 MB/);
  } finally {
    await server.close();
  }
});
