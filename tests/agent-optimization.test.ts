import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assistantFixture, actor, superActor } from './assistant-fixture.js';
import { AssistantManager } from '../server/assistant/manager.js';
import {
  AgentExecutionBudget,
  agentBudgetConfig,
  AgentBudgetExceeded,
} from '../server/assistant/budget.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { verifyPageOutcome } from '../server/assistant/page-verification.js';
import { customerSchema } from '../shared/domain.js';
import { pageSnapshotDelta } from '../shared/page-observation.js';
import { pageSnapshotSchema, pageActionSchema } from '../shared/assistant-page.js';
import { completeCompatible } from '../server/ai/compatible-chat.js';
import { completeResponses } from '../server/ai/compatible-responses.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
const call = (name: string, args: any) => ({
  message: '按真实结果继续',
  toolCalls: [{ name, args }],
});
const create = (name: string) =>
  call('records.propose_save', { module: 'customers', patch: { name } });
function setup(budget?: Parameters<typeof agentBudgetConfig>[0]) {
  const f = assistantFixture();
  let manager = new AssistantManager(f.store, f.settings, f.prompts, { budget });
  const t = manager.create(actor);
  return {
    ...f,
    t,
    get agent() {
      return manager;
    },
    send: (text = '继续', requestId = randomUUID()) =>
      manager.chat(
        t.id,
        { text, requestId, profile: f.settings.view().active },
        actor,
        'session',
        () => {},
        () => actor,
      ),
    restart() {
      manager.registry.close();
      manager = new AssistantManager(f.store, f.settings, f.prompts, { budget });
    },
    close() {
      manager.registry.close();
      f.close();
    },
  };
}
test('统一预算默认15/40/8，连续多步骤超过原6轮；写入预算耗尽后重启核验并继续不重复提交', async () => {
  const f = setup({ businessWrites: 2 });
  try {
    assert.equal(f.agent.budgetLimits.modelCalls, 15);
    assert.equal(f.agent.budgetLimits.toolCalls, 40);
    for (let i = 0; i < 7; i++)
      f.replies.push(call('records.search', { module: 'customers', offset: i }));
    f.replies.push(create('优化预算A'), create('优化预算B'), create('优化预算C'));
    let v = await f.send('创建三个虚构客户');
    assert.equal(f.store.customers().length, 2);
    assert.equal(v.businessTask!.state, 'paused');
    assert.equal(v.businessTask!.budget!.used.businessWrites, 2);
    assert(v.businessTask!.budget!.used.modelCalls > 6);
    assert(v.businessTask!.steps.some((s) => s.state === 'planned'));
    const id = v.businessTask!.id;
    f.restart();
    f.replies.push(create('优化预算A'), create('优化预算B'), create('优化预算C'));
    v = await f.send();
    assert.equal(v.businessTask!.id, id);
    assert.equal(f.store.customers().length, 3);
    assert.equal(v.businessTask!.budget!.used.businessWrites, 1);
    assert.equal(v.businessTask!.state, 'completed');
  } finally {
    f.close();
  }
});
test('40次工具上限在批次中严格截断，剩余步骤保留；只读不消耗业务写入额度，持久化实际字符数', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 15; i++)
      f.replies.push({
        message: '逐步读取',
        toolCalls: [0, 1, 2].map((j) => ({
          name: 'records.search',
          args: { module: 'customers', offset: i * 3 + j },
        })),
      });
    const v = await f.send('读取虚构分页数据');
    const b = v.businessTask!.budget!;
    assert.equal(b.used.toolCalls, 40);
    assert.equal(b.used.businessWrites, 0);
    assert.equal(b.used.pageInteractions, 0);
    assert.equal(b.readOperations, 40);
    assert(b.toolOutputChars > 0);
    assert.equal(
      b.toolOutputs.reduce((n, r) => n + r.chars, 0),
      b.toolOutputChars,
    );
    assert.equal(v.businessTask!.state, 'paused');
    assert(v.businessTask!.steps.some((s) => s.state === 'planned'));
    const row = f.store.db
      .prepare('SELECT document FROM assistant_runs WHERE user_id=? ORDER BY rowid DESC LIMIT 1')
      .get(actor.id)!;
    assert.equal(JSON.parse(String(row.document)).budget.used.toolCalls, 40);
  } finally {
    f.close();
  }
});
test('无进展循环、连续失败、页面预算及总超时保留；客户端不能覆盖服务端预算', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 10; i++) f.replies.push(call('records.search', { module: 'customers' }));
    const v = await f.send('反复读同一结果');
    assert(v.businessTask!.budget!.stopReason?.includes('没有产生进展'));
    assert(v.businessTask!.budget!.used.toolCalls < 10);
    await assert.rejects(() =>
      f.agent.chat(
        f.t.id,
        {
          text: '预算',
          requestId: randomUUID(),
          profile: f.settings.view().active,
          budget: { businessWrites: 999 },
        },
        actor,
        'session',
        () => {},
        () => actor,
      ),
    );
    assert.throws(() => agentBudgetConfig({ businessWrites: 9 }));
    const b = new AgentExecutionBudget(agentBudgetConfig({ pageInteractions: 1 }), randomUUID());
    b.take('pageInteractions');
    assert.throws(() => b.take('pageInteractions'), AgentBudgetExceeded);
    assert.equal(b.view().used.businessWrites, 0);
    const failed = new AgentExecutionBudget(agentBudgetConfig(), randomUUID());
    failed.progress('first', true);
    failed.progress('second', true);
    assert.throws(() => failed.progress('third', true), /连续工具失败/);
    const timeout = new AgentExecutionBudget(agentBudgetConfig({ timeoutMs: 1 }), randomUUID());
    await new Promise((r) => setTimeout(r, 3));
    assert.throws(() => timeout.take('toolCalls'), /超时/);
  } finally {
    f.close();
  }
});
test('模型预算最后一轮和真实请求超时均保存停止原因、暂停状态和计数', async () => {
  const f = setup({ modelCalls: 2 });
  try {
    f.replies.push(
      call('records.search', { module: 'customers', offset: 0 }),
      call('records.search', { module: 'customers', offset: 1 }),
    );
    const v = await f.send('读取两页');
    assert.equal(v.businessTask!.budget!.used.modelCalls, 2);
    assert.match(v.businessTask!.budget!.stopReason!, /模型调用预算/);
    assert.equal(v.businessTask!.state, 'paused');
  } finally {
    f.close();
  }
  const expired = setup({ timeoutMs: 100 });
  try {
    expired.settings.completeOrderJson = async (_messages, _profile, signal) =>
      new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('中止')), { once: true }),
      );
    await assert.rejects(() => expired.send('超时验收'), /超时/);
    const v = expired.agent.view(expired.t.id, actor);
    assert.match(v.businessTask!.budget!.stopReason!, /超时/);
    assert.equal(v.businessTask!.state, 'paused');
    assert.equal(v.businessTask!.budget!.used.modelCalls, 1);
  } finally {
    expired.close();
  }
});

test('订单识别沿原ImportManager上报真实Provider用量，计入同一Agent模型预算', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const original = f.settings.completeOrderJson.bind(f.settings);
    f.settings.completeOrderJson = async (messages, profile, signal, options) => {
      options?.onUsage?.({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      return original(messages, profile, signal, options);
    };
    const who = { ...actor, permissions: ['business:edit', 'import:execute'] };
    const file = await f.manager.attachments.upload(
      f.thread.id,
      imageFixture(),
      '虚构用量订单.png',
      randomUUID(),
      who,
    );
    const v = await f.send('帮我识别这张客户采购订单', [file.id]);
    assert.equal(f.recognitionCalls(), 1);
    const b = v.businessTask!.budget!;
    assert.equal(b.used.modelCalls, 3);
    assert.equal(b.providerUsage.requests, 3);
    assert.equal(b.providerUsage.totalTokens, 45);
    assert.equal(f.store.orders().length, 0);
  } finally {
    f.close();
  }
});

test('逐步核验：跨记录、同记录不同字段、部分成功、未执行/未绑定/别的任务均不能错误完成', () => {
  const f = assistantFixture();
  try {
    const task = f.manager.create(actor),
      a = f.store.saveCustomer(customerSchema.parse({ name: '核验甲', notes: '旧' })),
      b = f.store.saveCustomer(customerSchema.parse({ name: '核验乙', notes: '旧' }));
    const step = (id: number, expected: any, state: any = 'uncertain', attempt = true) => {
      const s = f.manager.tasks.stage(
        task.id,
        actor,
        {
          name: 'page.act',
          args: {
            action: 'submit',
            snapshotId: randomUUID(),
            target: 'e1',
            outcome: { module: 'customers', id, expected },
          },
        },
        '核验步骤',
        {},
        true,
      );
      f.manager.tasks.update(task.id, actor, s.id, {
        state,
        attemptedAt: attempt ? new Date().toISOString() : undefined,
        pageOutcome: {
          module: 'customers',
          id,
          expected,
          beforeVersion: 1,
          beforeValues: Object.fromEntries(Object.keys(expected).map((k) => [k, '旧'])),
        },
      });
      return s.id;
    };
    const sa = step(a.id, { notes: '已改' }),
      sb = step(b.id, { notes: '已改' }),
      sc = step(a.id, { phone: '13800000000' }),
      sd = step(a.id, { notes: '已改' }, 'planned', false);
    f.store.saveCustomer(customerSchema.parse({ ...a, notes: '已改' }), a.id, a.version);
    const result = verifyPageOutcome(
      { stepIds: [sa, sb, sc, sd] },
      actor,
      task.id,
      f.manager.tools,
      f.manager.tasks,
    );
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 3);
    const steps = f.manager.tasks.get(task.id, actor)!.steps;
    assert.equal(steps.find((s) => s.id === sa)!.state, 'completed');
    assert.equal(steps.find((s) => s.id === sb)!.state, 'uncertain');
    assert.equal(steps.find((s) => s.id === sc)!.state, 'uncertain');
    assert.equal(steps.find((s) => s.id === sd)!.state, 'planned');
    const mismatch = verifyPageOutcome(
      { stepIds: [sc], module: 'customers', id: a.id, expected: { notes: '已改' } },
      actor,
      task.id,
      f.manager.tools,
      f.manager.tasks,
    );
    assert.equal(mismatch.completed, 0);
    const other = f.manager.create(actor);
    assert.throws(
      () => verifyPageOutcome({ stepIds: [sa] }, actor, other.id, f.manager.tools, f.manager.tasks),
      /当前任务/,
    );
    assert.throws(
      () =>
        verifyPageOutcome(
          { stepIds: [sa] },
          { ...actor, id: 'other' },
          task.id,
          f.manager.tools,
          f.manager.tasks,
        ),
      /任务/,
    );
    const unbound = f.manager.tasks.stage(
      task.id,
      actor,
      { name: 'page.act', args: { action: 'click', snapshotId: randomUUID(), target: 'e1' } },
      '旧步骤',
      {},
      true,
    );
    f.manager.tasks.update(task.id, actor, unbound.id, {
      state: 'uncertain',
      attemptedAt: new Date().toISOString(),
    });
    assert.equal(
      verifyPageOutcome({ stepIds: [unbound.id] }, actor, task.id, f.manager.tools, f.manager.tasks)
        .completed,
      0,
    );
  } finally {
    f.close();
  }
});
test('自定义写入即使省略/清空权限声明也需编辑权限，声明不能降权；展示和dispatch一致，真实Actor变化及高级管理均拒绝', async () => {
  const registry = new AssistantToolRegistry();
  let count = 0;
  const manifest = {
    id: 'minimum-permissions',
    name: '权限测试',
    description: '虚构测试',
    version: '1',
    capabilities: ['测试'],
  };
  const tool = (
    name: string,
    kind: 'business' | 'read' | 'workflow',
    permissions?: string[],
    capability?: 'management' | 'write',
  ) => ({
    name,
    kind,
    permissions,
    capability,
    risk: 'review',
    description: '虚构测试',
    arguments: {},
    schema: z.strictObject({}),
    execute: (_args: any, who: any) => {
      count++;
      return { actor: who.id };
    },
  });
  try {
    registry.registerPlugin(manifest, [
      tool('minimum.omitted', 'business'),
      tool('minimum.empty', 'business', []),
      tool('minimum.workflow', 'workflow', []),
      tool('minimum.read', 'read'),
      tool('minimum.hidden_write', 'read', [], 'write'),
      tool('minimum.manage', 'business', [], 'management'),
      { ...tool('minimum.high', 'read', [], 'write'), risk: 'high' },
    ]);
    const none = { ...actor, permissions: [] },
      handlers = { read: () => {}, business: () => {}, workflow: () => {} };
    for (const name of [
      'minimum.omitted',
      'minimum.empty',
      'minimum.workflow',
      'minimum.hidden_write',
    ]) {
      assert.equal(registry.view(none).tools.find((t) => t.name === name)!.permitted, false);
      await assert.rejects(() => registry.dispatch(name, {}, none, handlers), /权限/);
      await registry.dispatch(name, {}, actor, handlers);
    }
    await registry.dispatch('minimum.read', {}, none, handlers);
    assert.equal(count, 5);
    await assert.rejects(
      () =>
        registry.dispatch(
          'minimum.manage',
          {},
          { ...superActor(), localAdministrator: true },
          handlers,
        ),
      /本机最高/,
    );
    await registry.dispatch('minimum.manage', {}, localAdministratorActor(superActor()), handlers);
    await assert.rejects(
      () => registry.dispatch('minimum.omitted', {}, actor, handlers, { check: () => none }),
      /权限/,
    );
    await assert.rejects(
      () =>
        registry.dispatch('minimum.omitted', {}, actor, handlers, {
          check: () => ({ ...actor, id: 'different' }),
        }),
      /登录身份/,
    );
    assert.equal(count, 6);
    assert.equal(
      registry.view(actor).tools.find((t) => t.name === 'minimum.high')!.permitted,
      false,
    );
    await assert.rejects(
      () => registry.dispatch('minimum.high', {}, actor, handlers),
      /超级管理员/,
    );
    await registry.dispatch('minimum.high', {}, superActor(), handlers);
    assert.equal(count, 7);
  } finally {
    registry.close();
  }
});
test('自定义写能力消耗写入预算；执行后未知结果保持待核验，继续不重放已成功或未知写入', async () => {
  const f = setup();
  let success = 0,
    unknown = 0;
  try {
    f.agent.registry.registerPlugin(
      {
        id: 'write-recovery',
        name: '虚构写入恢复',
        description: '测试',
        version: '1',
        capabilities: [],
      },
      ['success', 'unknown'].map((suffix) => ({
        name: 'recovery.' + suffix,
        kind: 'read' as const,
        capability: 'write' as const,
        risk: 'review',
        description: '虚构写入',
        arguments: {},
        schema: z.strictObject({}),
        execute: () => {
          if (suffix === 'success') {
            success++;
            return { ok: true, message: '虚构成功回执' };
          }
          unknown++;
          throw new Error('外部结果未知');
        },
      })),
    );
    f.replies.push(call('recovery.success', {}), call('recovery.unknown', {}));
    let v = await f.send('执行两步虚构写入');
    assert.equal(v.businessTask!.budget!.used.businessWrites, 2, JSON.stringify(v.messages.at(-1)));
    assert.equal(
      v.businessTask!.steps.find((s) => s.tool === 'recovery.unknown')!.state,
      'uncertain',
    );
    f.replies.push(call('recovery.success', {}), call('recovery.unknown', {}));
    v = await f.send();
    assert.equal(success, 1);
    assert.equal(unknown, 1);
    assert.equal(v.businessTask!.budget!.used.businessWrites, 0);
    assert.equal(
      v.businessTask!.steps.find((s) => s.tool === 'recovery.unknown')!.state,
      'uncertain',
    );
  } finally {
    f.close();
  }
});

test('恢复旧版无逐步目标绑定的页面成功状态时重新标记待核验，身份字段不能作为业务预期', () => {
  const f = assistantFixture();
  try {
    const thread = f.manager.create(actor);
    const s = f.manager.tasks.stage(
      thread.id,
      actor,
      { name: 'page.act', args: { action: 'click', snapshotId: randomUUID(), target: 'e1' } },
      '旧版页面步骤',
      {},
      true,
    );
    f.manager.tasks.update(thread.id, actor, s.id, {
      state: 'completed',
      verification: { currentStateVerified: true, module: 'customers', id: 1 },
    });
    const restored = f.manager.tasks.verify(thread.id, actor, f.manager.tools)!;
    assert.equal(restored.steps[0].state, 'uncertain');
    assert.equal(restored.state, 'paused');
    assert.match(restored.steps[0].error!, /旧版/);
    assert.throws(() =>
      pageActionSchema.parse({
        action: 'submit',
        snapshotId: randomUUID(),
        target: 'e1',
        outcome: { module: 'customers', id: 1, expected: { id: 1 } },
      }),
    );
  } finally {
    f.close();
  }
});

test('快照增量维持新snapshotId和稳定控件ID，移除控件明确失效，字符数显著下降', () => {
  const base = pageSnapshotSchema.parse({
    snapshotId: randomUUID(),
    route: '#orders',
    capturedAt: new Date().toISOString(),
    title: '客户订单',
    text: '静态菜单与表格'.repeat(1000),
    selected: ['客户订单'],
    dialogs: [],
    controls: Array.from({ length: 60 }, (_, i) => ({
      id: 'e' + i,
      role: 'input',
      name: '字段' + i,
      value: '旧值',
      disabled: false,
    })),
    tables: [Array.from({ length: 30 }, () => Array.from({ length: 20 }, () => '虚构表格内容'))],
    feedback: [],
    truncated: false,
    mode: 'full',
  });
  const next = structuredClone(base);
  next.snapshotId = randomUUID();
  next.controls[3].value = '新值';
  next.controls.pop();
  next.feedback = ['操作已返回'];
  const delta = pageSnapshotDelta(next, base);
  assert.equal(delta.snapshotId, next.snapshotId);
  assert.equal(delta.controls.length, 1);
  assert.equal(delta.controls[0].id, 'e3');
  assert(delta.delta!.removedControlIds.includes('e59'));
  assert.equal(delta.text, '');
  assert.equal(delta.tables.length, 0);
  const old = JSON.stringify(next).length,
    size = JSON.stringify(delta).length;
  assert(size < old * 0.15, `完整${old}，增量${size}`);
  assert.equal(
    pageActionSchema.parse({
      action: 'submit',
      snapshotId: next.snapshotId,
      target: 'e3',
      outcome: { module: 'customers', id: 1, expected: { notes: '新' } },
    }).outcome?.id,
    1,
  );
});
test('Provider返回真实Token用量才统计；Chat非流式和Responses完整事件兼容，无用量不编造', async () => {
  const profile: any = {
    id: 'test',
    endpoint: 'https://api.example.com/v1',
    model: 'fixture',
    apiStyle: 'responses',
  };
  const usages: any[] = [];
  await completeCompatible(
    profile,
    'fictional-key',
    [{ role: 'user', content: '测试' }],
    async () => ({
      status: 200,
      body: {
        choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
        usage: { prompt_tokens: 123, completion_tokens: 21, total_tokens: 144 },
      },
    }),
    undefined,
    { onUsage: (u) => usages.push(u) },
  );
  await completeResponses(
    profile,
    'fictional-key',
    [{ role: 'user', content: '测试' }],
    async (req) => {
      req.onSseEvent?.({
        event: 'response.completed',
        data: JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '{}' }],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          },
        }),
      });
      return { status: 200, body: null, streamed: true };
    },
    undefined,
    { stream: true, onUsage: (u) => usages.push(u) },
  );
  assert.deepEqual(usages, [
    { inputTokens: 123, outputTokens: 21, totalTokens: 144 },
    { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  ]);
  const b = new AgentExecutionBudget(agentBudgetConfig(), randomUUID());
  b.output('fixture.read', { text: '虚构数据' });
  assert.equal(b.view().providerUsage.requests, 0);
  assert(b.view().estimateBasis.includes('估算'));
  b.providerUsage(usages[0]);
  assert.equal(b.view().providerUsage.totalTokens, 144);
});
