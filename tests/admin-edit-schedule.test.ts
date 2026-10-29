import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { legacyReceiptFixture } from './legacy-receipt-fixture.js';
import { FlowService } from '../server/flow/service.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { actor, assistantFixture } from './assistant-fixture.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/domain.js';
import { planDate, scheduleSummary, shiftDate } from '../shared/schedule.js';
import { receiptEditMode } from '../shared/receipt-edit-mode.js';
import { startsIndependentTask } from '../server/assistant/task-routing.js';
import { currentOrderCard } from '../shared/assistant-order-card.js';
import { ReceiptHistory, ProgressSummary } from '../src/FulfillmentDetails.js';
import DateSchedule from '../src/DateSchedule.js';
import AssistantOrderTask from '../src/AssistantOrderTask.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';

const owner = () => localAdministratorActor({ ...actor, role: 'super_admin' });
function fixture(store = new Store(':memory:')) {
  const ops = new OperationsService(store),
    flow = new FlowService(store);
  const supplier = ops.saveSupplier({ name: '虚构纠偏供应商' }, actor);
  const raw = ops.saveItem({ name: '虚构纸板A', kind: 'raw', unit: '张' }, actor);
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      status: '已订货',
      orderDate: '2026-10-01',
      lines: [
        { ...raw, stockItemId: raw.id, quantity: '10000', unitPrice: '2', priceBasis: 'quantity' },
      ],
    },
    actor,
  );
  const current = () => store.purchases(true).find((p) => p.id === purchase.id)!;
  const confirm = (doc: any) =>
    flow.confirm(
      doc.id,
      {
        previewId: flow.preview(doc.id, actor, 'test').previewId,
        requestId: randomUUID(),
        acknowledged: true,
      },
      actor,
      'test',
    );
  const receive = (source: string) =>
    source === 'flow'
      ? confirm(
          flow.save(
            'arrival',
            {
              date: '2026-10-20',
              supplierId: supplier.id,
              reference: randomUUID(),
              lines: [
                {
                  stockId: raw.id,
                  purchaseLineId: purchase.lines[0].id,
                  item: raw,
                  quantity: '10000',
                  unitPrice: '2',
                  priceBasis: 'quantity',
                },
              ],
            },
            actor,
          ),
        )
      : legacyReceiptFixture(ops,
          purchase.id,
          {
            date: '2026-10-20',
            expectedVersion: current().version,
            requestId: randomUUID(),
            reference: randomUUID(),
            acknowledged: true,
            items: [{ lineId: purchase.lines[0].id, quantity: '10000' }],
          },
          actor,
        );
  const input = (quantity: string, mode: 'data-edit' | 'business' = 'data-edit') => ({
    mode,
    expectedVersion: current().receipts.find((r: any) => r.effective).version,
    expectedPurchaseVersion: current().version,
    reason: '虚构验收：历史录入错误，按明确模式纠偏',
    items: [{ index: 0, lineId: purchase.lines[0].id, quantity }],
  });
  const edit = (quantity: string, mode: 'data-edit' | 'business' = 'data-edit') => {
    const key = current().receipts.find((r: any) => r.effective).id,
      v = input(quantity, mode),
      who = owner();
    const plan = ops.previewReceiptCorrection(purchase.id, key, v, who);
    const request = { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() };
    return { key, request, result: ops.correctReceipt(purchase.id, key, request, who) };
  };
  const moves = () => store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all();
  return {
    store,
    ops,
    flow,
    supplier,
    raw,
    purchase,
    current,
    confirm,
    receive,
    input,
    edit,
    moves,
  };
}

for (const source of ['flow', 'legacy'])
  test(`${source}管理员历史纠偏：库存仅1000仍可将10000改5000，原单流水不变、差异审计、连续纠偏与幂等`, () => {
    const f = fixture();
    try {
      f.receive(source);
      f.ops.move(
        f.raw.id,
        {
          expectedVersion: f.ops.repo.items()[0].version,
          requestId: randomUUID(),
          action: 'out',
          quantity: '9000',
          date: '2026-10-21',
          notes: '虚构后续消耗',
          acknowledged: true,
        },
        actor,
      );
      const key = f.current().receipts[0].id,
        beforeMoves = f.moves(),
        beforeFlow = f.store.db.prepare('SELECT * FROM flow_documents').all(),
        beforeReceipts = f.store.db.prepare('SELECT * FROM purchase_receipts').all();
      assert.throws(
        () =>
          f.ops.previewReceiptCorrection(f.purchase.id, key, f.input('5000', 'business'), actor),
        /库存不足/,
      );
      const { result, request } = f.edit('5000');
      assert.equal(result.verified, true);
      assert.equal(f.current().lines[0].quantity, '10000');
      assert.equal(f.current().lines[0].receivedQuantity, '5000');
      assert.equal(f.current().lines[0].remainingQuantity, '5000');
      assert.equal(f.current().arrivalProgress, '部分到货');
      assert.equal(Number(f.current().totalAmount), 20000);
      assert.equal(Number(f.current().receivedAmount), 10000);
      assert.equal(f.ops.repo.items()[0].quantity, '1000');
      assert.equal(f.current().reconciliationStatus, '待核对差异');
      assert.equal(f.current().discrepancies[0].differenceUnits, 5000000);
      assert.deepEqual(f.moves(), beforeMoves);
      assert.deepEqual(f.store.db.prepare('SELECT * FROM flow_documents').all(), beforeFlow);
      assert.deepEqual(f.store.db.prepare('SELECT * FROM purchase_receipts').all(), beforeReceipts);
      const audit = f.store.db
        .prepare("SELECT * FROM business_audit WHERE action='receipt-data-edit'")
        .get()!;
      const record = JSON.parse(String(audit.document));
      assert.equal(record.before[0].quantity, '10000');
      assert.equal(record.after[0].quantity, '5000');
      assert.equal(audit.actor_name, actor.name);
      assert.ok(audit.at);
      assert.match(record.reason, /历史录入错误/);
      assert.equal(f.ops.correctReceipt(f.purchase.id, key, request, owner()).replayed, true);
      assert.throws(
        () => f.ops.correctReceipt(f.purchase.id, key, { ...request, reason: '不同内容' }, owner()),
        /不同内容/,
      );
      f.edit('3000');
      assert.equal(f.current().discrepancies[0].differenceUnits, 7000000);
      f.edit('10000');
      assert.equal(f.current().reconciliationStatus, '一致');
      assert.equal(f.current().receipts[0].dataEdits.length, 3);
      assert.deepEqual(f.moves(), beforeMoves);
      f.edit('0');
      assert.equal(f.current().arrivalProgress, '未到货');
      const markup = renderToStaticMarkup(createElement(ReceiptHistory, { row: f.current() }));
      assert.match(markup, /管理员数据编辑历史/);
      assert.match(markup, /待核对差异/);
      assert.match(markup, /库存未调整/);
      assert.match(
        renderToStaticMarkup(createElement(ProgressSummary, { row: f.current(), purchase: true })),
        /待核对差异/,
      );
    } finally {
      f.store.close();
    }
  });

test('数据编辑须不可伪造本机能力，版本/摘要及事务失败无半写入；正式更正按原入库量消除差异', () => {
  const f = fixture();
  try {
    f.receive('flow');
    const key = f.current().receipts[0].id,
      input = f.input('5000');
    for (const who of [null, actor, { ...actor, role: 'super_admin', localAdministrator: true }])
      assert.throws(
        () => f.ops.previewReceiptCorrection(f.purchase.id, key, input, who as any),
        /登录|最高管理员/,
      );
    const p = f.ops.previewReceiptCorrection(f.purchase.id, key, input, owner());
    assert.throws(
      () =>
        f.ops.correctReceipt(
          f.purchase.id,
          key,
          { ...input, requestId: randomUUID(), previewDigest: 'a'.repeat(64) },
          owner(),
        ),
      /变化/,
    );
    f.store.db.exec(
      "CREATE TRIGGER reject_edit BEFORE UPDATE ON purchases BEGIN SELECT RAISE(ABORT,'fictional rollback'); END",
    );
    assert.throws(
      () =>
        f.ops.correctReceipt(
          f.purchase.id,
          key,
          { ...input, requestId: randomUUID(), previewDigest: p.previewDigest },
          owner(),
        ),
      /fictional rollback/,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM business_audit WHERE action='receipt-data-edit'")
        .get()!.n,
      0,
    );
    assert.equal(f.current().lines[0].receivedQuantity, '10000');
    f.store.db.exec('DROP TRIGGER reject_edit');
    f.edit('5000');
    assert.throws(() => f.ops.previewReceiptCorrection(f.purchase.id, key, input, owner()), /版本/);
    const result = f.edit('4000', 'business').result;
    assert.equal(result.stockImpact[0].delta, '-6000');
    assert.equal(f.ops.repo.items()[0].quantity, '4000');
    assert.equal(f.current().lines[0].receivedQuantity, '4000');
    assert.equal(f.current().reconciliationStatus, '一致');
    assert.equal(f.current().receipts.find((r: any) => r.id === key).dataEdits.length, 1);
    f.edit('3000');
    const sync = f.edit('3000', 'business').result;
    assert.equal(sync.stockImpact[0].delta, '-1000');
    assert.equal(f.current().reconciliationStatus, '一致');
    assert.match(sync.summary, /差异核对/);
  } finally {
    f.store.close();
  }
});

test('仅统计纠偏重开数据库仍有效；不新增迁移、不修改原库存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-edit-')),
    file = join(dir, 'fictional.sqlite');
  let f = fixture(new Store(file));
  try {
    f.receive('legacy');
    f.edit('5000');
    const beforeMoves = f.moves();
    f.store.close();
    const store = new Store(file);
    try {
      assert.equal(store.purchases()[0].lines[0].receivedQuantity, '5000');
      assert.equal(store.purchases()[0].reconciliationStatus, '待核对差异');
      assert.deepEqual(
        store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all(),
        beforeMoves,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('生产与送货排程：未来计划独立于实际、部分生产可改期、完成拒绝改期、确认才产生实绩库存', () => {
  const f = fixture();
  try {
    f.receive('flow');
    const customer = f.store.saveCustomer(customerSchema.parse({ name: '虚构排程客户' }));
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构排程纸箱' }));
    const finished = f.ops.saveItem(
      { name: '虚构排程成品', kind: 'finished', unit: '只', productId: product.id },
      actor,
    );
    const order = f.store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-29',
        deliveryDate: '2026-11-04',
        status: '已确认',
        lines: [{ productId: product.id, quantity: 100, unitPriceCents: 200, unit: '只' }],
      }),
    );
    const task = f.flow.save(
      'task',
      {
        date: '2026-10-29',
        plannedDate: '2026-11-02',
        productId: product.id,
        quantity: '100',
        unit: '只',
        orderIds: [order.id],
      },
      actor,
    );
    const snapshot = f.moves();
    const change = {
      expectedVersion: task.version,
      plannedDate: '2026-11-03',
      requestId: randomUUID(),
    };
    assert.equal(f.flow.schedule(task.id, change, actor).verified, true);
    assert.equal(f.flow.schedule(task.id, change, actor).replayed, true);
    assert.throws(
      () => f.flow.schedule(task.id, { ...change, plannedDate: '2026-11-04' }, actor),
      /不同内容/,
    );
    assert.throws(
      () => f.flow.schedule(task.id, { ...change, requestId: randomUUID() }, actor),
      /修改/,
    );
    assert.throws(
      () =>
        f.flow.schedule(
          task.id,
          { ...change, requestId: randomUUID() },
          { ...actor, permissions: [] },
        ),
      /权限/,
    );
    assert.deepEqual(f.moves(), snapshot);
    assert.equal(f.flow.get(task.id).actualCompletionDate, null);
    f.confirm(f.flow.get(task.id));
    const production = (q: string, date: string) =>
      f.confirm(
        f.flow.save(
          'production',
          {
            date,
            taskId: task.id,
            productId: product.id,
            finishedStockId: finished.id,
            goodQuantity: q,
            operator: '虚构操作员',
            materials: [{ stockId: f.raw.id, issued: q }],
          },
          actor,
        ),
      );
    production('40', '2026-10-29');
    let t = f.flow.get(task.id);
    assert.equal(t.actualStartDate, '2026-10-29');
    assert.equal(t.actualCompletionDate, null);
    const beforeReschedule = f.moves();
    f.flow.schedule(
      task.id,
      { expectedVersion: t.version, plannedDate: '2026-11-05', requestId: randomUUID() },
      actor,
    );
    assert.deepEqual(f.moves(), beforeReschedule);
    production('60', '2026-10-30');
    t = f.flow.get(task.id);
    assert.equal(t.actualCompletionDate, '2026-10-30');
    assert.equal(t.plannedDate, '2026-11-05');
    assert.equal(t.date, '2026-10-29');
    assert.throws(
      () =>
        f.flow.schedule(
          t.id,
          { expectedVersion: t.version, plannedDate: '2026-11-06', requestId: randomUUID() },
          owner(),
        ),
      /未完成/,
    );
    const delivery = f.flow.save(
      'delivery',
      {
        date: '2026-10-31',
        plannedDate: '2026-11-06',
        customerId: customer.id,
        lines: [
          {
            orderId: order.id,
            orderLineId: order.lines[0].id,
            stockId: finished.id,
            quantity: '50',
          },
        ],
      },
      actor,
    );
    assert.equal(delivery.actualDate, null);
    assert.equal(f.store.order(order.id)!.lines[0].shippedQuantity, 0);
    const beforeDelivery = f.moves();
    f.flow.schedule(
      delivery.id,
      { expectedVersion: delivery.version, plannedDate: '2026-11-07', requestId: randomUUID() },
      actor,
    );
    assert.deepEqual(f.moves(), beforeDelivery);
    assert.equal(f.store.order(order.id)!.lines[0].shippedQuantity, 0);
    f.confirm(f.flow.get(delivery.id));
    const done = f.flow.get(delivery.id);
    assert.equal(done.plannedDate, '2026-11-07');
    assert.equal(done.actualDate, '2026-10-31');
    assert.equal(f.store.order(order.id)!.lines[0].shippedQuantity, 50);
    assert.equal(f.ops.repo.items().find((s) => s.id === finished.id).quantity, '50');
    assert.throws(
      () =>
        f.flow.schedule(
          done.id,
          { expectedVersion: done.version, plannedDate: '2026-11-08', requestId: randomUUID() },
          actor,
        ),
      /未发货/,
    );
    assert.throws(
      () => f.flow.maintenanceUpdate(done.id, { ...done, plannedDate: '2026-11-08' }, owner()),
      /已完成/,
    );
    assert.equal(scheduleSummary([done], () => '只').quantities, '50 只');
    assert.equal(scheduleSummary([done]).completed, 1);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('计划日期兼容历史、时区跨日、闰年及每日概览不混合单位；共用日期栏可SSR', () => {
  assert.equal(today(new Date('2026-10-28T16:30:00Z')), '2026-10-29');
  assert.equal(today(new Date('2026-10-29T15:59:59Z')), '2026-10-29');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDate('9999-12-31', 7), '9999-12-31');
  assert.equal(shiftDate('0000-01-01', -7), '0000-01-01');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(planDate({ date: '2020-01-01' }), '2020-01-01');
  assert.equal(
    scheduleSummary([
      { kind: 'task', status: 'confirmed', quantity: '1', unit: '张', completed: '0' },
      { kind: 'task', status: 'draft', quantity: '2', unit: '只' },
      { kind: 'task', status: 'cancelled', quantity: '3', unit: '只' },
    ]).quantities,
    '1 张 / 2 只',
  );
  assert.match(
    renderToStaticMarkup(
      createElement(DateSchedule, {
        value: today(),
        onChange: () => {},
        counts: {},
        label: '生产',
      }),
    ),
    /今天/,
  );
  const f = fixture();
  try {
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构历史任务' }));
    const t = f.flow.save(
      'task',
      { date: '2020-01-01', productId: product.id, quantity: '10', unit: '只' },
      actor,
    );
    f.store.db
      .prepare(
        "UPDATE flow_documents SET document=json_remove(document,'$.plannedDate') WHERE id=?",
      )
      .run(t.id);
    assert.equal(f.flow.get(t.id).plannedDate, '2020-01-01');
    assert.equal(f.flow.get(t.id).plannedDateSource, 'legacy-date');
  } finally {
    f.store.close();
  }
});

test('AI工具数据编辑权限/停用及排程沿用注册表；新采购任务不展示旧订单卡片', async () => {
  const f = fixture(),
    registry = new AssistantToolRegistry();
  try {
    f.receive('legacy');
    const tools = new AssistantTools(f.store),
      input = {
        purchaseId: f.purchase.id,
        receiptId: f.current().receipts[0].id,
        ...f.input('5000'),
      };
    const handlers = {
      read: (name: string, args: any) => tools.read(name, args, owner()),
      business: () => null,
      workflow: () => null,
    };
    await assert.rejects(
      () => registry.dispatch('purchase.receipt.data_edit_preview', input, actor, handlers),
      /最高管理员/,
    );
    const preview = await registry.dispatch(
      'purchase.receipt.data_edit_preview',
      input,
      owner(),
      handlers,
    );
    const plan = tools.prepare(
      'purchase.receipt.data_edit',
      { ...input, previewDigest: (preview.value as any).previewDigest, requestId: randomUUID() },
      owner(),
      'test',
    );
    assert.equal(f.current().lines[0].receivedQuantity, '10000');
    assert.equal(tools.commit(plan, owner(), 'test').verified, true);
    registry.set(
      {
        name: 'purchase.receipt.data_edit_preview',
        enabled: false,
        expectedRevision: registry.view().revision,
      },
      owner(),
    );
    await assert.rejects(
      () => registry.dispatch('purchase.receipt.data_edit_preview', input, owner(), handlers),
      /停用/,
    );
    const workflow = {
      activeId: 'old',
      tasks: [{ id: 'old', workspaceId: 'old-workspace', fileName: '旧订单' }],
    };
    const task: any = {
      goal: '更正采购到货',
      steps: [],
      memory: { workspaceIds: [], decisions: [], turns: [] },
    };
    assert.equal(currentOrderCard(workflow, task), null);
    assert.equal(
      renderToStaticMarkup(createElement(AssistantOrderTask, { workflow, businessTask: task })),
      '',
    );
    task.memory.workspaceIds.push('old-workspace');
    assert.equal(currentOrderCard(workflow, task).id, 'old');
  } finally {
    f.store.close();
    registry.close();
  }
});

test('真实用户切换模式继承当前任务并替换决定，Agent拒绝错模式和重复失败预览（模型替身）', async () => {
  assert.equal(receiptEditMode('把采购到货10000张更正为5000张，并同步库存'), 'business');
  assert.equal(receiptEditMode('这是数据编辑，不要扣库存，只修改采购到货记录'), 'data-edit');
  assert.equal(receiptEditMode('不要数据编辑，改为同步库存'), 'business');
  const a = assistantFixture(),
    f = fixture(a.store),
    who = owner();
  try {
    f.receive('legacy');
    f.ops.move(
      f.raw.id,
      {
        expectedVersion: f.ops.repo.items()[0].version,
        requestId: randomUUID(),
        action: 'out',
        quantity: '9000',
        date: today(),
        notes: '虚构使用',
        acknowledged: true,
      },
      actor,
    );
    const thread = a.manager.create(who),
      raw = {
        purchaseId: f.purchase.id,
        receiptId: f.current().receipts[0].id,
        ...f.input('5000', 'business'),
      };
    a.replies.push(
      {
        message: '',
        state: 'working',
        toolCalls: [
          { name: 'purchase.receipt.preview', args: raw },
          { name: 'purchase.receipt.preview', args: raw },
        ],
      },
      { message: '库存不足，未修改。', state: 'blocked', toolCalls: [] },
    );
    await a.manager.chat(
      thread.id,
      a.input('把采购到货10000更正5000，并同步库存', randomUUID()),
      who,
      'test',
      () => {},
      () => who,
    );
    let task = a.manager.tasks.get(thread.id, who)!;
    const taskId = task.id;
    assert.equal(
      startsIndependentTask('这是数据编辑，不要扣库存，只修改采购到货记录', task),
      false,
    );
    const dataRaw = { ...raw, mode: 'data-edit' },
      preview = f.ops.previewReceiptCorrection(f.purchase.id, raw.receiptId, f.input('5000'), who);
    a.replies.push(
      {
        message: '',
        state: 'working',
        toolCalls: [
          { name: 'purchase.receipt.preview', args: raw },
          { name: 'purchase.receipt.data_edit_preview', args: dataRaw },
        ],
      },
      {
        message: '',
        state: 'working',
        toolCalls: [
          {
            name: 'purchase.receipt.data_edit',
            args: { ...dataRaw, previewDigest: preview.previewDigest, requestId: randomUUID() },
          },
        ],
      },
      { message: '已完成。', state: 'completed', toolCalls: [] },
    );
    await a.manager.chat(
      thread.id,
      a.input('这是数据编辑，不要扣库存，只修改采购到货记录', randomUUID()),
      who,
      'test',
      () => {},
      () => who,
    );
    task = a.manager.tasks.get(thread.id, who)!;
    assert.equal(task.id, taskId);
    assert.equal(
      task.memory!.decisions.find((d) => d.key === 'receiptCorrectionMode')!.value,
      'data-edit',
    );
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
    assert.equal(f.ops.repo.items()[0].quantity, '1000');
    const view = a.manager.view(thread.id, who);
    assert.match(view.messages.at(-1)!.text, /仅编辑历史到货统计|库存未调整/);
    assert.ok(
      view.messages.some((m) => m.events?.some((e: any) => /不重复请求/.test(e.message || ''))),
    );
    assert.ok(
      view.messages.some((m) => m.events?.some((e: any) => /用户已切换/.test(e.message || ''))),
    );
  } finally {
    a.close();
  }
});

test('HTTP管理员纠偏与排程复用真实身份、CSRF和原服务；远程及转发头不能得到本机权限', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:', Date.now, { localAdministration: true });
  const server = createApp(f.store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  try {
    f.receive('legacy');
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构排程管理员', password: 'fictional-schedule-password-123' }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const post = (path: string, input: unknown, extra: Record<string, string> = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-ERP-Auth-Token': auth.csrf,
          ...extra,
        },
        body: JSON.stringify(input),
      });
    const key = f.current().receipts[0].id,
      path = '/purchases/' + f.purchase.id + '/receipts/' + key,
      input = f.input('5000');
    assert.equal(
      (await post(path + '/correction-preview', input, { 'X-Forwarded-For': '127.0.0.1' })).status,
      403,
    );
    const plan = await (await post(path + '/correction-preview', input)).json();
    assert.ok(plan.previewDigest);
    const denied = await post(
      path + '/correct',
      { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() },
      { 'X-ERP-Auth-Token': '' },
    );
    assert.equal(denied.status, 403);
    const saved = await post(path + '/correct', {
      ...input,
      previewDigest: plan.previewDigest,
      requestId: randomUUID(),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).verified, true);
    const product = f.store.saveProduct(productSchema.parse({ name: '虚构HTTP排程产品' }));
    const task = f.flow.save(
      'task',
      { date: today(), productId: product.id, quantity: '20', unit: '只' },
      actor,
    );
    const schedule = {
      expectedVersion: task.version,
      plannedDate: '2027-01-02',
      requestId: randomUUID(),
    };
    assert.equal(
      (await post('/flow/' + task.id + '/schedule', schedule, { 'X-ERP-Auth-Token': '' })).status,
      403,
    );
    assert.equal(
      (await post('/flow/' + task.id + '/schedule', { ...schedule, plannedDate: '2026-02-30' }))
        .status,
      400,
    );
    const scheduled = await post('/flow/' + task.id + '/schedule', schedule);
    assert.equal(scheduled.status, 200);
    assert.equal((await scheduled.json()).document.plannedDate, '2027-01-02');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    f.store.close();
  }
});
