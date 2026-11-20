// 助手的数据管理命令（management.*）：只给本机最高管理员，走和数据管理同一个服务，写入要人在卡片上确认；
// 删除不在数据管理命令里，用 records.delete。读识别工作区的列表只读、不要确认。虚构数据。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localAdministratorActor, isLocalAdministrator } from '../server/core/local-administrator.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { assistantFixture, superActor, actor, flowFixture, readAs } from './assistant-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { fixture } from './maintenance-fixture.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/errors.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { AssistantTools } from '../server/assistant/tools.js';
import type { ToolContext } from '../server/assistant/tools/context.js';

const owner = () => localAdministratorActor(superActor());
const cmd = (module: string, action: string, rows: { id: number; version: number }[] = [], patch: Record<string, unknown> = {}) => ({
  module,
  action,
  patch,
  items: rows.map((r) => ({ id: r.id, version: r.version })),
  requestId: randomUUID(),
  reason: '虚构本机管理验收',
});
const noEffects = { read: () => {}, business: () => {}, workflow: () => {} };

test('助手按本机管理员的权限改订单、更正已入库的完工、删采购单；删除要人在卡片上确认，不用再输密码', async () => {
  // 测试开了自动确认：出了卡片立刻替人点（删除照样只出卡片）
  const a = flowFixture(),
    f = fixture(a.store),
    thread = a.manager.create(f.who),
    effects: unknown[] = [];
  const chat = async (text: string, tool: string, args: Record<string, unknown>) => {
    a.replies.push({ message: '', toolCalls: [{ name: tool, args }] }, { message: '依据服务器结果完成。' });
    await a.manager.chat(thread.id, a.input(text, randomUUID()), f.who, 's', (event, data) => {
      if (event === 'effect') effects.push(data);
    }, () => f.who);
  };
  try {
    await chat('把订单 ' + f.order.number + ' 的数量改成500', 'records.propose_save', {
      module: 'orders',
      id: f.order.id,
      patch: { lines: f.order.lines.map((l) => ({ ...l, quantity: 500 })) },
    });
    assert.equal(f.store.order(f.order.id)?.lines[0].quantity, 500);
    assert.equal(f.store.order(f.order.id)?.totalCents, 50000);
    f.arrival();
    const p = f.production();
    // 已入库的完工单改数量走更正（撤销原单、另出替代单）；records.propose_save 改它会被服务端拒
    await chat('完工登记 ' + p.number + ' 实际850只，请修改', 'production.correct', {
      id: p.id,
      expectedVersion: p.version,
      reason: '实际850只',
      goodQuantity: '850',
    });
    assert.equal(f.ops.repo.balance(f.finished.id), 850000);
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-27',
        status: '待订货',
        lines: [{ name: '虚构待删纸板', length: 1000, width: 800, dimensionUnit: 'mm', unit: '张', quantity: '10', priceBasis: 'quantity' }],
      },
      f.who,
    );
    a.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'purchases', id: purchase.id } }] });
    const input = a.input('删除刚建的采购单' + purchase.number, randomUUID());
    const proposed = await a.manager.chat(thread.id, input, f.who, 's', () => {}, () => f.who);
    const exists = () => new OperationsRepository(f.store).purchases(true).some((x) => x.id === purchase.id);
    assert.ok(exists(), '没确认不删');
    const card = proposed.messages.at(-1)?.plans?.[0];
    assert.ok(card);
    a.manager.execute(card.id, { acknowledged: true, deletionDigest: field(card.args, 'deletionDigest') }, f.who, 's');
    assert.equal(exists(), false);
    // 同一条消息重发（网络重试）：不再出新的动作，库存不变
    await a.manager.chat(thread.id, input, f.who, 's', () => {}, () => f.who);
    assert.equal(f.ops.repo.balance(f.finished.id), 850000);
    assert.ok(f.store.db.prepare('SELECT 1 FROM assistant_previews WHERE result IS NOT NULL').get(), '回执记下了执行结果');
    assert.ok(effects.some((e) => field(e, 'type') === 'business'), '页面收到刷新');
    assert.ok(JSON.stringify(a.requests.at(-1)?.body).includes('management.execute'), '本机管理员的命令目录里有数据管理命令');
  } finally {
    a.close();
  }
});

test('数据管理命令不认模型伪造的本机管理员身份；停用后两头都用不了，失败不写入', async () => {
  const a = assistantFixture(),
    f = fixture(a.store),
    args = cmd('customers', 'create', [], { name: '不可伪造客户' });
  try {
    const fake = { ...superActor(), localAdministrator: true };
    await assert.rejects(() => a.manager.registry.dispatch('management.execute', args, fake, noEffects), /数据管理命令只能在服务器本机做/);
    assert.throws(() => a.manager.tools.prepare('management.execute', args, actor, 's'), /本机最高管理员/);
    a.manager.registry.set({ name: 'management.execute', enabled: false, expectedRevision: 0 }, f.who);
    await assert.rejects(() => a.manager.registry.dispatch('management.execute', args, f.who, noEffects), /停用/);
    assert.equal(f.store.customers().length, 1);
  } finally {
    a.close();
  }
});

test('management.execute 真的写库', async () => {
  const a = flowFixture(),
    f = fixture(a.store),
    thread = a.manager.create(f.who);
  try {
    a.replies.push(
      { toolCalls: [{ name: 'management.execute', args: cmd('orders', 'update', [f.order], { notes: '统一工具实际写入' }) }] },
      { message: '已保存。' },
    );
    const result = await a.manager.chat(thread.id, a.input('把订单 ' + f.order.number + ' 的备注改成统一工具实际写入', randomUUID()), f.who, 's', () => {}, () => f.who);
    assert.equal(f.store.order(f.order.id)?.notes, '统一工具实际写入');
    assert.equal(result.messages.at(-1)?.facts?.executed.length, 1);
  } finally {
    a.close();
  }
});

/** 发给模型的参数结构里 action 能填的值 */
const actionValues = z.object({ properties: z.object({ action: z.object({ enum: z.array(z.string()) }) }) });

test('数据管理命令不收删除：发给模型的参数结构里没有 delete，说明里指向 records.delete', () => {
  const a = assistantFixture();
  try {
    const tool = a.manager.registry.view(owner()).tools.find((t) => t.name === 'management.execute');
    assert.ok(tool);
    assert.deepEqual(actionValues.parse(tool.parameters).properties.action.enum, ['create', 'update', 'archive', 'restore', 'confirm', 'cancel', 'reverse']);
    assert.match(tool.description, /删除用 records\.delete/);
  } finally {
    a.close();
  }
});

test('助手复制 AI 工作区走统一服务：不重新识别、不计费，同一条消息重发不重复复制', async () => {
  const f = createOrderWorkflowFixture(undefined, { agent: { autoConfirm: true } }),
    who = owner(),
    thread = f.manager.create(who);
  try {
    const w = (await f.imports.upload(imageFixture(), '虚构管理工具.png', true)).workspace;
    f.replies.push(
      { toolCalls: [{ name: 'management.workspaces', args: { action: 'fork', requestId: randomUUID(), items: [{ id: w.id }] } }] },
      { message: '已按实际结果复制。' },
    );
    const input = { text: '将虚构管理工具这个工作区复制为独立任务', requestId: randomUUID() };
    await f.manager.chat(thread.id, input, who, 's', () => {}, () => who);
    assert.equal(f.imports.status().workspaces.length, 2);
    assert.equal(f.recognitionCalls(), 0);
    await f.manager.chat(thread.id, input, who, 's', () => {}, () => who);
    assert.equal(f.imports.status().workspaces.length, 2);
  } finally {
    f.close();
  }
});

test('management.workspaces 的 list（可以带请求号）给模型的每份识别工作区带写好的状态叫法，不带 hasDraft 字段，不写业务数据', async () => {
  const f = createOrderWorkflowFixture();
  try {
    await f.imports.upload(imageFixture(), '虚构还没识别.png', true);
    await f.reviewedWorkspace({ poNumber: 'PO-虚构待核对' });
    f.replies.push(
      { message: '查询识别工作区', toolCalls: [{ name: 'management.workspaces', args: { action: 'list', requestId: randomUUID() } }] },
      { message: '已按实际结果回答。' },
    );
    await f.send('查一下识别工作区', [], randomUUID(), owner());
    const seen = JSON.stringify(f.requests.at(-1)?.body);
    assert.ok(!seen.includes('hasDraft'), '给模型的结果里不带 hasDraft');
    assert.ok(seen.includes('虚构还没识别.png') && seen.includes('PO-虚构待核对.png'), '两份都列出来');
    assert.ok(seen.includes('state') && seen.includes('待核对') && seen.includes('待识别'), '带识别结果的是待核对，没识别的是待识别');
    assert.equal(f.imports.status().workspaces.length, 2, '只列出，工作区没多没少');
  } finally {
    f.close();
  }
});

test('助手归档、删除 AI 工作区总带版本：模型不填就按出卡片时的版本，确认前被改过就不执行', async () => {
  const f = createOrderWorkflowFixture(),
    who = owner();
  try {
    const w = (await f.imports.upload(imageFixture(), '虚构带版本.png', true)).workspace;
    const plan = f.manager.tools.prepare('management.workspaces', { action: 'archive', requestId: randomUUID(), items: [{ id: w.id }] }, who, 's');
    assert.deepEqual(plan.args.items, [{ id: w.id, revision: f.imports.load(w.id).revision }]);
    const stale = f.manager.tools.prepare('management.workspaces', { action: 'delete', requestId: randomUUID(), items: [{ id: w.id }] }, who, 's');
    await f.manager.tools.commit(plan, who, 's');
    const r = readAs(await f.manager.tools.commit(stale, who, 's'), { results: z.array(z.looseObject({ success: z.unknown() })) });
    assert.equal(r.results[0].success, false, JSON.stringify(r));
    assert.ok(f.imports.load(w.id), '版本过时的删除没执行');
  } finally {
    f.close();
  }
});

test('助手读记录上下文（management.context）只给本机最高管理员', async () => {
  const { managementReaders } = await import('../server/assistant/tools/management.js');
  const context = managementReaders['management.context'],
    who = pageActor({ id: 'tool-direct', name: '虚构直测', permissions: ['business:edit'], role: 'admin' });
  assert.equal(isLocalAdministrator(who), false);
  const store = new Store(':memory:');
  try {
    const ctx: ToolContext = { store, ops: new OperationsService(store), flow: new FlowService(store), services: {}, tools: new AssistantTools(store) };
    for (const someone of [who, null])
      assert.throws(
        () => context(ctx, { module: 'customers', id: 1 }, someone, 'management.context'),
        (e: unknown) => e instanceof AppError && e.status === 403 && /本机最高管理员/.test(e.message),
      );
  } finally {
    store.close();
  }
});
