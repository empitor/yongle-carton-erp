// ai.status（server/assistant/tools/ai-status.ts）：补齐识别失败分页、七天用量汇总、无密钥与查余额失败的行为。
// 内存库、临时目录、虚构数据、假模型。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { pageActor } from './actor-fixture.js';
import { ctxOf } from './assistant-fixture.js';
import { fakeAiSettings, httpError } from './fake-deepseek.js';
import { importWorkspace } from './order-import-fixture.js';
import { readAs } from './read-result.js';

const boss = pageActor({ id: 'status-boss', name: '虚构老板', permissions: ['business:edit'], role: 'super_admin' });

const failureListSchema = z.object({
  共: z.number(),
  列表: z.array(z.object({ 操作: z.string(), 哪一步: z.string(), 操作人: z.string(), 原因: z.string() })),
  还有更多: z.boolean(),
});

const usageSchema = z.object({
  按天: z.array(z.object({ 日期: z.string(), 轮数: z.number(), 失败: z.number(), 输入: z.number(), 输出: z.number(), 缓存命中: z.number() })),
});

test('ai.status：接上识别导入时列出最近失败、按 workspaceId 过滤并分页，操作人为空时写“没有记录”', async () => {
  const store = new Store(':memory:');
  const f = importWorkspace();
  try {
    const w = await f.upload();
    f.manager.recordFailure(new Error('第一条虚构失败'), { id: w.id, fileName: '甲.xlsx', size: 10 }, { operation: 'upload', stage: 'upload-validation' });
    f.manager.recordFailure(new Error('第二条虚构失败'), { fileName: '乙.xlsx', size: 20 }, { operation: 'analyze', stage: 'model-call', actor: boss });
    const ctx = ctxOf(store, { ai: f.settings, imports: f.manager });

    const page1 = readAs(await ctx.tools.read('ai.status', { limit: 1, offset: 0 }, boss), { 最近识别失败: failureListSchema });
    assert.equal(page1.最近识别失败.共, 2);
    assert.equal(page1.最近识别失败.列表.length, 1);
    assert.equal(page1.最近识别失败.还有更多, true);
    assert.equal(page1.最近识别失败.列表[0].操作, '识别');
    assert.equal(page1.最近识别失败.列表[0].操作人, boss.name);

    const byWorkspace = readAs(await ctx.tools.read('ai.status', { workspaceId: w.id, limit: 10, offset: 0 }, boss), { 最近识别失败: failureListSchema });
    assert.equal(byWorkspace.最近识别失败.共, 1);
    assert.equal(byWorkspace.最近识别失败.还有更多, false);
    assert.equal(byWorkspace.最近识别失败.列表[0].操作, '上传文件');
    assert.equal(byWorkspace.最近识别失败.列表[0].操作人, '没有记录');
  } finally {
    f.close();
    store.close();
  }
});

test('ai.status：统计最近七天助手每天的调用轮数、失败次数和 Token 用量，缺预算字段按 0 算', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T06:00:00Z') });
  const store = new Store(':memory:');
  const { settings } = fakeAiSettings();
  try {
    const threadId = randomUUID();
    const now = new Date().toISOString();
    store.db.prepare('INSERT INTO assistant_threads(id,user_id,title,created_at,updated_at,document) VALUES(?,?,?,?,?,?)').run(threadId, boss.id, '虚构对话', now, now, '{}');
    store.db.prepare('INSERT INTO assistant_runs(id,thread_id,user_id,state,created_at,document) VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      threadId,
      boss.id,
      'completed',
      now,
      JSON.stringify({ budget: { providerUsage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 50 } } }),
    );
    store.db.prepare('INSERT INTO assistant_runs(id,thread_id,user_id,state,created_at,document) VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      threadId,
      boss.id,
      'failed',
      now,
      JSON.stringify({}),
    );

    const ctx = ctxOf(store, { ai: settings });
    const status = readAs(await ctx.tools.read('ai.status', {}, boss), { 最近七天助手用量: usageSchema });
    assert.equal(status.最近七天助手用量.按天.length, 1);
    assert.equal(status.最近七天助手用量.按天[0].日期, '2026-11-12');
    assert.equal(status.最近七天助手用量.按天[0].轮数, 2);
    assert.equal(status.最近七天助手用量.按天[0].失败, 1);
    assert.equal(status.最近七天助手用量.按天[0].输入, 120);
    assert.equal(status.最近七天助手用量.按天[0].输出, 30);
    assert.equal(status.最近七天助手用量.按天[0].缓存命中, 50);
  } finally {
    settings.close();
    store.close();
  }
});

test('ai.status：没有密钥时不查余额；查余额上游报错时回查询失败说明而不是整条报错', async () => {
  const store = new Store(':memory:');
  const withoutKey = fakeAiSettings({ saveKey: false });
  const withKey = fakeAiSettings();
  try {
    const noKeyStatus = readAs(await ctxOf(store, { ai: withoutKey.settings }).tools.read('ai.status', {}, boss), {
      密钥: z.string(),
      余额: z.string(),
      上次检查: z.object({ 结果: z.string(), 时间: z.string() }),
    });
    assert.equal(noKeyStatus.密钥, '还没保存');
    assert.equal(noKeyStatus.余额, '没有密钥，查不了余额');
    assert.equal(noKeyStatus.上次检查.时间, '还没检查过');
    assert.equal(withoutKey.fake.calls.length, 0);

    withKey.fake.next('/user/balance', httpError(500).response);
    const failedBalance = readAs(await ctxOf(store, { ai: withKey.settings }).tools.read('ai.status', {}, boss), {
      余额: z.object({ 查询失败: z.string() }),
    });
    assert.equal(failedBalance.余额.查询失败, 'DeepSeek 服务内部出错，请稍后重试。');
    assert.deepEqual(withKey.fake.calls.map((call) => call.path), ['/user/balance']);
  } finally {
    withoutKey.settings.close();
    withKey.settings.close();
    store.close();
  }
});
