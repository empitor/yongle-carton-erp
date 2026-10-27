import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { AssistantManager, assistantDefaultPreset } from '../server/assistant/manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { makeSettings, actor, superActor, secret } from './assistant-fixture.js';
import { developerActor } from '../server/developer-capability.js';
import { AiConnectionError } from '../server/ai/connection-error.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { createBusinessService } from '../server/business/service.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { completeCompatible } from '../server/ai/compatible-chat.js';
import { completeResponses } from '../server/ai/compatible-responses.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { normalizeAssistantReply } from '../server/assistant/reply.js';
const call = (name: string, args: any = {}) => ({
  message: '执行当前业务步骤',
  toolCalls: [{ name, args }],
});
const create = (name: string) =>
  call('records.propose_save', { module: 'customers', patch: { name } });
function fixture(who: any = actor) {
  const store = new Store(':memory:'),
    queue: any[] = [],
    requests: any[] = [];
  const settings = makeSettings(async (req) => {
    requests.push(req);
    let next = queue.shift() ?? { message: '请按服务器结果核对。', toolCalls: [] };
    if (typeof next === 'function') next = await next(req);
    if (next instanceof Error) throw next;
    const text = typeof next?.raw === 'string' ? next.raw : JSON.stringify(next),
      response = {
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      };
    if ((req.body as any).stream) {
      req.onSseEvent?.({
        event: 'response.output_text.delta',
        data: JSON.stringify({ type: 'response.output_text.delta', delta: text }),
      });
      req.onSseEvent?.({
        event: 'response.completed',
        data: JSON.stringify({ type: 'response.completed', response }),
      });
      return { status: 200, body: null, streamed: true };
    }
    return { status: 200, body: response };
  });
  const prompts = new PromptPresetManager(':memory:', assistantDefaultPreset);
  let manager = new AssistantManager(store, settings, prompts);
  const thread = manager.create(who);
  const send = (text: string, requestId = randomUUID(), extra: any = {}) =>
    manager.chat(
      thread.id,
      { text, requestId, profile: settings.view().active, ...extra },
      who,
      'session',
      () => {},
      () => who,
    );
  return {
    store,
    settings,
    prompts,
    queue,
    requests,
    thread,
    send,
    get manager() {
      return manager;
    },
    view: () => manager.view(thread.id, who),
    reopen() {
      manager.registry.close();
      manager = new AssistantManager(store, settings, prompts);
    },
    close() {
      manager.registry.close();
      prompts.close();
      settings.close();
      store.close();
    },
  };
}

test('自定义信封不能夹带原生工具调用，保留正常说明而不执行任何工具', () => {
  const reply = normalizeAssistantReply({
    message: '这里是正常解释',
    toolCalls: [
      { name: 'records.propose_save', args: { module: 'customers', patch: { name: '不得执行' } } },
    ],
    tool_calls: [{ function: { name: 'records.propose_save', arguments: '{}' } }],
  });
  assert.equal(reply.message, '这里是正常解释');
  assert.equal(reply.toolCalls.length, 0);
  assert.equal(reply.rejected.length, 1);
});

test('成功缓存仍受实时工具启停控制，不能借恢复任务绕过停用', async () => {
  const f = fixture();
  try {
    f.queue.push(create('虚构停用核验'));
    await f.send('创建虚构停用核验');
    f.manager.registry.set(
      {
        name: 'records.propose_save',
        enabled: false,
        expectedRevision: f.manager.registry.view().revision,
      },
      superActor(),
    );
    f.queue.push(create('虚构停用核验'));
    await f.send('继续');
    assert.equal(f.store.customers().length, 1);
    assert.match(f.view().messages.at(-1)!.text, /停用/);
  } finally {
    f.close();
  }
});

test('恢复任务和协议诊断HTTP按真实账号隔离，切换需CSRF且刷新保留任务', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, { auth, assistant: f.manager, aiSettings: f.settings }).listen(
      0,
      '127.0.0.1',
    );
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构恢复HTTP', password: 'fictional-recovery-http-123' }),
    });
    const owner = (await setup.json()).actor,
      headers = {
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
        Cookie: setup.headers.get('set-cookie')!.split(';')[0],
      };
    const thread = f.manager.create(owner),
      old = f.manager.tasks.begin(thread.id, owner, '虚构旧任务');
    f.manager.tasks.begin(thread.id, owner, '虚构新任务', true);
    f.store.db
      .prepare(
        'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at)VALUES(?,?,?,?,?,?)',
      )
      .run(
        owner.id,
        thread.id,
        'provider.diagnostic',
        'completed',
        JSON.stringify({
          protocol: 'custom-json-envelope-v1',
          stage: 'complete',
          response: { finishReasons: ['stop'] },
        }),
        new Date().toISOString(),
      );
    const endpoint = base + '/api/assistant/diagnostics?threadId=' + thread.id;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal(
      (await fetch(base + '/api/assistant/diagnostics?threadId=' + f.thread.id, { headers }))
        .status,
      404,
    );
    const diagnostic = await fetch(endpoint, { headers }).then((r) => r.json());
    assert.equal(diagnostic.events.length, 1);
    assert(!JSON.stringify(diagnostic).includes(secret));
    const url = base + '/api/assistant/threads/' + thread.id + '/tasks/activate',
      body = JSON.stringify({ taskId: old.id });
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { ...headers, 'X-ERP-Auth-Token': '' }, body }))
        .status,
      403,
    );
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200);
    const refreshed = await fetch(base + '/api/assistant/threads/' + thread.id, { headers }).then(
      (r) => r.json(),
    );
    assert.equal(refreshed.businessTask.id, old.id);
    assert.equal(refreshed.businessTask.state, 'paused');
    assert.equal(refreshed.businessTaskHistory.length, 1);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            taskId: f.manager.tasks.begin(f.thread.id, actor, '其他账号').id,
          }),
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});
test('复杂任务达到6轮上限保留剩余步骤；不同继续指令、重复继续与请求重放均不重复创建', async () => {
  const f = fixture();
  try {
    f.queue.push(
      call('task.plan', {
        goal: '创建两家虚构客户并核对',
        steps: [
          {
            label: '创建虚构A',
            tool: 'records.propose_save',
            args: { module: 'customers', patch: { name: '虚构恢复A' } },
          },
          {
            label: '创建虚构B',
            tool: 'records.propose_save',
            args: { module: 'customers', patch: { name: '虚构恢复B' } },
          },
        ],
      }),
      create('虚构恢复A'),
      ...Array.from({ length: 4 }, () => call('records.search', { module: 'customers' })),
    );
    const first = await f.send('创建两家虚构客户并核对');
    assert.equal(f.requests.length, 6);
    assert.equal(f.store.customers().length, 1);
    assert.equal(first.businessTask!.state, 'paused');
    assert(first.businessTask!.steps.some((s) => s.label === '创建虚构B' && s.state === 'planned'));
    const id = first.businessTask!.id;
    f.queue.push(create('虚构恢复A'), create('虚构恢复B'), {
      message: '已完成当前步骤',
      toolCalls: [],
    });
    const second = await f.send('接着完成');
    assert.equal(second.businessTask!.id, id);
    assert.equal(second.businessTask!.state, 'completed');
    assert.equal(f.store.customers().length, 2);
    assert(second.businessTask!.steps.some((s) => s.verification?.receiptVerified));
    f.queue.push(create('虚构恢复A'), create('虚构恢复B'));
    const requestId = randomUUID();
    await f.send('把剩下的做完', requestId);
    const count = f.requests.length;
    await f.send('把剩下的做完', requestId);
    assert.equal(f.requests.length, count);
    assert.equal(f.store.customers().length, 2);
  } finally {
    f.close();
  }
});
for (const mode of ['illegal-json', 'network', 'dsml'] as const)
  test('写入后' + mode + '中断，刷新及服务管理器重开后核验成功步骤再继续', async () => {
    const f = fixture();
    try {
      f.queue.push(
        call('task.plan', {
          goal: '虚构恢复流程',
          steps: [
            {
              label: '建立甲',
              tool: 'records.propose_save',
              args: { module: 'customers', patch: { name: '虚构中断甲' } },
            },
            {
              label: '建立乙',
              tool: 'records.propose_save',
              args: { module: 'customers', patch: { name: '虚构中断乙' } },
            },
          ],
        }),
        create('虚构中断甲'),
        mode === 'network'
          ? new AiConnectionError('network', '虚构网络中断', 502)
          : {
              raw:
                mode === 'dsml'
                  ? '<|DSML|tool_calls><|DSML|invoke name="records.propose_save">敏感原文</invoke>'
                  : '{"message":"未闭合',
            },
      );
      if (mode === 'network') await assert.rejects(() => f.send('执行虚构流程'), /中断/);
      else await f.send('执行虚构流程');
      assert.equal(f.store.customers().length, 1);
      const taskId = f.view().businessTask!.id;
      assert.equal(f.view().businessTask!.state, 'paused');
      f.reopen();
      assert.equal(f.view().businessTask!.id, taskId);
      f.queue.push(create('虚构中断甲'), create('虚构中断乙'));
      await f.send('继续');
      assert.equal(f.store.customers().length, 2);
      assert.equal(f.view().businessTask!.state, 'completed');
      const diagnostics = f.store.db
        .prepare("SELECT document FROM assistant_audit WHERE tool='provider.diagnostic'")
        .all()
        .map((x) => JSON.parse(String(x.document)));
      assert(diagnostics.some((d) => d.stage === 'error'));
      const serialized = JSON.stringify(diagnostics);
      assert(!serialized.includes(secret));
      assert(!serialized.includes('敏感原文'));
      assert(!serialized.includes('虚构中断甲'));
    } finally {
      f.close();
    }
  });
test('成功回执与步骤同事务；中断后核验最新档案而非旧回复，不能访问他人会话任务', async () => {
  const f = fixture();
  try {
    f.queue.push(create('虚构实时核验'), new AiConnectionError('network', '中断', 502));
    await assert.rejects(() => f.send('创建虚构实时核验并继续处理'));
    const row = f.store.customers()[0];
    createBusinessService(f.store).execute(
      {
        entity: 'customers',
        action: 'update',
        id: row.id,
        input: { ...row, notes: '人工后来核对的最新备注' },
      },
      { source: 'manual-ui', operatorId: actor.id },
    );
    f.queue.push(call('task.get'), create('虚构实时核验'));
    await f.send('继续');
    assert.equal(f.store.customers().length, 1);
    const verification = f.view().businessTask!.steps.find((s) => s.previewId)!.verification;
    assert.match(JSON.stringify(verification), /人工后来核对/);
    assert.throws(
      () => f.manager.tasks.get(f.thread.id, { ...actor, id: 'another-user' }),
      /当前账号/,
    );
    assert(
      f.store.db
        .prepare('SELECT COUNT(*) n FROM assistant_previews WHERE result IS NOT NULL')
        .get()!.n === 1,
    );
  } finally {
    f.close();
  }
});
test('库存调整/生产确认在断网、重复继续、管理器重启后均只影响库存一次，关闭开发权限仍拒绝', async () => {
  const who = developerActor(superActor()),
    f = fixture(who),
    ops = new OperationsService(f.store),
    flow = new FlowService(f.store);
  try {
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构恢复产品' })),
      raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, who),
      finished = ops.saveItem(
        { name: '虚构成品', kind: 'finished', unit: '只', productId: product.id },
        who,
      );
    const movement = {
      id: raw.id,
      action: 'adjust',
      quantity: '300',
      date: '2026-10-27',
      notes: '虚构盘点',
    };
    f.queue.push(
      call('inventory.propose_movement', movement),
      new AiConnectionError('network', '库存后断网', 502),
    );
    await assert.rejects(() => f.send('将虚构原料盘点为300张'));
    f.queue.push(call('inventory.propose_movement', movement));
    await f.send('继续');
    assert.equal(ops.repo.balance(raw.id), 300000);
    assert.equal(ops.repo.movements().length, 1);
    const production = flow.save(
      'production',
      {
        date: '2026-10-27',
        productId: product.id,
        finishedStockId: finished.id,
        goodQuantity: '80',
        scrapQuantity: '2',
        operator: '虚构操作者',
        materials: [{ stockId: raw.id, issued: '100', returned: '10' }],
      },
      who,
    );
    f.queue.push(
      call('flow.propose_confirmation', { id: production.id }),
      new AiConnectionError('network', '生产确认后断网', 502),
    );
    await assert.rejects(() => f.send('确认虚构生产登记'));
    assert.equal(flow.get(production.id).status, 'confirmed');
    assert.equal(ops.repo.balance(raw.id), 210000);
    assert.equal(ops.repo.balance(finished.id), 80000);
    const count = ops.repo.movements().length;
    f.reopen();
    for (let i = 0; i < 2; i++) {
      f.queue.push(call('flow.propose_confirmation', { id: production.id }));
      await f.send('继续');
    }
    assert.equal(ops.repo.movements().length, count);
    assert.equal(ops.repo.balance(finished.id), 80000);
    assert.equal(
      f.view().businessTask!.steps.find((s) => s.tool === 'flow.propose_confirmation')?.verification
        ?.current?.record.status,
      'confirmed',
    );
    assert.equal(
      f.view().businessTask!.steps.find((s) => s.tool === 'inventory.propose_movement')
        ?.verification?.current?.record.quantity,
      '210',
    );
    const normal = {
      id: actor.id,
      name: actor.name,
      permissions: actor.permissions,
      role: 'super_admin' as const,
    };
    f.queue.push(call('inventory.propose_movement', { ...movement, quantity: '400' }));
    await f.manager.chat(
      f.thread.id,
      { text: '盘点虚构原料', requestId: randomUUID(), profile: f.settings.view().active },
      normal,
      'session',
      () => {},
      () => normal,
    );
    assert.equal(ops.repo.balance(raw.id), 210000);
    assert.equal(f.view().businessTask!.state, 'paused');
    assert.match(f.view().messages.at(-1)!.text, /模式/);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.close();
  }
});
test('原审核方案等待确认独立于模型生成，人工确认将回执及任务原子标为完成', async () => {
  const f = fixture(superActor()),
    ops = new OperationsService(f.store);
  try {
    const stock = ops.saveItem({ name: '虚构受审原料', kind: 'raw', unit: '张' }, superActor());
    f.queue.push(
      call('inventory.propose_movement', {
        id: stock.id,
        action: 'adjust',
        quantity: '20',
        date: '2026-10-27',
        notes: '虚构库存',
      }),
    );
    let result = await f.send('盘点虚构原料');
    assert.equal(result.businessTask!.state, 'waiting');
    assert.equal(ops.repo.balance(stock.id), 0);
    const preview = result.messages.at(-1)!.plans[0].id;
    f.manager.execute(
      preview,
      { acknowledged: true, secondConfirmation: true },
      superActor(),
      'session',
    );
    result = f.view();
    assert.equal(ops.repo.balance(stock.id), 20000);
    assert.equal(result.businessTask!.state, 'completed');
    f.manager.execute(
      preview,
      { acknowledged: true, secondConfirmation: true },
      superActor(),
      'session',
    );
    assert.equal(ops.repo.movements().length, 1);
  } finally {
    f.close();
  }
});
const profile: any = {
  provider: 'custom',
  endpoint: 'https://api.example.com/v1',
  model: 'fictional-model',
  apiStyle: 'chat-completions',
};
const privateMessages: any = [
  { role: 'system', content: '返回json对象，不执行任何操作' },
  { role: 'user', content: '测试专用隐私正文，不得记录' },
];
test('JSON mode明确不支持才回退；参数校验、限流、网关和DSML均不触发自动重发', async () => {
  const events: any[] = [],
    bodies: any[] = [];
  let n = 0;
  const result = await completeCompatible(
    profile,
    secret,
    privateMessages,
    async (req) => {
      bodies.push(req.body);
      return ++n === 1
        ? {
            status: 400,
            body: { error: { param: 'response_format', message: 'response_format not supported' } },
          }
        : {
            status: 200,
            body: {
              choices: [
                { finish_reason: 'stop', message: { content: '{"message":"ok","toolCalls":[]}' } },
              ],
            },
          };
    },
    undefined,
    { onDiagnostic: (d) => events.push(d) },
  );
  assert.equal((result as any).message, 'ok');
  assert.equal(n, 2);
  assert.equal(bodies[1].response_format, undefined);
  assert(events.some((d) => d.stage === 'json-mode-unsupported'));
  assert.equal(events.at(-1).request.jsonMode, false);
  assert(!JSON.stringify(events).includes('测试专用隐私正文'));
  assert(!JSON.stringify(events).includes(secret));
  for (const status of [400, 429, 524]) {
    let calls = 0;
    await assert.rejects(() =>
      completeCompatible(profile, secret, privateMessages, async () => {
        calls++;
        return {
          status,
          body: { error: { param: 'response_format', message: 'invalid field value' } },
        };
      }),
    );
    assert.equal(calls, 1);
  }
  for (const jsonMode of ['prefer', 'disabled'] as const) {
    const dsml: any[] = [];
    let calls = 0;
    await assert.rejects(
      () =>
        completeCompatible(
          profile,
          secret,
          privateMessages,
          async () => {
            calls++;
            return {
              status: 200,
              body: {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { content: '<|DSML|tool_calls>不可执行</tool_calls>' },
                  },
                ],
              },
            };
          },
          undefined,
          { jsonMode, onDiagnostic: (d) => dsml.push(d) },
        ),
      (e: any) => e.responseNote?.kind === 'protocol',
    );
    assert.equal(calls, 1);
    assert.equal(dsml.at(-1).response.dsml, true);
  }
});
test('Chat与Responses的原生tool calls不混入自定义信封，严格拒绝；诊断不含原始参数', async () => {
  for (const apiStyle of ['chat-completions', 'responses']) {
    const diagnostics: any[] = [],
      fn = apiStyle === 'responses' ? completeResponses : completeCompatible;
    await assert.rejects(() =>
      fn(
        { ...profile, apiStyle },
        secret,
        privateMessages,
        async () => ({
          status: 200,
          body:
            apiStyle === 'responses'
              ? {
                  status: 'completed',
                  output: [
                    { type: 'function_call', name: 'records.propose_save', arguments: '敏感参数' },
                  ],
                }
              : {
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: {
                        content: '{"message":"ok"}',
                        tool_calls: [
                          { function: { name: 'records.propose_save', arguments: '敏感参数' } },
                        ],
                      },
                    },
                  ],
                },
        }),
        undefined,
        { onDiagnostic: (d) => diagnostics.push(d) },
      ),
    );
    assert.equal(diagnostics.at(-1).response.nativeToolCalls, true);
    assert(!JSON.stringify(diagnostics).includes('敏感参数'));
  }
});
test('正式订单导入成功后模型断网，下一轮继续及重复确认均核验原回执，不重复订单/档案', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const who = { ...actor, permissions: ['business:edit', 'import:execute'] },
      attachment = await f.manager.attachments.upload(
        f.thread.id,
        imageFixture(),
        '虚构恢复订单.png',
        randomUUID(),
        who,
      );
    await f.send('帮我识别这张订单', [attachment.id]);
    f.replies.push(call('order_import.execute'), () => {
      throw new AiConnectionError('network', '正式导入后的虚构断网', 502);
    });
    await assert.rejects(() => f.send('确认导入'), /断网/);
    assert.equal(f.store.orders().length, 1);
    const customerCount = f.store.customers().length,
      productCount = f.store.products().length;
    for (const text of ['继续', '接着完成', '确认导入']) {
      f.replies.push(call('order_import.execute'));
      await f.send(text);
      assert.equal(f.store.orders().length, 1);
      assert.equal(f.store.customers().length, customerCount);
      assert.equal(f.store.products().length, productCount);
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n, 1);
    assert.equal(f.manager.view(f.thread.id, who).businessTask!.state, 'completed');
  } finally {
    f.close();
  }
});
test('旧版失败回合可以从真实预览回执恢复，参数增加默认值/不同理由仍不重复创建', async () => {
  const f = fixture();
  try {
    f.queue.push(create('虚构旧版恢复'), new AiConnectionError('network', '旧回合中断', 502));
    await assert.rejects(() => f.send('创建虚构旧版恢复并完成后续核对'));
    f.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_remove(document,'$.businessTask') WHERE id=?",
      )
      .run(f.thread.id);
    f.queue.push(
      call('records.propose_save', {
        module: 'customers',
        patch: { name: '虚构旧版恢复', contact: '', phone: '', address: '', notes: '模型新的说明' },
      }),
    );
    await f.send('继续');
    assert.equal(f.store.customers().length, 1);
    assert(f.view().businessTask?.steps.some((s) => s.verification?.receiptVerified));
  } finally {
    f.close();
  }
});
test('失败参数修正可完成同一步，显式新任务可以再创建；历史任务仍可切换且不重放', async () => {
  const f = fixture();
  try {
    f.queue.push(call('records.propose_save', { module: 'customers', patch: { name: '' } }));
    await f.send('创建测试客户');
    assert.equal(f.store.customers().length, 0);
    f.queue.push(create('虚构修正客户'));
    await f.send('名称改成虚构修正客户继续');
    assert.equal(f.store.customers().length, 1);
    assert.equal(f.view().businessTask!.state, 'completed');
    const old = f.view().businessTask!.id;
    f.queue.push(create('虚构修正客户'));
    await f.send('独立再创建一条测试档案', randomUUID(), { startNewTask: true });
    assert.equal(f.store.customers().length, 2);
    const current = f.view().businessTask!.id;
    assert.notEqual(old, current);
    assert(f.manager.tasks.history(f.thread.id, actor).some((t) => t.id === old));
    f.queue.push(call('task.activate', { taskId: old }), create('虚构修正客户'));
    await f.send('继续此前任务');
    assert.equal(f.store.customers().length, 2);
    assert.equal(f.view().businessTask!.id, old);
  } finally {
    f.close();
  }
});
test('真实SQLite文件关闭重开后保留任务、回执和历史，继续不重放已提交步骤', async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), 'erp-assistant-recover-')),
    file = join(dir, 'erp.sqlite');
  let reopened: Store | undefined, m: AssistantManager | undefined;
  try {
    f.queue.push(create('虚构磁盘恢复甲'), new AiConnectionError('network', '虚构进程断线', 502));
    await assert.rejects(() => f.send('创建磁盘恢复甲乙两个客户'));
    const task = f.view().businessTask!.id;
    await backup(f.store.db, file);
    reopened = new Store(file);
    m = new AssistantManager(reopened, f.settings, f.prompts);
    assert.equal(m.view(f.thread.id, actor).businessTask!.id, task);
    f.queue.push(create('虚构磁盘恢复甲'), create('虚构磁盘恢复乙'));
    await m.chat(
      f.thread.id,
      { requestId: randomUUID(), text: '接着完成', profile: f.settings.view().active },
      actor,
      'session',
      () => {},
      () => actor,
    );
    assert.equal(reopened.customers().length, 2);
    m.registry.close();
    reopened.close();
    reopened = new Store(file);
    m = new AssistantManager(reopened, f.settings, f.prompts);
    f.queue.push(create('虚构磁盘恢复甲'));
    await m.chat(
      f.thread.id,
      { requestId: randomUUID(), text: '继续', profile: f.settings.view().active },
      actor,
      'session',
      () => {},
      () => actor,
    );
    assert.equal(reopened.customers().length, 2);
    assert.equal(m.view(f.thread.id, actor).businessTask!.state, 'completed');
  } finally {
    m?.registry.close();
    reopened?.close();
    f.close();
    assert(dir.startsWith(join(tmpdir(), 'erp-assistant-recover-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
