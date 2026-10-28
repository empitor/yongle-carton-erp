import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, actor } from './assistant-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture, xlsxFixture } from './import-fixtures.js';
import { AssistantManager } from '../server/assistant/manager.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { confirmedValue } from '../server/assistant/task-memory.js';
import { modelToolResult, compactToolHistory, contextChars } from '../server/assistant/context.js';
import { providerTokenUsage, usageCollector } from '../server/ai/usage.js';
import { completeResponses } from '../server/ai/compatible-responses.js';
import { getBusinessMetadata } from '../server/business/metadata.js';
import { completeCompatible } from '../server/ai/compatible-chat.js';
import { AgentExecutionBudget, agentBudgetConfig } from '../server/assistant/budget.js';
const who = { ...actor, permissions: ['business:edit', 'import:execute'] };
const call = (name: string, args: any) => ({ name, args });
const reply = (...calls: any[]) => ({ message: '继续处理业务目标', toolCalls: calls });
const decisions =
  '两张交期都是2026-10-29；税率为13%，但不能据此擅自推断单价是否含税；第二张数量按明细合计1092；第一张保留原有个/张单位，不进行未经确认的换算；两张订单属于同一个客户；新产品允许建档。';
async function manual(f: ReturnType<typeof createOrderWorkflowFixture>, second = false) {
  let w = (
    await f.imports.upload(
      second ? xlsxFixture() : imageFixture(),
      second ? '虚构第二张.xlsx' : '虚构第一张.png',
      true,
    )
  ).workspace;
  const p = f.settings.view().active!;
  w = f.imports.consent(w.id, {
    expectedRevision: w.revision,
    accepted: true,
    presetId: p.id,
    endpoint: p.endpoint,
    model: p.model,
    apiStyle: p.apiStyle,
  });
  w = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, who);
  const operations: any[] = [
    {
      op: 'set-header',
      field: 'purchaseOrderNumber',
      value: second ? 'AUTONOMY-B' : 'AUTONOMY-A',
      reason: '虚构业务原件',
    },
    {
      op: 'set-header',
      field: 'statedTotalQuantity',
      value: second ? '1092' : '200',
      reason: '虚构原件',
    },
    {
      op: 'set-header',
      field: 'statedTotalAmount',
      value: second ? '1365.00' : '246.90',
      reason: '虚构原件',
    },
  ];
  w.draft!.lines.forEach((line, i) => {
    for (const [field, value] of Object.entries({
      length: i ? '200' : '300',
      width: '150',
      height: '100',
      dimensionUnit: 'mm',
      material: '虚构五层纸板',
      flute: 'BC',
      productCode: 'FICTION-NEW-' + i,
      unit: second ? '个' : i ? '张' : '个',
      quantity: second ? (i ? '492' : '600') : '100',
      unitPrice: second ? '1.25' : '1.2345',
      statedAmount: second ? (i ? '615.00' : '750.00') : '123.45',
    }))
      operations.push({
        op: 'set-line',
        lineId: line.id,
        field,
        value,
        reason: '虚构原件，保留单位',
      });
  });
  w = f.imports.edit(w.id, { expectedRevision: w.revision, operations }, 'manual', who);
  w = f.imports.mapping(
    w.id,
    {
      expectedRevision: w.revision,
      mapping: {
        customer: {
          mode: 'existing',
          id: f.store.customers()[0].id,
          version: f.store.customers()[0].version,
        },
        products: Object.fromEntries(w.draft!.lines.map((l) => [l.id, { mode: 'new' }])),
        roundingPolicy: 'exact-cents',
      },
    },
    who,
  );
  return w;
}

test('确认记忆区分税率/含税、文件顺序、单位和授权，模型与附件内容不能伪造已确认事实', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    await f.manager.chat(
      t.id,
      f.input(decisions, randomUUID()),
      actor,
      'session',
      () => {},
      () => actor,
    );
    let memory = f.manager.tasks.get(t.id, actor)!.memory!;
    assert.equal(confirmedValue(memory, 'deliveryDate', 1), '2026-10-29');
    assert.equal(confirmedValue(memory, 'taxRate', 2), '13');
    assert.equal(confirmedValue(memory, 'taxMode', 1), undefined);
    assert.equal(confirmedValue(memory, 'quantityTotal', 2), '1092');
    assert.equal(confirmedValue(memory, 'unitPolicy', 1), 'preserve-original');
    assert.equal(confirmedValue(memory, 'sameCustomer'), true);
    assert.equal(confirmedValue(memory, 'createProducts'), true);
    const source = memory.turns[0];
    f.manager.tasks.rememberModel(t.id, actor, {
      decisions: [
        {
          key: 'taxMode',
          scope: 'all',
          value: '含税',
          status: 'confirmed',
          quote: source.text,
          messageId: source.id,
        },
      ],
    });
    assert.equal(confirmedValue(f.manager.tasks.get(t.id, actor)!.memory, 'taxMode'), undefined);
    for (let i = 0; i < 14; i++)
      await f.manager.chat(
        t.id,
        f.input('补充普通说明' + i, randomUUID()),
        actor,
        'session',
        () => {},
        () => actor,
      );
    // 模拟升级前未建memory的同一旧任务，恢复仅从该任务期间真实用户消息提取。
    f.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_remove(document,'$.businessTask.memory') WHERE id=?",
      )
      .run(t.id);
    const restarted = new AssistantManager(f.store, f.settings, f.prompts);
    try {
      await restarted.chat(
        t.id,
        f.input('继续', randomUUID()),
        actor,
        'session',
        () => {},
        () => actor,
      );
      memory = restarted.tasks.get(t.id, actor)!.memory!;
      assert.equal(confirmedValue(memory, 'deliveryDate', 2), '2026-10-29');
      assert.match(JSON.stringify(f.requests.at(-1).body), /2026-10-29/);
      restarted.tasks.rememberInput(t.id, actor, randomUUID(), '两张交期都是2026-10-30');
      assert.equal(
        confirmedValue(restarted.tasks.get(t.id, actor)!.memory, 'deliveryDate'),
        undefined,
      );
      assert(
        restarted.tasks
          .get(t.id, actor)!
          .memory!.decisions.some((d) => d.key === 'deliveryDate' && d.status === 'conflict'),
      );
      restarted.tasks.rememberInput(t.id, actor, randomUUID(), '两张交期改为2026-10-31');
      assert.equal(
        confirmedValue(restarted.tasks.get(t.id, actor)!.memory, 'deliveryDate'),
        '2026-10-31',
      );
      restarted.tasks.begin(t.id, actor, '独立新任务', true);
      assert.equal(restarted.tasks.get(t.id, actor)!.memory, undefined);
    } finally {
      restarted.registry.close();
    }
  } finally {
    f.close();
  }
});

test('两张订单：集中问题、已确认不再问、无关字段版本冲突自主恢复、连续导入及新产品复用、真实回执后结束', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const a = await manual(f),
      b = await manual(f, true);
    f.replies.push(
      reply(
        call('order_import.attach', { workspaceId: a.id }),
        call('order_import.attach', { workspaceId: b.id }),
      ),
      {
        message: '请一次确认交期、税率、单位和新产品处理方式。',
        questions: [
          { key: 'deliveryDate', question: '两张订单交期是哪天？' },
          { key: 'taxRate', question: '税率是多少？' },
          { key: 'unitPolicy', scope: 'order:1', question: '第一张是否保留原单位？' },
          { key: 'createProducts', question: '新产品是否建档？' },
        ],
        toolCalls: [],
      },
    );
    let view = await f.send('请导入这两张客户采购订单');
    assert.equal(f.store.orders().length, 0);
    const tasks = view.orderWorkflow!.tasks;
    const ta = tasks.find((t) => t.workspaceId === a.id)!,
      tb = tasks.find((t) => t.workspaceId === b.id)!;
    let observedA: any, observedB: any;
    f.replies.push(
      {
        message: '交期和税率还需要再确认吗？',
        questions: [
          { key: 'deliveryDate', question: '交期是哪天？' },
          { key: 'taxRate', question: '税率是多少？' },
        ],
        toolCalls: [],
      },
      reply(
        call('order_import.get', { taskId: ta.id }),
        call('order_import.get', { taskId: tb.id }),
      ),
      () => {
        observedA = f.imports.get(a.id);
        observedB = f.imports.get(b.id);
        f.imports.edit(
          a.id,
          {
            expectedRevision: observedA.revision,
            operations: [
              {
                op: 'set-header',
                field: 'notes',
                value: '其他页面的合法备注修改',
                reason: '模拟并发',
              },
            ],
          },
          'manual',
          who,
        );
        const ops = [
          { op: 'set-header', field: 'deliveryDate', value: '2026-10-29', reason: '已确认交期' },
          { op: 'set-header', field: 'taxRate', value: '13', reason: '已确认税率，含税口径仍未知' },
        ];
        return reply(
          call('order_import.edit', {
            taskId: ta.id,
            expectedRevision: observedA.revision,
            operations: ops,
          }),
          call('order_import.edit', {
            taskId: tb.id,
            expectedRevision: observedB.revision,
            operations: ops,
          }),
        );
      },
      { message: '草稿修改好了。', toolCalls: [] },
      reply(call('order_import.execute_many', { workspaceIds: [a.id, b.id] })),
      { message: '两张订单已处理。', toolCalls: [] },
    );
    view = await f.send(decisions);
    assert.equal(f.store.orders().length, 2, view.messages.at(-1)!.text);
    assert.equal(f.store.products().length, 2, '相同完整身份的新产品应只建一份');
    const orders = f.store.orders();
    assert.equal(orders[0].customerId, orders[1].customerId);
    for (const o of orders) {
      assert.equal(o.deliveryDate, '2026-10-29');
      assert.equal(o.taxRate, '13');
      assert.equal(o.taxMode, '未明确');
    }
    const first = orders.find((o) => o.externalPurchaseOrder === 'AUTONOMY-A')!,
      second = orders.find((o) => o.externalPurchaseOrder === 'AUTONOMY-B')!;
    assert.deepEqual(
      first.lines.map((l) => l.unit),
      ['个', '张'],
    );
    assert.equal(
      second.lines.reduce((n, l) => n + l.quantity, 0),
      1092,
    );
    assert.equal(Number(second.totalAmountExact), 1365);
    assert.match(first.notes, /其他页面/);
    assert.equal(view.businessTask!.state, 'completed', JSON.stringify(view.businessTask!.steps));
    assert(!view.messages.at(-1)!.text.includes('交期是哪天'));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n, 2);
    f.replies.push(reply(call('order_import.execute_many', { workspaceIds: [a.id, b.id] })));
    await f.send('继续');
    assert.equal(f.store.orders().length, 2);
    assert.equal(f.store.products().length, 2);
    assert.equal(f.recognitionCalls(), 2);
  } finally {
    f.close();
  }
});

test('相同字段被他人改动不能自动覆盖；税率不能伪造含税或擅改保留单位', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const a = await manual(f);
    f.replies.push(reply(call('order_import.attach', { workspaceId: a.id })));
    await f.send(decisions);
    const taskId = f.manager.view(f.thread.id, who).orderWorkflow!.activeId!;
    const old = f.imports.get(a.id);
    f.imports.edit(
      a.id,
      {
        expectedRevision: old.revision,
        operations: [
          {
            op: 'set-header',
            field: 'deliveryDate',
            value: '2026-11-01',
            reason: '另一个明确业务决定',
          },
        ],
      },
      'manual',
      who,
    );
    f.replies.push(
      reply(
        call('order_import.edit', {
          taskId,
          expectedRevision: old.revision,
          operations: [
            { op: 'set-header', field: 'deliveryDate', value: '2026-10-29', reason: '旧草稿' },
          ],
        }),
      ),
    );
    let v = await f.send('继续');
    assert.equal(f.imports.get(a.id).draft!.header.deliveryDate.value, '2026-11-01');
    assert.match(v.messages.at(-1)!.text, /冲突|修改/);
    f.replies.push(
      reply(
        call('order_import.edit', {
          taskId,
          expectedRevision: f.imports.get(a.id).revision,
          operations: [
            { op: 'set-header', field: 'taxMode', value: '含税', reason: '模型根据13%推断' },
          ],
        }),
      ),
    );
    v = await f.send('继续');
    assert.notEqual(f.imports.get(a.id).draft!.header.taxMode.value, '含税');
    assert.match(v.messages.at(-1)!.text, /税率|含税/);
    f.replies.push(
      reply(
        call('order_import.edit', {
          taskId,
          expectedRevision: f.imports.get(a.id).revision,
          operations: [
            {
              op: 'set-line',
              lineId: f.imports.get(a.id).draft!.lines[0].id,
              field: 'unit',
              value: '只',
              reason: '模型擅自换算',
            },
          ],
        }),
      ),
    );
    await f.send('继续');
    assert.equal(f.imports.get(a.id).draft!.lines[0].fields.unit.value, '个');
    assert.equal(f.store.orders().length, 0);
  } finally {
    f.close();
  }
});

test('任务上下文省略冗余来源但保留决定、字段值及真实ID；累计usage/缓存/推理不混为可见输出', async () => {
  const full: any = {
    workspace: {
      id: 'real-id',
      revision: 9,
      draft: {
        header: {
          taxRate: {
            value: '13',
            quote: '原件'.repeat(1000),
            certainty: 'user-modified',
            sources: [],
          },
        },
      },
    },
    preview: { plan: '重复'.repeat(4000) },
  };
  const compact = modelToolResult(full);
  assert.equal(compact.workspace.draft.header.taxRate.value, '13');
  assert(JSON.stringify(compact).length < JSON.stringify(full).length * 0.1);
  const messages: any[] = Array.from({ length: 12 }, () => ({
    role: 'user',
    content: '服务器工具结果：' + JSON.stringify({ tool: 'order_import.get', result: full }),
  }));
  const before = contextChars(messages);
  compactToolHistory(messages, 2);
  assert(contextChars(messages) < before * 0.25);
  const once = JSON.stringify(messages);
  compactToolHistory(messages, 2);
  assert.equal(JSON.stringify(messages), once, '重复压缩不能丢失此前摘要中的真实ID');
  const stats = providerTokenUsage({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    prompt_cache_hit_tokens: 80,
    completion_tokens_details: { reasoning_tokens: 30 },
  })!;
  const budget = new AgentExecutionBudget(agentBudgetConfig(), randomUUID());
  budget.providerUsage(stats);
  assert.equal(budget.view().providerUsage.totalTokens, 150);
  assert.equal(budget.view().providerUsage.cachedInputTokens, 80);
  assert.equal(budget.view().providerUsage.reasoningTokens, 30);
  let body: any;
  await completeCompatible(
    { endpoint: 'https://api.deepseek.com', model: 'fictional', id: 'fake' } as any,
    'fictional-key',
    [{ role: 'user', content: '虚构' }],
    async (req) => {
      body = req.body;
      req.onSseEvent?.({
        event: 'message',
        data: JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }),
      });
      req.onSseEvent?.({
        event: 'message',
        data: JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80 },
        }),
      });
      return { status: 200, streamed: true, body: null };
    },
    undefined,
    { stream: true },
  );
  assert.equal(body.stream_options.include_usage, true);
});

test('被已核验的新操作替代的失败步骤不再阻塞完成；不同目标和未知结果不能被替代', () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    const scope = { workflowTaskId: randomUUID() },
      lineId = randomUUID();
    const old = f.manager.tasks.stage(
      t.id,
      actor,
      {
        name: 'order_import.edit',
        args: {
          taskId: scope.workflowTaskId,
          expectedRevision: 1,
          operations: [
            { op: 'set-line', lineId, field: 'quantity', value: '1092', reason: '旧参数' },
          ],
        },
      },
      '编辑草稿',
      scope,
      true,
    );
    f.manager.tasks.fail(t.id, actor, old.id, '旧草稿引用');
    const next = f.manager.tasks.stage(
      t.id,
      actor,
      {
        name: 'order_import.edit',
        args: {
          taskId: scope.workflowTaskId,
          expectedRevision: 2,
          operations: [
            { op: 'set-line', lineId, field: 'quantity', value: '1092', reason: '重新核验参数' },
          ],
        },
      },
      '编辑草稿',
      scope,
      true,
    );
    assert.notEqual(next.id, old.id);
    f.manager.tasks.done(t.id, actor, next.id, {
      workspace: {
        id: randomUUID(),
        revision: 3,
        draft: { header: {}, lines: [{ id: lineId, fields: { quantity: { value: '1092' } } }] },
      },
    });
    const done = f.manager.tasks.finish(t.id, actor)!;
    assert.equal(done.steps.find((s) => s.id === old.id)!.state, 'superseded');
    assert.equal(done.steps.find((s) => s.id === old.id)!.supersededBy, next.id);
    assert.equal(done.state, 'completed');
    const unknown = f.manager.tasks.stage(
      t.id,
      actor,
      { name: 'page.act', args: {} },
      '未知提交',
      {},
      true,
    );
    f.manager.tasks.fail(t.id, actor, unknown.id, '未知结果', true);
    f.manager.tasks.supersede(t.id, actor, unknown.id, next.id);
    assert.equal(
      f.manager.tasks.get(t.id, actor)!.steps.find((s) => s.id === unknown.id)!.state,
      'uncertain',
    );
    assert.equal(f.manager.tasks.finish(t.id, actor)!.state, 'paused');
  } finally {
    f.close();
  }
});

test('新问题只询问未知含税口径，不重复已确认税率；预算内无进展续办有上限', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    f.replies.push({
      message: '请确认税率及单价含税口径',
      questions: [
        { key: 'taxRate', question: '税率是多少？' },
        { key: 'taxMode', question: '单价含税还是未税？' },
      ],
      toolCalls: [],
    });
    let v = await f.manager.chat(
      t.id,
      f.input('税率为13%', randomUUID()),
      actor,
      'session',
      () => {},
      () => actor,
    );
    assert.equal(v.messages.at(-1)!.text, '单价含税还是未税？');
    assert.equal(f.calls(), 1);
    f.manager.tasks.plan(
      t.id,
      actor,
      {
        goal: '读取业务信息',
        steps: [{ label: '读取客户', tool: 'records.get' }],
      },
      () => {},
    );
    f.replies.push(
      ...Array.from({ length: 10 }, () => ({ message: '已经完成任务。', toolCalls: [] })),
    );
    v = await f.manager.chat(
      t.id,
      f.input('继续', randomUUID()),
      actor,
      'session',
      () => {},
      () => actor,
    );
    assert.equal(v.businessTask!.state, 'paused');
    assert(v.businessTask!.budget!.used.modelCalls <= f.manager.budgetLimits.noProgress + 2);
    assert(!v.messages.at(-1)!.text.includes('已完成任务'));
    assert.match(v.messages.at(-1)!.text, /未完成事项/);
  } finally {
    f.close();
  }
});

test('页面引用失效会自主重新观察，修正原步骤继续；不会盲目重放提交或留下重复失败步骤', async () => {
  const f = assistantFixture();
  const clientId = randomUUID(),
    t = f.manager.create(actor),
    fresh = randomUUID();
  let observations = 0,
    actions = 0;
  const snapshot = {
    snapshotId: fresh,
    route: '#customers',
    capturedAt: new Date().toISOString(),
    title: '客户',
    text: '',
    selected: [],
    dialogs: [],
    controls: [{ id: 'e1', role: 'input', name: '搜索', disabled: false }],
    tables: [],
    feedback: [],
    truncated: false,
  };
  try {
    f.replies.push(
      reply(
        call('page.act', {
          action: 'fill',
          snapshotId: randomUUID(),
          target: 'e1',
          value: '虚构查询',
        }),
      ),
    );
    const v = await f.manager.chat(
      t.id,
      { ...f.input('查询虚构客户', randomUUID()), pageClientId: clientId },
      actor,
      'session',
      (event, data: any) => {
        if (event !== 'page_command') return;
        const ok = !data.action || ++actions > 1;
        if (!data.action) {
          observations++;
          const step = f.manager.tasks.get(t.id, actor)!.steps[0];
          f.replies.push(
            reply({
              ...call('page.act', {
                action: 'fill',
                snapshotId: fresh,
                target: 'e1',
                value: '虚构查询',
              }),
              stepId: step.id,
            }),
          );
        }
        f.manager.pageBridge.complete(
          {
            commandId: data.commandId,
            clientId,
            threadId: t.id,
            requestId: data.requestId,
            result: {
              ok,
              message: ok ? '操作返回' : '页面已变化，请重新观察后使用新控件引用。',
              ...(ok ? { snapshot } : {}),
            },
          },
          actor,
          'session',
        );
      },
      () => actor,
    );
    assert.equal(observations, 1);
    assert.equal(actions, 2);
    assert.equal(v.businessTask!.steps.length, 1);
    assert.equal(v.businessTask!.steps[0].state, 'completed');
    assert.equal(v.businessTask!.state, 'completed');
    assert.equal(v.businessTask!.budget!.used.toolCalls, 3);
    assert.equal(v.businessTask!.budget!.used.businessWrites, 0);
  } finally {
    f.close();
  }
});

test('usage累计块只报告一次，失败响应仍记录Provider真实用量，缺字段不由估算补成真实值', async () => {
  const reports: any[] = [];
  const collector = usageCollector((u) => reports.push(u));
  collector.capture({ prompt_tokens: 100, completion_tokens: 2 });
  collector.capture({ completion_tokens: 30, prompt_cache_hit_tokens: 70 });
  collector.report();
  collector.report();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].inputTokens, 100);
  assert.equal(reports[0].outputTokens, 30);
  assert.equal(reports[0].totalTokens, undefined);
  await assert.rejects(() =>
    completeResponses(
      { id: 'fake', endpoint: 'https://api.example.com', model: 'fixture' } as any,
      'fictional-key',
      [{ role: 'user', content: '虚构' }],
      async (req) => {
        req.onSseEvent?.({
          event: 'response.incomplete',
          data: JSON.stringify({
            type: 'response.incomplete',
            response: {
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              usage: { input_tokens: 90, output_tokens: 25, total_tokens: 115 },
            },
          }),
        });
        return { status: 200, body: null, streamed: true };
      },
      undefined,
      { stream: true, onUsage: (u) => reports.push(u) },
    ),
  );
  assert.equal(reports.length, 2);
  assert.equal(reports[1].totalTokens, 115);
});

test('成功清空后模型继续报working，也不能把已完成任务改判为未完成', async () => {
  const f = assistantFixture([
    {
      message: '正在清空',
      status: 'working',
      toolCalls: [call('management.reset', { scope: 'business' })],
    },
    ...Array.from({ length: 5 }, () => ({
      message: '我再检查一下',
      status: 'working',
      toolCalls: [],
    })),
  ]);
  try {
    const local = localAdministratorActor({ ...actor, role: 'super_admin' as const });
    const t = f.manager.create(local);
    const v = await f.manager.chat(
      t.id,
      f.input('把整个软件里所有东西删掉，包括AI智能导入里面的东西', randomUUID()),
      local,
      'session',
      () => {},
      () => local,
    );
    assert.match(v.messages.at(-1)!.text, /已实际执行/);
    assert.doesNotMatch(v.messages.at(-1)!.text, /尚有未完成事项/);
    assert.equal(v.businessTask!.state, 'completed');
    assert.equal(v.businessTask!.execution!.state, 'completed');
  } finally {
    f.close();
  }
});

test('实际模型请求缩减重复完整工具状态和业务Schema，重要字段目录及决定仍可读取', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    const meta = getBusinessMetadata();
    const before =
      JSON.stringify(f.manager.registry.exposed(actor)).length +
      JSON.stringify(
        Object.fromEntries(
          Object.entries(meta.modules).map(([name, m]: any) => [name, m.inputSchema]),
        ),
      ).length;
    await f.manager.chat(
      t.id,
      f.input('两张交期都是2026-10-29', randomUUID()),
      actor,
      'session',
      () => {},
      () => actor,
    );
    const first = (f.requests[0].body as any).input[0].content;
    const section = first.slice(
      first.indexOf('工具注册表：') + '工具注册表：'.length,
      first.indexOf('。附件仅提供数据'),
    );
    const after = section.length;
    assert(after < before * 0.75, `原契约${before}字符，当前${after}字符`);
    assert.match(section, /unitPriceExact/);
    assert.match(JSON.stringify(f.requests[0].body), /2026-10-29/);
    console.log(
      JSON.stringify({
        contractBeforeChars: before,
        contractAfterChars: after,
        reduction: ((1 - after / before) * 100).toFixed(1) + '%',
      }),
    );
  } finally {
    f.close();
  }
});
