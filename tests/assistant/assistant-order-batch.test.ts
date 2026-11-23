import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OperationsService, OrderBatchService } from '../../server/operations/index.js';
import { FlowService } from '../../server/flow/index.js';
import { BusinessDocuments } from '../../server/documents/service.js';
import { AssistantToolRegistry } from '../../server/assistant/tool-registry.js';
import { quantityUnits } from '../../shared/core/quantity.js';
import { autoConfirmAssistant, toolsOf } from '../support/assistant-fixture.js';
import { type Store, count } from '../../server/core/index.js';
import { field } from '../../server/assistant/chat/result-fields.js';
import { actor } from '../support/actor-fixture.js';
import { readAs } from '../support/read-result.js';

/** 改到货安排的结果：取出逐行的安排，其余键保留 */
const scheduled = z.looseObject({ rows: z.array(z.looseObject({ schedule: z.array(z.looseObject({})) })) });

/** 同一家供应商两张待订货采购单，同一种纸板（合并后一行）。 */
function setup(store: Store) {
  const ops = new OperationsService(store),
    batches = new OrderBatchService(store),
    flow = new FlowService(store),
    docs = new BusinessDocuments(store);
  const supplier = ops.saveSupplier({ name: '虚构春芳纸板厂', contact: '', phone: '', address: '' }, actor);
  const item = ops.saveItem(
    { name: '虚构纸板A', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm', material: 'K=A', flute: 'B' },
    actor,
  );
  const purchase = (quantity: string, orderDate: string) =>
    ops.savePurchase(
      {
        supplierId: supplier.id,
        orderDate,
        expectedDate: null,
        status: '待订货',
        notes: '',
        lines: [{ ...item, stockItemId: item.id, quantity, unitPrice: '1.2', priceBasis: 'quantity' }],
      },
      actor,
    );
  const a = purchase('1000', '2026-11-01'),
    b = purchase('500', '2026-11-02');
  const stock = () => quantityUnits(ops.items(true, item.id)[0].quantity);
  return { ops, flow, batches, docs, supplier, item, a, b, stock };
}

test('助手合并导出订货单：先看合并后的行，再按行号写到货安排导出，交付完成后两张都已订货、进待到货', async () => {
  const fx = autoConfirmAssistant(),
    f = setup(fx.store);
  try {
    const tools = toolsOf(fx.store);
    const draft = readAs(tools.read('order_batch.draft', { purchaseIds: [f.a.id, f.b.id] }, actor), { rows: z.array(z.looseObject({})) });
    assert.equal(draft.rows.length, 1);
    assert.equal(draft.rows[0].row, 1);
    assert.equal(draft.rows[0].ordered, '1500');
    assert.equal(draft.rows[0].key, undefined, '不给模型看长的行键');
    const t = fx.manager.create(actor);
    fx.replies.push(
      { message: '看合并后的订货单', toolCalls: [{ name: 'order_batch.draft', args: { purchaseIds: [f.a.id, f.b.id] } }] },
      {
        message: '合并导出订货单',
        toolCalls: [
          {
            name: 'documents.export',
            args: {
              kind: 'purchase',
              id: f.a.id,
              expectedVersion: f.a.version,
              format: 'xlsx',
              markOrdered: true,
              purchases: [
                { id: f.a.id, version: f.a.version },
                { id: f.b.id, version: f.b.version },
              ],
              schedule: [{ row: 1, quantity: '1000', dueDate: '2026-11-12' }],
              requestId: randomUUID(),
            },
          },
        ],
      },
      { message: '订货单已交付，两张采购单都已订货。', toolCalls: [] },
    );
    await fx.manager.chat(
      t.id,
      fx.input('把虚构春芳纸板厂这两张采购单合成一份订货单发出去，1000张11月12日前要到，其余日期待定。', randomUUID()),
      actor,
      'test',
      (event: string, data: unknown) => {
        if (event === 'effect' && field(data, 'type') === 'download') {
          const file = f.docs.file(readAs(data, { file: z.looseObject({ exportId: z.string() }) }).file.exportId, actor);
          f.docs.delivered(file.requestId, actor);
          f.docs.complete(file.requestId, file.sha256, actor);
        }
      },
      () => actor,
    );
    const purchases = f.flow.views.purchases(true, [f.a.id, f.b.id]);
    assert.deepEqual(purchases.map((p) => p.businessStatus), ['已订货', '已订货']);
    const batchId = f.batches.batchIdOf(f.a.id);
    assert.ok(batchId !== null, '两张采购单进了订货单');
    assert.equal(f.batches.batchIdOf(f.b.id), batchId);
    const batch = readAs(tools.read('order_batch.get', { purchaseId: f.b.id }, actor), {
      number: z.string(),
      rows: z.array(z.looseObject({ schedule: z.array(z.looseObject({ dueDate: z.unknown(), quantity: z.unknown() })) })),
    });
    assert.match(batch.number, /^DG-/);
    assert.deepEqual(batch.rows[0].schedule.map((s) => [s.dueDate, s.quantity]), [
      ['2026-11-12', '1000'],
      [null, '500'],
    ]);
    assert.equal(readAs(tools.read('order_batch.list', {}, actor), { batches: z.array(z.unknown()) }).batches.length, 1);
  } finally {
    fx.close();
  }
});

test('助手按订货单登记到货：和人工同一个服务入库，分到各张采购单；改到货安排；没权限拒绝', async () => {
  const fx = autoConfirmAssistant(),
    f = setup(fx.store);
  try {
    const tools = toolsOf(fx.store);
    for (const p of [f.a, f.b]) {
      const current = f.flow.views.purchases(true, p.id)[0];
      f.flow.stock.savePurchase({ ...current, status: '已订货', version: current.version }, actor, p.id);
    }
    // 两张是分别改成已订货的，各自一个订货单；用第一张那份
    const batch = readAs(tools.read('order_batch.get', { purchaseId: f.a.id }, actor), {});
    const t = fx.manager.create(actor);
    fx.replies.push(
      { message: '查待到货', toolCalls: [{ name: 'order_batch.list', args: { supplierId: f.supplier.id } }] },
      {
        message: '按送货单登记到货',
        toolCalls: [
          {
            name: 'order_batch.receive',
            args: {
              id: batch.id,
              expectedVersion: batch.version,
              date: '2026-11-10',
              reference: '虚构送货单-001',
              rows: [{ row: 1, quantity: '600', rejectedQuantity: '100' }],
              requestId: randomUUID(),
            },
          },
        ],
      },
      { message: '已登记到货。', toolCalls: [] },
    );
    await fx.manager.chat(
      t.id,
      fx.input('虚构春芳纸板厂今天送来600张，其中100张不合格。', randomUUID()),
      actor,
      'test',
      () => {},
      () => actor,
    );
    assert.equal(f.stock(), 500_000, '合格的入库');
    const after = readAs(tools.read('order_batch.get', { id: batch.id }, actor), { rows: z.array(z.looseObject({})), arrivals: z.array(z.unknown()) });
    assert.equal(after.state, '部分到货');
    assert.equal(after.rows[0].remaining, '400');
    assert.equal(after.arrivals.length, 1);
    // 改到货安排：剩下的 400 张 11 月 20 日前到
    const plan = tools.prepare(
      'order_batch.schedule',
      { id: after.id, expectedVersion: after.version, schedule: [{ row: 1, quantity: '1000', dueDate: '2026-11-20' }] },
      actor,
      'test',
    );
    const saved = scheduled.parse(tools.commit(plan, actor, 'test'));
    assert.equal(saved.rows[0].schedule[0].dueDate, '2026-11-20');
    assert.throws(
      () => tools.prepare('order_batch.receive', { id: after.id, expectedVersion: saved.version, date: '2026-11-11', rows: [{ row: 2, quantity: '1', rejectedQuantity: '0' }], requestId: randomUUID() }, actor, 'test'),
      /没有第 2 行/,
    );
    assert.throws(
      () => tools.prepare('order_batch.receive', { id: after.id, date: '2026-11-11', rows: [{ row: 1, quantity: '1', rejectedQuantity: '0' }], requestId: randomUUID() }, { ...actor, permissions: [] }, 'test'),
      /权限/,
    );
    const registry = new AssistantToolRegistry();
    try {
      await assert.rejects(
        () =>
          registry.dispatch(
            'order_batch.receive',
            { id: after.id, date: '2026-11-11', rows: [{ row: 1, quantity: '1' }], requestId: randomUUID() },
            actor,
            { read: () => null, business: () => assert.fail('缺不合格数量不能执行'), workflow: () => null },
          ),
        /rejectedQuantity|参数/,
      );
    } finally {
      registry.close();
    }
  } finally {
    fx.close();
  }
});

test('以前订的采购单按 purchaseId 登记到货：生成方案（生成几次都一样）不建订货批次、不写审计，确认执行时才补建；已有订货单必须带版本', () => {
  const fx = autoConfirmAssistant(),
    f = setup(fx.store);
  try {
    // 模拟功能上线前订的采购单：已订货，但没有订货批次
    const current = f.flow.views.purchases(true, f.a.id)[0];
    f.flow.stock.savePurchase({ ...current, status: '已订货', version: current.version }, actor, f.a.id);
    fx.store.db.exec('DELETE FROM order_batch_purchases; DELETE FROM order_batches;');
    const batches = () => count(fx.store.db, 'SELECT COUNT(*) n FROM order_batches');
    const audits = () =>
      count(fx.store.db, "SELECT COUNT(*) n FROM business_audit WHERE entity='order_batches'");
    const auditsBefore = audits();
    const tools = toolsOf(fx.store);
    const args = { purchaseId: f.a.id, date: '2026-11-10', rows: [{ row: 1, quantity: '100', rejectedQuantity: '0' }], requestId: randomUUID() };
    for (const _again of [1, 2]) {
      const plan = tools.prepare('order_batch.receive', args, actor, 'test');
      assert.equal(plan.args.id, null, '执行时才补建');
      assert.match(plan.warnings.join(''), /补建订货单/);
    }
    assert.equal(batches(), 0, '生成方案不建订货批次');
    assert.equal(audits(), auditsBefore, '生成方案不写审计');
    assert.equal(f.stock(), 0);
    const plan = tools.prepare('order_batch.receive', args, actor, 'test');
    const received = z.looseObject({ arrival: z.looseObject({}), batch: z.looseObject({}) });
    const done = received.parse(tools.commit(plan, actor, 'test'));
    assert.equal(batches(), 1);
    assert.equal(f.stock(), 100_000);
    // 同一个请求再提交一次：不重复入库
    const again = received.parse(tools.commit(plan, actor, 'test'));
    assert.equal(again.arrival.id, done.arrival.id);
    assert.equal(f.stock(), 100_000);
    // 已经有订货单：按 id 或 purchaseId 登记都要带 expectedVersion
    for (const target of [{ id: done.batch.id }, { purchaseId: f.a.id }])
      assert.throws(
        () => tools.prepare('order_batch.receive', { ...args, ...target, requestId: randomUUID() }, actor, 'test'),
        /expectedVersion/,
      );
    const withVersion = tools.prepare(
      'order_batch.receive',
      { ...args, id: done.batch.id, expectedVersion: done.batch.version, requestId: randomUUID() },
      actor,
      'test',
    );
    assert.equal(withVersion.args.id, done.batch.id);
  } finally {
    fx.close();
  }
});

test('order_batch.list 先按供应商、采购单筛再组装，结果和全部待到货一致', () => {
  const fx = autoConfirmAssistant(),
    f = setup(fx.store);
  try {
    const order = (p: { id: number }) => {
      const current = f.flow.views.purchases(true, p.id)[0];
      f.flow.stock.savePurchase({ ...current, status: '已订货', version: current.version }, actor, p.id);
    };
    order(f.a);
    order(f.b);
    const tools = toolsOf(fx.store);
    const all = readAs(tools.read('order_batch.list', {}, actor), { batches: z.array(z.looseObject({ id: z.unknown() })) }).batches;
    assert.equal(all.length, 2);
    // 不先把全部待到货组装出来：按供应商、采购单在库里圈好，只组装圈出来的那几份
    const original = OrderBatchService.prototype.view;
    let views = 0;
    OrderBatchService.prototype.view = function (id: number) {
      views++;
      return original.call(this, id);
    };
    try {
      const bySupplier = readAs(tools.read('order_batch.list', { supplierId: f.supplier.id }, actor), { batches: z.array(z.looseObject({ id: z.unknown() })) }).batches;
      assert.deepEqual(bySupplier.map((b) => b.id), all.map((b) => b.id));
      views = 0;
      const byPurchase = readAs(tools.read('order_batch.list', { purchaseId: f.b.id }, actor), {
        batches: z.array(z.looseObject({ purchases: z.array(z.looseObject({ id: z.unknown() })) })),
      }).batches;
      assert.deepEqual(byPurchase.map((b) => b.purchases.map((p) => p.id)), [[f.b.id]]);
      assert.equal(views, 1, '只组装这张采购单所在的那份');
      views = 0;
      assert.equal(readAs(tools.read('order_batch.list', { supplierId: f.supplier.id + 999 }, actor), { batches: z.array(z.unknown()) }).batches.length, 0);
      assert.equal(views, 0, '别家供应商的一份都不组装');
    } finally {
      OrderBatchService.prototype.view = original;
    }
  } finally {
    fx.close();
  }
});

// 助手工具文件的直接测试
test('订货单给模型看的样子（tools/order-batch.ts 的 aiBatch）：行号从 1 开始、数量写成文本、不露行键', async () => {
  const { aiBatch } = await import('../../server/assistant/tools/order-batch.js');
  const view = aiBatch({
    id: 4,
    number: 'DH-虚构-1',
    version: 2,
    orderDate: '2026-01-02',
    supplierId: 9,
    supplierName: '虚构供应商',
    purchases: [1],
    progress: { state: '部分到货', overdue: false, nextDue: '2026-01-09' },
    rows: [
      {
        key: 'row-key-1',
        name: '虚构纸板',
        specification: '100*200',
        unit: '张',
        unitPrice: '1.2',
        orderedUnits: 2500,
        receivedUnits: 1000,
        remainingUnits: 1500,
        schedule: [{ dueDate: '2026-01-09', quantityUnits: 1500, remainingUnits: 1500, state: 'due' }],
      },
    ],
  });
  assert.deepEqual(view.rows, [
    {
      row: 1,
      name: '虚构纸板',
      specification: '100*200',
      unit: '张',
      unitPrice: '1.2',
      ordered: '2.5',
      received: '1',
      remaining: '1.5',
      schedule: [{ dueDate: '2026-01-09', quantity: '1.5', remaining: '1.5', state: 'due' }],
    },
  ]);
  assert.equal(JSON.stringify(view).includes('row-key-1'), false);
  assert.equal(view.state, '部分到货');
  assert.equal(view.url, '#warehouse?arrivals=1');
});
