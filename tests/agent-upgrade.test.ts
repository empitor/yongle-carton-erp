import { AssistantManager } from '../server/assistant/manager.js';
import { verifyPageOutcome } from '../server/assistant/page-verification.js';
import { customerSchema } from '../shared/domain.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { productSchema } from '../shared/domain.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { actor, superActor, assistantFixture } from './assistant-fixture.js';
import { imageFixture, xlsxFixture } from './import-fixtures.js';
import { AssistantPageBridge } from '../server/assistant/page-bridge.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { AssistantOrderWorkflow } from '../server/assistant/order-workflow.js';
import {
  fitFloatingSize,
  resizeFloatingRect,
  readFloatingSize,
} from '../src/floating-assistant.js';
const who = { ...actor, permissions: ['business:edit', 'import:execute'] };
async function manual(f: ReturnType<typeof createOrderWorkflowFixture>, second = false) {
  let w = (
    await f.imports.upload(
      second ? xlsxFixture() : imageFixture(),
      second ? '人工乙.xlsx' : '人工甲.png',
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
  w = f.imports.edit(
    w.id,
    {
      expectedRevision: w.revision,
      operations: [
        {
          op: 'set-header',
          field: 'purchaseOrderNumber',
          value: second ? 'FICTION-B' : 'FICTION-A',
          reason: '虚构人工核对',
        },
      ],
    },
    'manual',
    who,
  );
  const products = Object.fromEntries(
    w.draft!.lines.map((line) => {
      const name = line.fields.productName.value!;
      const p =
        f.store.products().find((p) => p.name === name) ||
        f.store.saveProduct(productSchema.parse({ name }));
      return [line.id, { mode: 'existing' as const, id: p.id, version: p.version }];
    }),
  );
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
        products,
        roundingPolicy: 'exact-cents',
      },
    },
    who,
  );
  return w;
}
test('A：两份人工已识别工作区跨会话关联、读取/编辑/匹配、同轮逐份正式导入；重放不重识别/不复制/不重复订单', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const a = await manual(f),
      b = await manual(f, true),
      before = f.recognitionCalls();
    assert.equal(f.manager.view(f.thread.id, who).orderWorkflow!.tasks.length, 0);
    f.replies.push(
      { message: '查询现有原工作区', toolCalls: [{ name: 'order_import.list', args: {} }] },
      {
        message: '分别关联原草稿',
        toolCalls: [
          { name: 'order_import.attach', args: { workspaceId: a.id } },
          { name: 'order_import.attach', args: { workspaceId: b.id } },
        ],
      },
      {
        message: '提交两份已识别订单',
        toolCalls: [{ name: 'order_import.execute_many', args: { workspaceIds: [a.id, b.id] } }],
      },
    );
    const v = await f.send('把目前AI智能导入已经识别的两份文件全部导入', [], randomUUID(), who);
    assert.equal(f.store.orders().length, 2, v.messages.at(-1)!.text);
    assert.equal(f.recognitionCalls(), before);
    assert.equal(f.imports.status().workspaces.length, 2);
    assert.equal(f.imports.get(a.id).fileHash, a.fileHash);
    assert.equal(f.imports.get(b.id).fileHash, b.fileHash);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n, 2);
    assert(v.messages.at(-1)!.text.includes('人工甲'));
    assert(v.messages.at(-1)!.text.includes('人工乙'));
    f.replies.push({
      message: '核验重试',
      toolCalls: [{ name: 'order_import.execute_many', args: { workspaceIds: [a.id, b.id] } }],
    });
    await f.send('继续导入这两份', [], randomUUID(), who);
    assert.equal(f.store.orders().length, 2);
    assert.equal(f.recognitionCalls(), before);
    const fresh = f.manager.create(who);
    const workflow = new AssistantOrderWorkflow(
      f.store,
      f.imports,
      f.execution,
      f.manager.attachments,
    );
    const ctx = {
      threadId: fresh.id,
      actor: who,
      requestId: randomUUID(),
      text: '查询已导入订单',
      files: [],
      check: () => who,
      signal: new AbortController().signal,
      emit: () => {},
    };
    const attached = await workflow.call('order_import.attach', { workspaceId: a.id }, ctx);
    const result = await workflow.call('order_import.get', { taskId: attached.task.id }, ctx);
    assert(result.order.id);
    assert.equal(result.executionReceipt.orderId, result.order.id);
    assert(result.executionReceipt.executionId);
    assert.equal(result.executionReceipt.sourcePath, undefined);
    assert.equal(result.workspace.imported.orderId, result.order.id);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});
test('A/E：第二份数据错误时准确部分成功，修正后续跑只提交未完成文件；工作区身份/模式/权限校验', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const a = await manual(f),
      b = await manual(f, true);
    f.imports.edit(
      b.id,
      {
        expectedRevision: b.revision,
        operations: [
          {
            op: 'set-line',
            lineId: b.draft!.lines[0].id,
            field: 'unit',
            value: null,
            reason: '虚构缺失',
          },
        ],
      },
      'manual',
      who,
    );
    f.replies.push({
      message: '逐份执行',
      toolCalls: [{ name: 'order_import.execute_many', args: { workspaceIds: [a.id, b.id] } }],
    });
    let v = await f.send('导入这两份已识别订单', [], randomUUID(), who);
    assert.equal(f.store.orders().length, 1);
    const r = v.messages
      .at(-1)!
      .executions.find((e: any) => e.tool === 'order_import.execute_many').result;
    assert.equal(r.completed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.results[0].success, true);
    assert.equal(r.results[1].success, false);
    let w = f.imports.get(b.id);
    f.imports.edit(
      b.id,
      {
        expectedRevision: w.revision,
        operations: [
          {
            op: 'set-line',
            lineId: w.draft!.lines[0].id,
            field: 'unit',
            value: '只',
            reason: '核对修正',
          },
        ],
      },
      'manual',
      who,
    );
    w = f.imports.get(b.id);
    f.imports.mapping(w.id, { expectedRevision: w.revision, mapping: b.mapping! }, who);
    // 原核对版本变化先返回冲突；下一轮使用最新方案续跑。
    for (let i = 0; i < 2; i++) {
      f.replies.push({
        message: '核验并继续',
        toolCalls: [{ name: 'order_import.execute_many', args: { workspaceIds: [a.id, b.id] } }],
      });
      v = await f.send('继续剩余导入', [], randomUUID(), who);
    }
    assert.equal(f.store.orders().length, 2, v.messages.at(-1)!.text);
    assert.equal(f.recognitionCalls(), 2);
    const ctx = {
      threadId: f.thread.id,
      actor: who,
      requestId: randomUUID(),
      text: '读取',
      files: [],
      check: () => who,
      signal: new AbortController().signal,
      emit: () => {},
    };
    await assert.rejects(() =>
      f.manager.orderWorkflow!.call('order_import.attach', { workspaceId: randomUUID() }, ctx),
    );
    await assert.rejects(
      () =>
        f.manager.orderWorkflow!.call(
          'order_import.attach',
          { workspaceId: a.id },
          { ...ctx, check: () => ({ ...who, permissions: [] }) },
        ),
      /权限/,
    );
    await assert.rejects(
      () =>
        f.manager.orderWorkflow!.call(
          'order_import.execute_many',
          { workspaceIds: [a.id] },
          { ...ctx, check: () => actor },
        ),
      /权限/,
    );
  } finally {
    f.close();
  }
});
test('插件注册组合、严格参数和真实权限、持久开关阻断调度，新增执行器不修改manager', async () => {
  const r = new AssistantToolRegistry();
  let count = 0;
  try {
    r.registerPlugin(
      {
        id: 'fixture-plugin',
        name: '虚构插件',
        description: '测试组合',
        version: '1',
        capabilities: ['受控读取'],
      },
      [
        {
          name: 'fixture.read',
          description: '虚构',
          arguments: { n: 1 },
          risk: 'read',
          kind: 'read',
          schema: z.strictObject({ n: z.number().int() }),
          permissions: ['business:edit'],
          execute: (args) => {
            count++;
            return { value: args.n + 1 };
          },
        },
      ],
    );
    const handlers = {
      read: () => {
        throw Error('无需修改旧路由');
      },
      workflow: () => {},
      business: () => {},
    };
    assert.equal(
      ((await r.dispatch('fixture.read', { n: 3 }, actor, handlers)).value as any).value,
      4,
    );
    await assert.rejects(() => r.dispatch('fixture.read', { n: '3' }, actor, handlers));
    await assert.rejects(
      () => r.dispatch('fixture.read', { n: 3 }, { ...actor, permissions: [] }, handlers),
      /权限/,
    );
    r.setPlugin({ id: 'fixture-plugin', enabled: false, expectedRevision: 0 }, superActor());
    await assert.rejects(() => r.dispatch('fixture.read', { n: 3 }, actor, handlers), /停用/);
    assert.equal(count, 1);
    assert.throws(
      () => r.setPlugin({ id: 'erp-page', enabled: false, expectedRevision: 1 }, actor),
      /超级管理员/,
    );
    assert.equal(r.pluginsView().plugins.find((p) => p.id === 'fixture-plugin')!.enabled, false);
  } finally {
    r.close();
  }
});
test('页面桥接绑定真实账号/登录会话/浏览器/请求，读取反馈后才完成；取消后拒绝迟到回执', async () => {
  const bridge = new AssistantPageBridge(),
    clientId = randomUUID(),
    threadId = randomUUID(),
    requestId = randomUUID(),
    controller = new AbortController();
  let command: any;
  const ctx = {
    actor,
    binding: '真实会话',
    clientId,
    threadId,
    requestId,
    check: () => actor,
    signal: controller.signal,
    emit: (_event: string, data: any) => {
      command = data;
    },
  };
  const call = bridge.call('page.observe', {}, ctx);
  const result = {
    ok: true,
    message: '已读取',
    snapshot: {
      snapshotId: randomUUID(),
      route: '#orders',
      capturedAt: new Date().toISOString(),
      title: '客户订单',
      text: '虚构订单',
      selected: [],
      dialogs: [],
      controls: [],
      tables: [],
      feedback: [],
      truncated: false,
    },
  };
  const reply = { commandId: command.commandId, clientId, threadId, requestId, result };
  assert.throws(
    () => bridge.complete(reply, { ...actor, id: '其他账号' }, ctx.binding),
    /真实登录会话/,
  );
  assert.throws(() => bridge.complete(reply, actor, '另一登录会话'), /真实登录会话/);
  assert.throws(
    () => bridge.complete({ ...reply, clientId: randomUUID() }, actor, ctx.binding),
    /真实登录会话/,
  );
  bridge.complete(reply, actor, ctx.binding);
  assert.equal((await call).status, 'observed');
  assert.throws(() => bridge.complete(reply, actor, ctx.binding), /失效/);
  const pending = bridge.call(
    'page.act',
    { action: 'click', snapshotId: randomUUID(), target: 'e1' },
    ctx,
  );
  controller.abort();
  await assert.rejects(() => pending, /中断/);
  await assert.rejects(
    () =>
      bridge.call(
        'page.act',
        { action: 'click', snapshotId: randomUUID(), target: 'e1' },
        {
          ...ctx,
          signal: new AbortController().signal,
          check: () => ({ ...actor, permissions: [] }),
        },
      ),
    /权限/,
  );
});
test('B：页面记录身份进入原业务上下文，服务真实更新交期并发出页面刷新；普通无编辑账号不提升', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const a = await manual(f);
    const ctx = {
      threadId: f.thread.id,
      actor: who,
      requestId: randomUUID(),
      text: '正式导入',
      files: [],
      check: () => who,
      signal: new AbortController().signal,
      emit: () => {},
    };
    await f.manager.orderWorkflow!.call('order_import.attach', { workspaceId: a.id }, ctx);
    const saved = await f.manager.orderWorkflow!.call('order_import.execute', {}, ctx);
    const o = saved.order;
    f.replies.push({
      message: '修改当前订单',
      toolCalls: [
        {
          name: 'records.propose_save',
          args: { module: 'orders', id: o.id, patch: { deliveryDate: '2027-01-02' } },
        },
      ],
    });
    await f.manager.chat(
      f.thread.id,
      {
        text: '把当前订单交期改为2027-01-02',
        requestId: randomUUID(),
        profile: f.settings.view().active,
        context: { page: '#orders', module: 'orders', id: o.id },
      },
      who,
      'session',
      (event, data) => f.events.push({ event, data }),
      () => who,
    );
    assert.equal(f.store.order(o.id)!.deliveryDate, '2027-01-02');
    assert(f.events.some((e) => e.event === 'effect' && e.data.type === 'business'));
  } finally {
    f.close();
  }
});
test('F：单边拉宽/拉高、角落及小屏边界，恢复尺寸限制在当前视区', () => {
  const v = { left: 0, top: 0, width: 1200, height: 900 },
    r = { x: 300, y: 200, width: 440, height: 500 };
  assert.deepEqual(resizeFloatingRect(r, 'e', 100, 200, v), { ...r, width: 540 });
  assert.deepEqual(resizeFloatingRect(r, 's', 100, 100, v), { ...r, height: 600 });
  for (const d of ['n', 's', 'e', 'w', 'nw', 'ne', 'se', 'sw']) {
    const p = resizeFloatingRect(r, d, 9999, 9999, v);
    assert(p.x >= 8 && p.y >= 8 && p.x + p.width <= 1192 && p.y + p.height <= 892);
    assert(p.width >= 300 && p.height >= 260);
  }
  assert.deepEqual(
    readFloatingSize(
      { getItem: () => JSON.stringify({ width: 900, height: 900 }) },
      { left: 0, top: 0, width: 320, height: 400 },
    ),
    { width: 304, height: 384 },
  );
  assert.deepEqual(
    fitFloatingSize({ width: 440, height: 690 }, { left: 0, top: 0, width: 50, height: 60 }),
    { width: 34, height: 44 },
  );
});

test('D/F：真实HTTP插件启停、版本冲突、CSRF、匿名拒绝及账号日志隔离', async () => {
  const f = assistantFixture(),
    auth = new AuthManager(':memory:');
  const server = createApp(f.store, { auth, assistant: f.manager, aiSettings: f.settings }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '插件HTTP虚构账号', password: 'fictional-plugin-password-123' }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const headers = {
      'Content-Type': 'application/json',
      'X-ERP-Auth-Token': auth.csrf,
      Cookie: cookie,
    };
    assert.equal((await fetch(base + '/api/assistant/plugins')).status, 401);
    const state = await (await fetch(base + '/api/assistant/plugins', { headers })).json();
    assert(state.plugins.some((p: any) => p.id === 'erp-page'));
    const body = JSON.stringify({
      id: 'erp-page',
      enabled: false,
      expectedRevision: state.revision,
    });
    assert.equal(
      (
        await fetch(base + '/api/assistant/plugins/settings', {
          method: 'POST',
          headers: { ...headers, 'X-ERP-Auth-Token': 'invalid' },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + '/api/assistant/plugins/settings', { method: 'POST', headers, body }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(base + '/api/assistant/plugins/settings', { method: 'POST', headers, body }))
        .status,
      409,
    );
    const tools = await (await fetch(base + '/api/assistant/tools', { headers })).json();
    assert(tools.tools.filter((t: any) => t.pluginId === 'erp-page').every((t: any) => !t.enabled));
    const malformed = await fetch(base + '/api/assistant/page/results', {
      method: 'POST',
      headers,
      body: JSON.stringify({ commandId: randomUUID() }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});

test('E：页面提交后中断，原服务核验目标字段才能完成步骤，错误目标/他人步骤拒绝且不重放操作', () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      record = f.store.saveCustomer(
        customerSchema.parse({ name: '虚构页面恢复客户', notes: '旧值' }),
      );
    const step = f.manager.tasks.stage(
      t.id,
      actor,
      { name: 'page.act', args: { action: 'submit', target: 'e1', snapshotId: randomUUID() } },
      '保存备注',
      {},
      true,
    );
    f.manager.tasks.update(t.id, actor, step.id, {
      state: 'running',
      attemptedAt: new Date().toISOString(),
      pageOutcome: {
        module: 'customers',
        id: record.id,
        expected: { notes: '目标已保存' },
        beforeVersion: 1,
        beforeValues: { notes: '' },
      },
    });
    f.manager.tasks.verify(t.id, actor, f.manager.tools);
    assert.equal(f.manager.tasks.get(t.id, actor)!.steps[0].state, 'uncertain');
    f.store.saveCustomer(
      customerSchema.parse({ ...record, notes: '目标已保存' }),
      record.id,
      record.version,
    );
    const wrong = verifyPageOutcome(
      { module: 'customers', id: record.id, expected: { notes: '尚未保存' }, stepIds: [step.id] },
      actor,
      t.id,
      f.manager.tools,
      f.manager.tasks,
    );
    assert.equal(wrong.failed, 1);
    assert.throws(
      () =>
        verifyPageOutcome(
          {
            module: 'customers',
            id: record.id,
            expected: { notes: '目标已保存' },
            stepIds: [randomUUID()],
          },
          actor,
          t.id,
          f.manager.tools,
          f.manager.tasks,
        ),
      /当前账号/,
    );
    const result = verifyPageOutcome(
      { module: 'customers', id: record.id, expected: { notes: '目标已保存' }, stepIds: [step.id] },
      actor,
      t.id,
      f.manager.tools,
      f.manager.tasks,
    );
    assert.equal(result.businessVerified, true);
    assert.equal(f.manager.tasks.get(t.id, actor)!.steps[0].state, 'completed');
    assert.equal(f.store.customer(record.id)!.version, record.version + 1);
  } finally {
    f.close();
  }
});

test('已有人工草稿跨会话编辑/客户产品匹配/预览复用原修订和行ID，不额外识别', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const original = await manual(f);
    const ctx = {
      threadId: f.thread.id,
      actor: who,
      requestId: randomUUID(),
      text: '修改第一行数量为150并核对原客户产品',
      files: [],
      check: () => who,
      signal: new AbortController().signal,
      emit: () => {},
    };
    const attached = await f.manager.orderWorkflow!.call(
      'order_import.attach',
      { workspaceId: original.id },
      ctx,
    );
    let result = await f.manager.orderWorkflow!.call(
      'order_import.edit',
      {
        taskId: attached.task.id,
        expectedRevision: original.revision,
        operations: [
          {
            op: 'set-line',
            lineId: original.draft!.lines[0].id,
            field: 'quantity',
            value: '150',
            reason: '用户明确150',
          },
        ],
      },
      ctx,
    );
    assert.equal(result.workspace.draft.lines[0].id, original.draft!.lines[0].id);
    assert.equal(result.workspace.draft.lines[0].fields.quantity.value, '150');
    result = await f.manager.orderWorkflow!.call(
      'order_import.match',
      { taskId: attached.task.id, customerId: f.store.customers()[0].id },
      ctx,
    );
    result = await f.manager.orderWorkflow!.call(
      'order_import.match',
      { taskId: attached.task.id, line: 1, productId: f.store.products()[0].id },
      ctx,
    );
    assert.equal(result.workspace.id, original.id);
    assert.equal(f.recognitionCalls(), 1);
    assert.equal(f.imports.status().workspaces.length, 1);
    assert.equal(f.store.orders().length, 0);
  } finally {
    f.close();
  }
});

test('E：多文件正式导入中途重启，核验原台账后只导入未完成文件，不按未知收费任务阻塞或重复订单', async () => {
  const f = createOrderWorkflowFixture();
  let restarted: AssistantManager | undefined;
  try {
    const a = await manual(f),
      b = await manual(f, true);
    const ctx = {
      threadId: f.thread.id,
      actor: who,
      requestId: randomUUID(),
      text: '导入两份',
      files: [],
      check: () => who,
      signal: new AbortController().signal,
      emit: () => {},
    };
    await f.manager.orderWorkflow!.call('order_import.attach', { workspaceId: a.id }, ctx);
    await f.manager.orderWorkflow!.call('order_import.execute', {}, ctx);
    await f.manager.orderWorkflow!.call('order_import.attach', { workspaceId: b.id }, ctx);
    const step = f.manager.tasks.stage(
      f.thread.id,
      who,
      { name: 'order_import.execute_many', args: { workspaceIds: [a.id, b.id] } },
      '导入两份',
      { workspaceIds: [a.id, b.id] },
      true,
    );
    f.manager.tasks.update(f.thread.id, who, step.id, { state: 'running' });
    restarted = new AssistantManager(f.store, f.settings, f.manager.prompts);
    restarted.connectImports(f.imports, f.execution);
    restarted.tasks.verify(f.thread.id, who, restarted.tools);
    assert.equal(
      restarted.tasks.get(f.thread.id, who)!.steps.find((s) => s.id === step.id)!.state,
      'uncertain',
    );
    f.replies.push({
      message: '核验并继续剩余文件',
      toolCalls: [{ name: 'order_import.execute_many', args: { workspaceIds: [a.id, b.id] } }],
    });
    await restarted.chat(
      f.thread.id,
      { text: '继续完成两份订单导入', requestId: randomUUID(), profile: f.settings.view().active },
      who,
      'session',
      () => {},
      () => who,
    );
    assert.equal(f.store.orders().length, 2);
    assert.equal(f.recognitionCalls(), 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n, 2);
    assert.equal(
      restarted.tasks.get(f.thread.id, who)!.steps.find((s) => s.id === step.id)!.state,
      'completed',
    );
  } finally {
    restarted?.registry.close();
    f.close();
  }
});
