// 助手关联页面上已经识别、人工核对过的工作区：跨会话读、改、匹配、批量正式导入；有一份过不了时先导能导的；
// 新客户只建一次。不重新识别、不复制、不重复导入。假 DeepSeek、临时目录、虚构数据。
import { sales } from '../../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOrderWorkflowFixture, importOrders, importer as who } from '../support/assistant-workflow-fixture.js';
import { xlsxFixture } from '../support/import-fixtures.js';
import { AssistantOrderWorkflow } from '../../server/assistant/order-workflow.js';
import { resolveImportCustomer } from '../../server/import/customer-resolution.js';
import { customerSchema } from '../../shared/core/domain.js';
import { asList, field } from '../../server/assistant/chat/result-fields.js';
import { count } from '../../server/core/index.js';
import { actor } from '../support/actor-fixture.js';
/** 工作流 call() 交回的结果（各命令不同）按路径取一项 */
const at = (value: unknown, ...path: (string | number)[]) => path.reduce<unknown>((v, k) => (typeof k === 'number' ? (asList(v) ?? [])[k] : field(v, k)), value);

// 测的是导入流程本身（开了自动确认；“不点确认就不落库”见 assistant-boundaries.test.ts）
const fixture = () => createOrderWorkflowFixture(undefined, { agent: { autoConfirm: true } });
const execute = (workspaceIds: string[]) => ({ message: '', toolCalls: [{ name: 'order_import.execute', args: { workspaceIds } }] });
const setUnit = (f: ReturnType<typeof fixture>, id: string, value: string) => {
  const w = f.imports.get(id);
  assert.ok(w.draft, '工作区有识别内容');
  return f.imports.edit(
    id,
    { expectedRevision: w.revision, operations: [{ op: 'set-line', lineId: w.draft.lines[0].id, field: 'unit', value, reason: '虚构核对' }] },
    'manual',
    who,
  );
};

test('两份页面上核对过的：查列表、关联、一张卡片正式导入两份；再说一次不重复；新会话关联读回订单和回执', async () => {
  const f = fixture();
  try {
    const a = await f.reviewedWorkspace({ poNumber: 'FICTION-A' }),
      b = await f.reviewedWorkspace({ poNumber: 'FICTION-B', file: xlsxFixture(), name: '人工乙.xlsx' }),
      before = f.recognitionCalls();
    const shown = f.manager.view(f.thread.id, who).orderWorkflow;
    assert.ok(shown, '会话里有订单导入的状态');
    assert.equal(shown.tasks.length, 0);
    f.replies.push(
      { message: '', toolCalls: [{ name: 'order_import.list', args: {} }] },
      { message: '', toolCalls: [a, b].map((w) => ({ name: 'order_import.attach', args: { workspaceId: w.id } })) },
      execute([a.id, b.id]),
    );
    const v = await f.send('把目前AI智能导入已经识别的两份文件全部导入', [], randomUUID(), who);
    assert.equal(sales(f.store).orders().length, 2, v.messages.at(-1)?.text);
    assert.deepEqual(v.messages.at(-1)?.facts?.executed.map((e) => e.label), ['正式导入 2 份订单']);
    assert.equal(f.imports.status().workspaces.length, 2);
    assert.equal(f.imports.get(a.id).fileHash, a.fileHash);
    f.replies.push(execute([a.id, b.id]));
    await f.send('继续导入这两份', [], randomUUID(), who);
    assert.equal(sales(f.store).orders().length, 2);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM import_executions'), 2);
    assert.equal(f.recognitionCalls(), before);
    const fresh = f.manager.create(who);
    const workflow = new AssistantOrderWorkflow(f.store, f.imports, f.execution, f.manager.attachments);
    const ctx = f.ctx({ threadId: fresh.id });
    const attached = await workflow.call('order_import.attach', { workspaceId: a.id }, ctx);
    const result = await workflow.call('order_import.get', { taskId: at(attached, 'task', 'id') }, ctx);
    assert.equal(at(result, 'executionReceipt', 'orderId'), at(result, 'order', 'id'));
    assert(at(result, 'executionReceipt', 'executionId'));
    assert.equal(at(result, 'executionReceipt', 'sourcePath'), undefined);
    assert.equal(at(result, 'workspace', 'imported', 'orderId'), at(result, 'order', 'id'));
  } finally {
    f.close();
  }
});

test('一批里有过不了的（单位不对、客户已归档）：不出卡片、原因交给模型；先导能导的，改好后再导只导剩下的', async () => {
  const f = fixture();
  try {
    const archived = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构归档客户有限公司' }));
    f.store.db
      .prepare('INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)')
      .run('customers', archived.id, new Date().toISOString(), who.id);
    const a = await f.reviewedWorkspace({ poNumber: 'FICTION-A' }),
      b = await f.reviewedWorkspace({ poNumber: 'FICTION-B', file: xlsxFixture(), name: '人工乙.xlsx' }),
      c = await f.reviewedWorkspace({ poNumber: 'FICTION-C', buyerName: archived.name, newCustomer: true });
    // 没写单位按“只”，不算错；写了别的单位才要人换算
    setUnit(f, b.id, '箱');
    f.replies.push(execute([a.id, b.id]));
    let v = await f.send('导入这两份已识别订单', [], randomUUID(), who);
    assert.equal(sales(f.store).orders().length, 0);
    const refused = v.messages.at(-1);
    assert.ok(refused, '有回复');
    assert.equal(refused.plans?.length, 0);
    assert.equal(refused.facts?.failed.length, 1);
    f.replies.push(execute([a.id, c.id]));
    v = await f.send('导入这两份', [], randomUUID(), who);
    assert.match(v.messages.at(-1)?.facts?.failed[0].message ?? '', /归档/);
    f.replies.push(execute([a.id]));
    await f.send('先导入没问题的那份', [], randomUUID(), who);
    assert.equal(sales(f.store).orders().length, 1);
    const fixed = setUnit(f, b.id, '只');
    assert.ok(b.mapping, '核对过的工作区有匹配');
    f.imports.mapping(b.id, { expectedRevision: fixed.revision, mapping: b.mapping }, who);
    // 改好以后两份一起再导：导入过的那份跳过，只导剩下的；再说一次也不重复
    for (let i = 0; i < 2; i++) {
      f.replies.push(execute([a.id, b.id]));
      v = await f.send('继续剩余导入', [], randomUUID(), who);
    }
    assert.equal(sales(f.store).orders().length, 2, v.messages.at(-1)?.text);
    assert.equal(f.recognitionCalls(), 3);
    const wf = f.manager.orderWorkflow;
    assert.ok(wf, '订单导入接上了');
    await assert.rejects(() => wf.call('order_import.attach', { workspaceId: randomUUID() }, f.ctx()));
    await assert.rejects(() => wf.call('order_import.attach', { workspaceId: a.id }, f.ctx({ check: () => ({ ...who, permissions: [] }) })), /权限/);
    await assert.rejects(() => importOrders(wf, f.ctx({ check: () => actor }), { workspaceIds: [a.id] }), /权限/);
  } finally {
    f.close();
  }
});

test('三份都写新客户：卡片上都写“新建”，确认时只建一次，后两份用刚建的；客户改名后原名还认得', async () => {
  const f = fixture();
  try {
    const name = '虚构批量客户有限公司';
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await f.reviewedWorkspace({ poNumber: 'FICTION-NEW-' + i, buyerName: name, newCustomer: true })).id);
    f.replies.push(execute(ids));
    const result = await f.send('正式导入这三份订单，新客户允许建档', [], randomUUID(), who);
    assert.deepEqual(result.messages.at(-1)?.facts?.executed.map((e) => e.label), ['正式导入 3 份订单']);
    const orders = sales(f.store).orders();
    assert.equal(orders.length, 3);
    assert.equal(new Set(orders.map((o) => o.customerId)).size, 1);
    assert.equal(sales(f.store).customers().filter((c) => c.name === name).length, 1);
    for (const [index, id] of ids.entries()) {
      assert(f.execution.receipt(id, who));
      if (index) assert.equal(f.imports.get(id).mapping?.customer.mode, 'existing');
    }
    const customer = sales(f.store).customer(orders[0].customerId);
    assert.ok(customer, '新建的客户在');
    sales(f.store).updateCustomer(customerSchema.parse({ ...customer, name: '虚构批量客户（更名后）有限公司' }), customer.id, customer.version);
    assert.equal(resolveImportCustomer(f.store, name).customer?.id, customer.id);
  } finally {
    f.close();
  }
});

test('关联页面上核对过的那份：改数量、匹配客户和产品都在原工作区上改，行编号不变、不另外识别', async () => {
  const f = fixture();
  try {
    const original = await f.reviewedWorkspace({ poNumber: 'FICTION-A' });
    const wf = f.manager.orderWorkflow;
    assert.ok(wf, '订单导入接上了');
    const ctx = f.ctx();
    const taskId = at(await wf.call('order_import.attach', { workspaceId: original.id }, ctx), 'task', 'id');
    assert.ok(original.draft, '工作区有识别内容');
    const lineId = original.draft.lines[0].id;
    let result = await wf.call(
      'order_import.edit',
      {
        taskId,
        expectedRevision: original.revision,
        operations: [{ op: 'set-line', lineId, field: 'quantity', value: '150', reason: '用户明确150' }],
      },
      ctx,
    );
    assert.equal(at(result, 'workspace', 'draft', 'lines', 0, 'id'), lineId);
    assert.equal(at(result, 'workspace', 'draft', 'lines', 0, 'fields', 'quantity', 'value'), '150');
    await wf.call('order_import.match', { taskId, customerId: sales(f.store).customers()[0].id }, ctx);
    result = await wf.call('order_import.match', { taskId, line: 1, productId: sales(f.store).products()[0].id }, ctx);
    assert.equal(at(result, 'workspace', 'id'), original.id);
    assert.equal(f.recognitionCalls(), 1);
    assert.equal(f.imports.status().workspaces.length, 1);
    assert.equal(sales(f.store).orders().length, 0);
  } finally {
    f.close();
  }
});
