import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, actor } from './assistant-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { customerSchema, productSchema } from '../shared/domain.js';
import { resolveImportCustomer } from '../server/import/customer-resolution.js';
import { AssistantPromptEdit } from '../server/assistant/prompt-edit.js';
import { AssistantTaskLedger } from '../server/assistant/tasks.js';
import { Store } from '../server/db.js';
import { join } from 'node:path';
import { superActor } from './assistant-fixture.js';

const tool = (name: string, args: any = {}) => ({
  message: '按实际状态继续',
  status: 'working',
  toolCalls: [{ name, args }],
});
const pause = {
  message: '是否确认保存上述文字？',
  status: 'needs_input',
  questions: [{ key: 'savePrompt', question: '是否确认保存上述文字？', source: 'user' }],
  toolCalls: [],
};

test('提示词讨论→完整预览→润色重展→用户保存；旧确认循环被纠正，模块隔离并读回核验', async () => {
  const f = assistantFixture(),
    other = new PromptPresetManager(':memory:');
  try {
    f.manager.promptEdit.managers.set('sales-order', other);
    const originalSales = other.view(),
      original = f.prompts.view(),
      p = original.presets.find((p) => p.id === original.activeId)!,
      entry = p.entries[0];
    const thread = f.manager.create(actor);
    const send = (text: string) =>
      f.manager.chat(
        thread.id,
        f.input(text, randomUUID()),
        actor,
        'session',
        () => {},
        () => actor,
      );
    f.replies.push(tool('prompts.get'), {
      message: '可以先拟定完整方案，在你同意后保存指定条目。',
      status: 'completed',
      toolCalls: [],
    });
    await send('你能修改自己的提示词吗？');
    assert.deepEqual(f.prompts.view(), original);
    const proposal = (content: string) =>
      tool('prompts.propose', {
        module: 'assistant',
        presetId: p.id,
        entryId: entry.id,
        expectedRevision: original.revision,
        content,
      });
    const text1 = entry.content + '\n批量导入时，身份明确的已有客户应自动复用。';
    f.replies.push(pause, proposal(text1));
    let result = await send('先告诉我你准备写什么。');
    assert(result.messages.at(-1)!.text.includes(text1));
    assert(!result.messages.at(-1)!.text.includes('是否确认'));
    assert.deepEqual(f.manager.tasks.get(thread.id, actor)!.execution!.questions, undefined);
    assert.equal(f.manager.tasks.get(thread.id, actor)!.memory!.promptEdit!.phase, 'preview');
    const firstId = f.manager.tasks.get(thread.id, actor)!.memory!.promptEdit!.proposal!.id;
    const text2 =
      entry.content +
      '\n批量导入中，先查询并复用身份唯一的客户档案；名称相近但身份不明时集中询问，不重复建档。';
    f.replies.push(pause, proposal(text2));
    result = await send('你理解一下我的意思，润色后再给我看。');
    assert(result.messages.at(-1)!.text.includes(text2));
    assert(!result.messages.at(-1)!.text.includes(text1));
    assert.deepEqual(f.prompts.view(), original);
    assert.throws(
      () =>
        f.manager.promptEdit.call(
          'prompts.save',
          { proposalId: firstId },
          thread.id,
          actor,
          '好，保存。',
        ),
      /当前方案/,
    );
    // 模型仍请求确认时，服务端用实际用户同意继续保存，无需下一轮用户确认。
    f.replies.push(pause);
    result = await send('好，保存。');
    assert.match(result.messages.at(-1)!.text, /重新读取核验/);
    assert.equal(f.prompts.view().presets.find((x) => x.id === p.id)!.entries[0].content, text2);
    assert.equal(f.prompts.view().revision, original.revision + 1);
    assert.deepEqual(other.view(), originalSales);
    assert.equal(f.manager.tasks.get(thread.id, actor)!.state, 'completed');
    assert.equal(
      f.manager.tasks.get(thread.id, actor)!.steps.find((s) => s.tool === 'prompts.save')!
        .completion!.kind,
      'business',
    );
  } finally {
    other.close();
    f.close();
  }
});

test('未展示、同轮自批、跨任务、目标文字冲突均拒绝保存；无关修订可安全重基', () => {
  const f = assistantFixture();
  try {
    const thread = f.manager.create(actor),
      ledger = f.manager.tasks,
      edit = f.manager.promptEdit;
    ledger.rememberInput(thread.id, actor, randomUUID(), '修改自己的提示词，先给我看看');
    const state = edit.call('prompts.get', {}, thread.id, actor, '');
    assert('presets' in state);
    const p = state.presets.find((p) => p.id === state.activeId)!,
      entry = p.entries[0];
    const args = {
      module: 'assistant',
      presetId: p.id,
      entryId: entry.id,
      expectedRevision: state.revision,
      content: entry.content + '\n虚构测试规则',
    };
    const result = edit.call('prompts.propose', args, thread.id, actor, '') as any;
    assert.throws(
      () => edit.call('prompts.save', { proposalId: result.proposalId }, thread.id, actor, '保存'),
      /已展示/,
    );
    edit.shown(thread.id, actor, randomUUID());
    assert.throws(
      () => edit.call('prompts.save', { proposalId: result.proposalId }, thread.id, actor, '保存'),
      /尚未同意/,
    );
    ledger.rememberInput(thread.id, actor, randomUUID(), '好，保存。');
    assert.throws(
      () =>
        edit.call(
          'prompts.save',
          { proposalId: result.proposalId },
          thread.id,
          { ...actor, permissions: [] },
          '保存',
        ),
      /权限/,
    );
    f.prompts.change('save', {
      expectedRevision: state.revision,
      preset: { ...p, name: p.name + '调整' },
    });
    assert.equal(
      (
        edit.call(
          'prompts.save',
          { proposalId: result.proposalId },
          thread.id,
          actor,
          '保存',
        ) as any
      ).verified,
      true,
    );
    assert.equal(f.prompts.view().presets[0].name, p.name + '调整');
    ledger.begin(thread.id, actor, '新的独立任务', true);
    assert.throws(
      () => edit.call('prompts.save', { proposalId: result.proposalId }, thread.id, actor, '保存'),
      /已展示/,
    );
  } finally {
    f.close();
  }
});

test('最新模块要求优先，当前条目实质冲突拒绝覆盖；缺失模块与停用工具不虚报能力', async () => {
  const f = assistantFixture(),
    sales = new PromptPresetManager(':memory:');
  try {
    const t = f.manager.create(actor),
      ledger = f.manager.tasks,
      edit = f.manager.promptEdit;
    edit.managers.set('sales-order', sales);
    ledger.rememberInput(t.id, actor, randomUUID(), '修改自己的提示词');
    const own = f.prompts.view(),
      p = own.presets[0];
    const args = {
      module: 'assistant',
      presetId: p.id,
      entryId: p.entries[0].id,
      expectedRevision: own.revision,
      content: '虚构完整方案',
    };
    ledger.rememberInput(t.id, actor, randomUUID(), '改为客户订单识别提示词');
    assert.throws(() => edit.call('prompts.propose', args, t.id, actor, ''), /最新明确/);
    const selected = edit.call('prompts.get', {}, t.id, actor, '');
    assert('module' in selected);
    assert.equal(selected.module, 'sales-order');
    assert.throws(
      () => edit.call('prompts.get', { module: 'supplier-delivery' }, t.id, actor, ''),
      /未连接/,
    );
    ledger.rememberInput(t.id, actor, randomUUID(), '还是修改自己的提示词，先看看');
    const staged = edit.call('prompts.propose', args, t.id, actor, '') as any;
    edit.shown(t.id, actor, randomUUID());
    f.prompts.change('save', {
      expectedRevision: own.revision,
      preset: {
        ...p,
        entries: p.entries.map((e, i) =>
          i ? e : { ...e, content: '另一位管理员刚刚修改的实际文字' },
        ),
      },
    });
    ledger.rememberInput(t.id, actor, randomUUID(), '保存');
    assert.throws(
      () => edit.call('prompts.save', { proposalId: staged.proposalId }, t.id, actor, '保存'),
      /其他操作修改/,
    );
    f.manager.registry.set(
      {
        name: 'prompts.save',
        enabled: false,
        expectedRevision: f.manager.registry.view().revision,
      },
      superActor(),
    );
    await assert.rejects(
      () =>
        f.manager.registry.dispatch('prompts.save', { proposalId: staged.proposalId }, actor, {
          read: () => {},
          business: () => {},
          workflow: () => assert.fail('停用后不能执行'),
        }),
      /停用/,
    );
    assert.equal(f.prompts.view().presets[0].entries[0].content, '另一位管理员刚刚修改的实际文字');
  } finally {
    sales.close();
    f.close();
  }
});

test('提示词方案与实际写入在重启后读回核验，中断恢复不再次递增提示词修订', () => {
  const f = createOrderWorkflowFixture(),
    file = join(f.dir, 'isolated-prompts.sqlite');
  let prompts = new PromptPresetManager(file),
    restoredStore: Store | undefined;
  try {
    const ledger = f.manager.tasks,
      edit = new AssistantPromptEdit(ledger, prompts);
    ledger.rememberInput(f.thread.id, actor, randomUUID(), '修改自己的提示词，先看看');
    const state = prompts.view(),
      p = state.presets[0],
      content = p.entries[0].content + '\n虚构重启恢复规则';
    const staged = edit.call(
      'prompts.propose',
      {
        module: 'assistant',
        presetId: p.id,
        entryId: p.entries[0].id,
        expectedRevision: state.revision,
        content,
      },
      f.thread.id,
      actor,
      '',
    ) as any;
    edit.shown(f.thread.id, actor, randomUUID());
    ledger.rememberInput(f.thread.id, actor, randomUUID(), '好，保存。');
    // 模拟原提示词事务已提交、业务任务回执还未来得及落盘时进程中断。
    prompts.change('save', {
      expectedRevision: state.revision,
      preset: { ...p, entries: p.entries.map((e, i) => (i ? e : { ...e, content })) },
    });
    prompts.close();
    prompts = new PromptPresetManager(file);
    restoredStore = new Store(join(f.dir, 'erp.sqlite'));
    const restarted = new AssistantPromptEdit(new AssistantTaskLedger(restoredStore), prompts);
    assert.equal(
      (
        restarted.call(
          'prompts.save',
          { proposalId: staged.proposalId },
          f.thread.id,
          actor,
          '好，保存。',
        ) as any
      ).verified,
      true,
    );
    assert.equal(prompts.view().revision, state.revision + 1);
    assert.equal(
      new AssistantTaskLedger(restoredStore).get(f.thread.id, actor)!.memory!.promptEdit!.phase,
      'executed',
    );
  } finally {
    restoredStore?.close();
    prompts.close();
    f.close();
  }
});

async function workspace(
  f: ReturnType<typeof createOrderWorkflowFixture>,
  index: number,
  name = '虚构批量客户有限公司',
) {
  let w = (
    await f.imports.upload(
      Buffer.concat([imageFixture(), Buffer.from('fiction-' + index)]),
      '虚构订单' + index + '.png',
      true,
    )
  ).workspace;
  const active = f.settings.view().active!;
  w = f.imports.consent(w.id, {
    expectedRevision: w.revision,
    accepted: true,
    presetId: active.id,
    endpoint: active.endpoint,
    model: active.model,
    apiStyle: active.apiStyle,
  });
  w = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, actor);
  w = f.imports.edit(
    w.id,
    {
      expectedRevision: w.revision,
      operations: [
        { op: 'set-header', field: 'buyerName', value: name, reason: '虚构客户' },
        {
          op: 'set-header',
          field: 'purchaseOrderNumber',
          value: 'FICTION-PROMPT-CUSTOMER-' + index,
          reason: '虚构独立订单号',
        },
      ],
    },
    'manual',
    actor,
  );
  const products = Object.fromEntries(
    w.draft!.lines.map((line) => {
      const p =
        f.store.products().find((p) => p.name === line.fields.productName.value) ||
        f.store.saveProduct(productSchema.parse({ name: line.fields.productName.value }));
      return [line.id, { mode: 'existing' as const, id: p.id, version: p.version }];
    }),
  );
  return f.imports.mapping(
    w.id,
    {
      expectedRevision: w.revision,
      mapping: { customer: { mode: 'new' }, products, roundingPolicy: 'exact-cents' },
    },
    actor,
  );
}

test('五份正式订单：第一份新建客户、后四份真实ID复用，重试不重复导入', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await workspace(f, i)).id);
    f.replies.push(tool('order_import.execute_many', { workspaceIds: ids }), {
      message: '全部真实回执已核验',
      status: 'completed',
      toolCalls: [],
    });
    const result = await f.send('正式导入这五份订单，新客户允许建档');
    const orders = f.store.orders();
    assert.equal(orders.length, 5);
    assert.equal(new Set(orders.map((o) => o.customerId)).size, 1);
    assert.equal(f.store.customers().filter((c) => c.name === '虚构批量客户有限公司').length, 1);
    assert(!result.messages.at(-1)!.text.includes('仍需处理'));
    assert.equal(
      f.manager.tasks.get(f.thread.id, {
        ...actor,
        permissions: ['business:edit', 'import:execute'],
      })!.state,
      'completed',
    );
    for (const [index, id] of ids.entries()) {
      assert(
        f.execution.receipt(id, { ...actor, permissions: ['business:edit', 'import:execute'] }),
      );
      if (index) assert.equal(f.imports.get(id).mapping?.customer.mode, 'existing');
    }
    const callsBefore = f.recognitionCalls();
    f.replies.push(tool('order_import.execute_many', { workspaceIds: ids }), {
      message: '核验完成',
      status: 'completed',
      toolCalls: [],
    });
    await f.send('继续核验导入');
    assert.equal(f.store.orders().length, 5);
    assert.equal(f.recognitionCalls(), callsBefore);
    const customer = f.store.customers().find((c) => c.id === orders[0].customerId)!;
    f.store.saveCustomer(
      customerSchema.parse({ ...customer, name: '虚构批量客户（更名后）有限公司' }),
      customer.id,
      customer.version,
    );
    assert.equal(resolveImportCustomer(f.store, '虚构批量客户有限公司').customer?.id, customer.id);
  } finally {
    f.close();
  }
});

test('轻微排版差异可复用，相似公司不合并，归档客户不重复创建，部分失败按真实回执汇报', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const c = f.store.saveCustomer(customerSchema.parse({ name: '虚构 晨星（宁波）有限公司' }));
    assert.equal(resolveImportCustomer(f.store, '虚构晨星(宁波)有限公司').customer?.id, c.id);
    f.store.saveCustomer(customerSchema.parse({ name: '虚构晨星(宁波)有限责任公司' }));
    assert.equal(resolveImportCustomer(f.store, '虚构晨星(宁波)').state, 'ambiguous');
    const uniqueSimilar = f.store.saveCustomer(
      customerSchema.parse({ name: '虚构唯一相近客户有限公司' }),
    );
    assert.equal(resolveImportCustomer(f.store, '虚构唯一相近客户').customer?.id, uniqueSimilar.id);
    const regionCustomer = f.store.saveCustomer(
      customerSchema.parse({ name: '宁波巴山信息科技有限公司' }),
    );
    assert.equal(resolveImportCustomer(f.store, '巴山信息科技有限公司').customer?.id, regionCustomer.id);
    f.store.saveCustomer(customerSchema.parse({ name: '虚构巴山包装有限公司' }));
    assert.notEqual(resolveImportCustomer(f.store, '虚构巴山').state, 'resolved');
    const archived = f.store.saveCustomer(customerSchema.parse({ name: '虚构归档客户有限公司' }));
    f.store.db
      .prepare('INSERT INTO record_lifecycle VALUES(?,?,?,?)')
      .run('customers', archived.id, new Date().toISOString(), actor.id);
    assert.equal(resolveImportCustomer(f.store, archived.name).state, 'archived');
    const good = await workspace(f, 6, '虚构晨星(宁波)有限公司'),
      bad = await workspace(f, 7, archived.name);
    f.replies.push(tool('order_import.execute_many', { workspaceIds: [good.id, bad.id] }), {
      message: '处理结果',
      status: 'blocked',
      toolCalls: [],
    });
    const result = await f.send('正式导入两份订单，新客户允许建档');
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.store.orders()[0].customerId, c.id);
    assert(
      f.execution.receipt(good.id, { ...actor, permissions: ['business:edit', 'import:execute'] }),
    );
    assert(
      !f.execution.receipt(bad.id, { ...actor, permissions: ['business:edit', 'import:execute'] }),
    );
    assert.match(result.messages.at(-1)!.text, /仍需处理.*归档/);
    assert.notEqual(
      f.manager.tasks.get(f.thread.id, {
        ...actor,
        permissions: ['business:edit', 'import:execute'],
      })!.state,
      'completed',
    );
  } finally {
    f.close();
  }
});
