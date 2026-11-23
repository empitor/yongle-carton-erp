// 助手的到货命令（server/assistant/tools/arrivals.ts、order_batch.receive）：和页面走同一个登记服务、读同一份到货记录。
// 假模型、内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, AppError, localAdministratorActor } from '../../server/core/index.js';
import { FlowService } from '../../server/flow/index.js';
import { OperationsService } from '../../server/operations/index.js';
import { AssistantToolRegistry } from '../../server/assistant/tool-registry.js';
import { autoConfirmAssistant, ctxOf, toolsOf } from '../support/assistant-fixture.js';
import { orderedPurchase } from '../support/receive-fixture.js';
import { actor, superActor } from '../support/actor-fixture.js';

test('助手按订货单登记到货：查采购、登记入库、核对到货记录各一步，和页面同一个服务，不另要确认；停用了不能执行，没有权限被拒', async () => {
  const a = autoConfirmAssistant();
  try {
    const ops = new OperationsService(a.store),
      flow = new FlowService(a.store);
    const supplier = ops.saveSupplier({ name: '虚构春芳纸板厂' }, actor),
      raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor);
    const p = orderedPurchase({ store: a.store, ops, flow, supplier, raw }, actor, ['10000']);
    const batch = p.batch(),
      input = {
        id: batch.id,
        expectedVersion: batch.version,
        requestId: randomUUID(),
        date: '2026-10-29',
        actualTime: '14:00',
        rows: [{ row: 1, quantity: '5000', rejectedQuantity: '0', stockedQuantity: '5000' }],
      },
      t = a.manager.create(actor);
    a.replies.push(
      { state: 'working', message: '查询采购与供应商', toolCalls: [{ name: 'records.search', args: { module: 'purchases', filters: { supplierId: supplier.id } } }] },
      { state: 'working', message: '登记全部合格实收到货', toolCalls: [{ name: 'order_batch.receive', args: input }] },
      { state: 'working', message: '核对正式批次', toolCalls: [{ name: 'arrival.records', args: { purchaseId: p.purchase.id } }] },
      { state: 'completed', message: '完成', toolCalls: [] },
    );
    const result = await a.manager.chat(
      t.id,
      a.input('虚构春芳纸板厂的订货单 ' + batch.number + ' 在2026-10-29 14:00到了5000张，不合格0张，入库5000张。', randomUUID()),
      actor,
      'test',
      () => {},
      () => actor,
    );
    assert.match(result.messages.at(-1)?.facts?.executed[0].label ?? '', /按订货单 .+ 登记到货并入库/);
    assert.deepEqual(flow.arrivalRecords().map((r) => r.actualTime), ['14:00']);
    assert.equal(ops.balance(raw.id), 5000000);
    assert.equal(a.calls(), 4, '没有多出的模型调用');
    const registry = new AssistantToolRegistry();
    try {
      registry.set({ name: 'order_batch.receive', enabled: false, expectedRevision: registry.view().revision }, localAdministratorActor(superActor()));
      await assert.rejects(
        () =>
          registry.dispatch('order_batch.receive', { ...input, requestId: randomUUID() }, actor, {
            read: () => null,
            business: () => assert.fail('停用不可执行'),
            workflow: () => null,
          }),
        /停用/,
      );
      assert.throws(() => toolsOf(a.store).prepare('order_batch.receive', { ...input, requestId: randomUUID() }, { ...actor, permissions: [] }, 's'), /权限/);
    } finally {
      registry.close();
    }
  } finally {
    a.close();
  }
});

test('撤销退货卡片绑定的退货单不在了：数据版本是 null（卡片按数据变了作废），不报找不到', () => {
  const store = new Store(':memory:');
  try {
    const tools = toolsOf(store);
    const plan = {
      tool: 'purchase_return.reverse',
      args: { id: 999, input: { version: 1, reason: '虚构退错了' } },
      label: '撤销采购退货 999',
      highRisk: true,
      before: null,
      after: null,
      warnings: [],
    };
    assert.equal(tools.stamp(plan, actor), null);
  } finally {
    store.close();
  }
});

test('助手查到货：到货记录取单据流转服务的同一份数据，带到货页面地址；没登录被拒', () => {
  const store = new Store(':memory:');
  try {
    const ctx = ctxOf(store),
      flow = ctx.flow;
    assert.deepEqual(ctx.tools.read('arrival.records', {}, actor), {
      records: flow.arrivalRecords({}),
      url: '#warehouse?arrivals=1',
    });
    assert.throws(() => ctx.tools.read('arrival.records', {}, null), (e: unknown) => e instanceof AppError && e.status === 401);
  } finally {
    store.close();
  }
});
