import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { buildDashboard } from '../server/business/dashboard.js';
import { warehouseArrivalHash } from '../shared/arrival-navigation.js';
import { actor, assistantFixture } from './assistant-fixture.js';
import { legacyReceiptFixture } from './legacy-receipt-fixture.js';
import { pageLink } from '../shared/assistant-navigation.js';

function fixture(store = new Store(':memory:'), count = 1) {
  const ops = new OperationsService(store),
    flow = new FlowService(store);
  const supplier = ops.saveSupplier({ name: '虚构春芳纸板厂' }, actor);
  const stocks = Array.from({ length: count }, (_, i) =>
    ops.saveItem(
      {
        name: '虚构纸板' + (i + 1),
        kind: 'raw',
        unit: '张',
        material: 'K=A',
        flute: 'B',
        length: 1000,
        width: 800,
        dimensionUnit: 'mm',
      },
      actor,
    ),
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      orderDate: '2026-10-01',
      status: '已订货',
      lines: stocks.map((s) => ({
        ...s,
        stockItemId: s.id,
        quantity: '10000',
        unitPrice: '2',
        priceBasis: 'quantity',
      })),
    },
    actor,
  );
  const current = () => store.purchases(true).find((p) => p.id === purchase.id)!;
  const receiveInput = (quantities = ['5000'], extra: any = {}) => ({
    purchaseId: purchase.id,
    expectedPurchaseVersion: current().version,
    requestId: randomUUID(),
    date: '2026-10-29',
    actualTime: '14:00',
    items: quantities.map((quantity, i) => ({ lineId: purchase.lines[i].id, quantity })),
    ...extra,
  });
  const receive = (q?: string[], extra?: any) =>
    flow.receivePurchase(receiveInput(q, extra), actor);
  const planInput = (q = '5000', extra: any = {}) => ({
    purchaseId: purchase.id,
    expectedPurchaseVersion: current().version,
    requestId: randomUUID(),
    plannedDate: '2026-11-01',
    plannedTime: '14:00',
    items: [{ lineId: purchase.lines[0].id, quantity: q }],
    ...extra,
  });
  const moves = () => store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all();
  const correct = (record: any, items: any[], mode: 'business' | 'data-edit' = 'business') => {
    const who =
      mode === 'data-edit' ? localAdministratorActor({ ...actor, role: 'super_admin' }) : actor;
    const input = {
      mode,
      expectedVersion: record.version,
      expectedPurchaseVersion: current().version,
      reason: '虚构验收更正',
      items,
    };
    const p = ops.previewReceiptCorrection(purchase.id, record.id, input, who);
    return ops.correctReceipt(
      purchase.id,
      record.id,
      { ...input, requestId: randomUUID(), previewDigest: p.previewDigest },
      who,
    );
  };
  return {
    store,
    ops,
    flow,
    supplier,
    stocks,
    purchase,
    current,
    receiveInput,
    receive,
    planInput,
    moves,
    correct,
  };
}

test('旧receive与正式服务统一：10000分两批5000，正式到货/采购/库存/报表/AI数量一致', () => {
  const f = fixture();
  try {
    const first = f.ops.receive(
      f.purchase.id,
      {
        expectedVersion: f.current().version,
        requestId: randomUUID(),
        reference: '虚构批次1',
        date: '2026-10-29',
        actualTime: '14:00',
        acknowledged: true,
        items: [{ lineId: f.purchase.lines[0].id, quantity: '5000' }],
      },
      actor,
    );
    assert.ok(first.arrival.id);
    assert.equal(f.current().businessStatus, '已订货');
    assert.equal(f.current().arrivalProgress, '部分到货');
    assert.equal(f.current().lines[0].remainingQuantity, '5000');
    assert.equal(f.ops.repo.items()[0].quantity, '5000');
    const second = f.receive(['5000'], { date: '2026-10-30', actualTime: '09:30' });
    assert.notEqual(first.arrival.id, second.arrival.id);
    assert.equal(f.current().arrivalProgress, '全部到货');
    assert.equal(f.current().businessStatus, '已订货');
    assert.equal(f.current().lines[0].receivedQuantity, '10000');
    assert.equal(f.current().lines[0].remainingQuantity, '0');
    assert.equal(f.ops.repo.items()[0].quantity, '10000');
    const records = f.flow.arrivalRecords({ purchaseId: f.purchase.id });
    assert.equal(records.length, 2);
    assert.equal(f.current().receipts.length, 2);
    assert.equal(records[1].actualTime, '14:00');
    assert.equal(records[0].actualTime, '09:30');
    assert.equal(records[0].inspectionStatus, '全部合格');
    assert.equal(records[0].lines[0].stockedQuantity, '5000');
    assert.equal(f.moves().length, 2);
    assert.ok(f.moves().every((m) => m.source_kind === 'flow_arrival'));
    const tools = new AssistantTools(f.store);
    assert.deepEqual(
      tools.read('arrival.records', { purchaseId: f.purchase.id }, actor).records,
      records,
    );
    assert.equal(tools.read('records.search', { module: 'arrivals' }, actor).total, 2);
    assert.equal(Number(buildDashboard(f.store, [], {}).overview.purchases.receivedAmount), 20000);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('人工验收草稿明确尚未入库；确认后按合格入库，缺失原始流水时不能虚报实际入库', () => {
  const f = fixture();
  try {
    const draft = f.flow.save(
      'arrival',
      {
        date: '2026-10-29',
        actualTime: '14:00',
        supplierId: f.supplier.id,
        reference: '虚构人工验收',
        lines: [
          {
            stockId: f.stocks[0].id,
            purchaseLineId: f.purchase.lines[0].id,
            item: f.stocks[0],
            quantity: '100',
            acceptedQuantity: '90',
            rejectedQuantity: '10',
            stockedQuantity: '90',
          },
        ],
      },
      actor,
    );
    assert.equal(f.flow.arrivalRecords()[0].inventoryStatus, '尚未入库');
    assert.equal(f.flow.arrivalRecords()[0].lines[0].stockedQuantity, '0');
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    assert.equal(f.moves().length, 0);
    const preview = f.flow.preview(draft.id, actor, 's');
    f.flow.confirm(
      draft.id,
      { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true },
      actor,
      's',
    );
    assert.equal(f.flow.arrivalRecords()[0].lines[0].stockedQuantity, '90');
    assert.equal(f.current().lines[0].receivedQuantity, '100');
    f.store.db
      .prepare("DELETE FROM stock_movements WHERE source_kind='flow_arrival' AND source_id=?")
      .run(String(draft.id));
    assert.equal(f.flow.arrivalRecords()[0].inventoryStatus, '入库待核对');
    assert.equal(f.flow.arrivalRecords()[0].lines[0].stockedQuantity, null);
  } finally {
    f.store.close();
  }
});

test('多产品混合验收：总到货与合格/不合格/实际入库独立，零入库不产生虚假流水；逐行更正同步', () => {
  const f = fixture(undefined, 2);
  try {
    f.receive([], {
      items: [
        {
          lineId: f.purchase.lines[0].id,
          quantity: '5000',
          acceptedQuantity: '4500',
          rejectedQuantity: '500',
          stockedQuantity: '4000',
        },
        {
          lineId: f.purchase.lines[1].id,
          quantity: '1000',
          acceptedQuantity: '0',
          rejectedQuantity: '1000',
          stockedQuantity: '0',
        },
      ],
    });
    const record = f.flow.arrivalRecords()[0];
    assert.equal(record.inspectionStatus, '含不合格品');
    assert.equal(record.inventoryStatus, '部分入库');
    assert.deepEqual(
      f.current().lines.map((l: any) => l.receivedQuantity),
      ['5000', '1000'],
    );
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 4000000);
    assert.equal(f.ops.repo.balance(f.stocks[1].id), 0);
    assert.equal(f.moves().length, 1);
    assert.throws(
      () => f.correct(record, [{ index: 0, lineId: record.lines[0].lineId, quantity: '4000' }]),
      /同时明确/,
    );
    const result = f.correct(record, [
      {
        index: 0,
        lineId: record.lines[0].lineId,
        quantity: '4000',
        acceptedQuantity: '3500',
        rejectedQuantity: '500',
        stockedQuantity: '3000',
      },
    ]);
    assert.equal(result.stockImpact.find((s: any) => s.stockId === f.stocks[0].id)!.delta, '-1000');
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 3000000);
    assert.equal(f.ops.repo.balance(f.stocks[1].id), 0);
    assert.deepEqual(
      f.current().lines.map((l: any) => l.receivedQuantity),
      ['4000', '1000'],
    );
    const next = f.flow.arrivalRecords().find((r) => r.effective)!;
    assert.equal(next.lines[0].acceptedQuantity, '3500');
    assert.equal(next.lines[1].rejectedQuantity, '1000');
    f.correct(next, [
      {
        index: 0,
        lineId: next.lines[0].lineId,
        quantity: '4000',
        acceptedQuantity: '3600',
        rejectedQuantity: '400',
        stockedQuantity: '3200',
      },
    ]);
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 3200000);
    assert.equal(f.flow.arrivalRecords().filter((r) => r.effective).length, 1);
  } finally {
    f.store.close();
  }
});

test('未来分批计划、改期及计划转实收：同一单据保留计划快照，确认实际到货才入库', () => {
  const f = fixture();
  try {
    const p1 = f.flow.saveArrivalPlan(f.planInput(), actor).document;
    const p2 = f.flow.saveArrivalPlan(
      f.planInput('5000', { plannedDate: '2026-11-02' }),
      actor,
    ).document;
    assert.equal(f.flow.arrivalRecords().length, 0);
    assert.equal(f.flow.arrivalPlans().length, 2);
    assert.equal(f.moves().length, 0);
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    assert.throws(() => f.flow.preview(p1.id, actor, 'test'), /计划不代表实收/);
    assert.throws(() => f.flow.saveArrivalPlan(f.planInput('1'), actor), /分批计划合计/);
    const revised = f.flow.saveArrivalPlan(
      f.planInput('5000', {
        id: p1.id,
        expectedVersion: p1.version,
        plannedDate: '2026-11-04',
        plannedTime: '15:30',
      }),
      actor,
    ).document;
    assert.equal(revised.plannedDate, '2026-11-04');
    assert.equal(f.moves().length, 0);
    const done = f.receive(['5000'], {
      planId: revised.id,
      expectedPlanVersion: revised.version,
      date: '2026-11-04',
      actualTime: '15:45',
    });
    assert.equal(done.arrival.id, p1.id);
    assert.equal(done.arrival.planSnapshot.plannedDate, '2026-11-04');
    assert.equal(done.arrival.planSnapshot.plannedTime, '15:30');
    assert.equal(done.arrival.actualTime, '15:45');
    assert.equal(f.flow.arrivalPlans({ date: '2026-11-04' })[0].receiptId, done.arrivalRecordId);
    assert.equal(f.flow.arrivalRecords()[0].planId, p1.id);
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
    assert.equal(f.ops.repo.items()[0].quantity, '5000');
    assert.throws(
      () =>
        f.flow.schedule(
          p1.id,
          {
            expectedVersion: done.arrival.version,
            plannedDate: '2026-11-05',
            requestId: randomUUID(),
          },
          actor,
        ),
      /待到货计划/,
    );
    const r2 = f.receive(['5000'], {
      planId: p2.id,
      expectedPlanVersion: p2.version,
      date: '2026-11-05',
      actualTime: null,
    });
    assert.equal(f.current().arrivalProgress, '全部到货');
    assert.equal(f.flow.arrivalRecords().length, 2);
    f.correct(
      f.current().receipts.find((r: any) => r.id === r2.arrivalRecordId),
      [{ index: 0, lineId: f.purchase.lines[0].id, quantity: '4000' }],
    );
    assert.equal(f.flow.arrivalPlans().length, 2);
    assert.equal(
      f.flow.arrivalPlans().find((p) => p.planSnapshot?.id === p2.id)?.status,
      'confirmed',
    );
    assert.equal(f.current().arrivalProgress, '部分到货');
  } finally {
    f.store.close();
  }
});

test('验收错误/超收/旧版本/同批次/重复请求均不产生半张单据或重复库存', () => {
  const f = fixture();
  try {
    for (const items of [
      [
        {
          lineId: f.purchase.lines[0].id,
          quantity: '100',
          acceptedQuantity: '90',
          rejectedQuantity: '20',
        },
      ],
      [
        {
          lineId: f.purchase.lines[0].id,
          quantity: '100',
          acceptedQuantity: '90',
          rejectedQuantity: '10',
          stockedQuantity: '100',
        },
      ],
    ]) {
      assert.throws(() => f.receive([], { items }), /验收|入库数量/);
      assert.equal(f.flow.list('arrival').length, 0);
      assert.equal(f.moves().length, 0);
    }
    const input = f.receiveInput(['5000'], { reference: '虚构唯一批次' }),
      result = f.flow.receivePurchase(input, actor);
    assert.equal(f.flow.receivePurchase(input, actor).arrival.id, result.arrival.id);
    assert.throws(
      () => f.flow.receivePurchase({ ...input, actualTime: '15:00' }, actor),
      /不同内容/,
    );
    assert.throws(
      () => f.flow.receivePurchase({ ...input, requestId: randomUUID() }, actor),
      /更新/,
    );
    assert.throws(() => f.receive(['5001']), /超过采购剩余/);
    assert.throws(() => f.receive(['100'], { reference: '虚构唯一批次' }), /同一供应商送货单号/);
    assert.equal(f.moves().length, 1);
    assert.equal(f.flow.list('arrival').length, 1);
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
  } finally {
    f.store.close();
  }
});

test('计划转实收的事务中断整体回滚，重试与服务回执恢复不会重复收货', () => {
  const f = fixture();
  try {
    const plan = f.flow.saveArrivalPlan(f.planInput(), actor).document,
      input = f.receiveInput(['5000'], { planId: plan.id, expectedPlanVersion: plan.version });
    const audits = f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n;
    f.store.db.exec(
      "CREATE TRIGGER reject_actual BEFORE UPDATE ON purchases BEGIN SELECT RAISE(ABORT,'fictional interrupted'); END",
    );
    assert.throws(() => f.flow.receivePurchase(input, actor), /fictional interrupted/);
    assert.equal(f.flow.get(plan.id).isPlan, true);
    assert.equal(f.flow.get(plan.id).version, plan.version);
    assert.equal(f.moves().length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n, audits);
    f.store.db.exec('DROP TRIGGER reject_actual');
    f.flow.receivePurchase(input, actor);
    assert.equal(f.flow.receivePurchase(input, actor).replayed, true);
    assert.equal(f.moves().length, 1);
  } finally {
    f.store.close();
  }
});

test('实际更正库存不足时保持全部数据，管理员仅统计编辑明确记录账实差异', () => {
  const f = fixture();
  try {
    f.receive();
    const stock = f.ops.repo.items()[0];
    f.ops.move(
      stock.id,
      {
        action: 'out',
        expectedVersion: stock.version,
        requestId: randomUUID(),
        quantity: '4500',
        date: '2026-10-29',
        notes: '虚构后续使用',
        acknowledged: true,
      },
      actor,
    );
    const record = f.current().receipts[0],
      before = f.moves();
    assert.throws(
      () =>
        f.correct(record, [
          { index: 0, lineId: record.correctionLines[0].lineId, quantity: '1000' },
        ]),
      /库存不足/,
    );
    assert.deepEqual(f.moves(), before);
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
    f.correct(
      record,
      [{ index: 0, lineId: record.correctionLines[0].lineId, quantity: '1000' }],
      'data-edit',
    );
    assert.deepEqual(f.moves(), before);
    assert.equal(f.current().lines[0].receivedQuantity, '1000');
    assert.equal(f.ops.repo.items()[0].quantity, '500');
    const saved = f.flow.arrivalRecords()[0];
    assert.equal(saved.lines[0].quantity, '1000');
    assert.equal(saved.lines[0].stockedQuantity, '5000');
    assert.equal(saved.discrepancies![0].status, '待核对差异');
  } finally {
    f.store.close();
  }
});

test('历史独立收货仅兼容展示，不补入库、不伪造实际时间或验收；后续正式更正进入arrival单据', () => {
  const f = fixture();
  try {
    legacyReceiptFixture(
      f.ops,
      f.purchase.id,
      {
        expectedVersion: f.current().version,
        requestId: randomUUID(),
        reference: '虚构历史批次',
        date: '2026-10-20',
        acknowledged: true,
        items: [{ lineId: f.purchase.lines[0].id, quantity: '5000' }],
      },
      actor,
    );
    const before = f.moves();
    assert.equal(f.flow.list('arrival').length, 0);
    const old = f.flow.arrivalRecords()[0];
    assert.equal(old.source, 'legacy');
    assert.equal(old.actualTime, null);
    assert.equal(old.inspectionStatus, '历史验收未记录');
    assert.equal(old.lines[0].stockedQuantity, '5000');
    assert.deepEqual(f.moves(), before);
    assert.equal(
      new AssistantTools(f.store).read('records.search', { module: 'arrivals' }, actor).total,
      1,
    );
    f.correct(f.current().receipts[0], [
      { index: 0, lineId: old.lines[0].lineId, quantity: '4000' },
    ]);
    assert.equal(f.flow.list('arrival').length, 1);
    assert.equal(f.flow.arrivalRecords().length, 2);
    assert.equal(f.current().lines[0].receivedQuantity, '4000');
    assert.equal(f.ops.repo.items()[0].quantity, '4000');
    assert.equal(f.flow.arrivalRecords().find((r) => r.effective)!.correctionOf, old.id);
  } finally {
    f.store.close();
  }
});

test('重开独立数据库后计划、正式到货、验收和关联流水持久一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-arrival-unified-')),
    file = join(dir, 'fictional.sqlite'),
    f = fixture(new Store(file));
  try {
    const p = f.flow.saveArrivalPlan(f.planInput(), actor).document;
    f.receive(['5000'], { planId: p.id, expectedPlanVersion: p.version });
    f.flow.saveArrivalPlan(f.planInput('5000'), actor);
    const before = f.flow.arrivalRecords(),
      plans = f.flow.arrivalPlans(),
      moves = f.moves();
    f.store.close();
    const store = new Store(file);
    try {
      const flow = new FlowService(store);
      assert.deepEqual(flow.arrivalRecords(), before);
      assert.deepEqual(flow.arrivalPlans(), plans);
      assert.deepEqual(
        store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all(),
        moves,
      );
      assert.equal(store.purchases()[0].lines[0].receivedQuantity, '5000');
      assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI实际到货与人工使用同一服务，唯一匹配连续查询、正式登记和核验，无额外确认或付费调用', async () => {
  const a = assistantFixture(),
    f = fixture(a.store);
  try {
    const input = f.receiveInput(['5000'], {
        items: [
          {
            lineId: f.purchase.lines[0].id,
            quantity: '5000',
            acceptedQuantity: '5000',
            rejectedQuantity: '0',
            stockedQuantity: '5000',
          },
        ],
      }),
      t = a.manager.create(actor);
    a.replies.push(
      {
        state: 'working',
        message: '查询采购与供应商',
        toolCalls: [
          {
            name: 'records.search',
            args: { module: 'purchases', filters: { supplierId: f.supplier.id } },
          },
        ],
      },
      {
        state: 'working',
        message: '登记全部合格实收到货',
        toolCalls: [{ name: 'arrival.receive', args: input }],
      },
      {
        state: 'working',
        message: '核对正式批次',
        toolCalls: [{ name: 'arrival.records', args: { purchaseId: f.purchase.id } }],
      },
      { state: 'completed', message: '完成', toolCalls: [] },
    );
    const result = await a.manager.chat(
      t.id,
      a.input('虚构春芳纸板厂今天下午两点送来了5000张纸板，全部合格入库。', randomUUID()),
      actor,
      'test',
      () => {},
      () => actor,
    );
    assert.match(result.messages.at(-1)!.text, /正式到货单/);
    assert.equal(f.flow.arrivalRecords().length, 1);
    assert.equal(f.flow.arrivalRecords()[0].actualTime, '14:00');
    assert.equal(f.ops.repo.items()[0].quantity, '5000');
    assert.equal(a.calls(), 4);
    const tools = new AssistantTools(f.store),
      registry = new AssistantToolRegistry();
    try {
      registry.set(
        { name: 'arrival.receive', enabled: false, expectedRevision: registry.view().revision },
        localAdministratorActor({ ...actor, role: 'super_admin' }),
      );
      await assert.rejects(
        () =>
          registry.dispatch('arrival.receive', f.receiveInput(), actor, {
            read: () => null,
            business: () => assert.fail('停用不可执行'),
            workflow: () => null,
          }),
        /停用/,
      );
      assert.throws(
        () =>
          tools.prepare('arrival.receive', f.receiveInput(), { ...actor, permissions: [] }, 's'),
        /权限/,
      );
    } finally {
      registry.close();
    }
  } finally {
    a.close();
  }
});

test('正式HTTP收货、排程、历史查询登录/CSRF/版本和别名入口一致', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:');
  const server = createApp(f.store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  try {
    assert.equal((await fetch(base + '/flow/arrival-records')).status, 401);
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构统一收货管理员', password: 'fictional-arrival-pass-123' }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const post = (path: string, input: any, csrf = auth.csrf) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-ERP-Auth-Token': csrf },
        body: JSON.stringify(input),
      });
    const p = await (await post('/flow/arrival-plans', f.planInput())).json();
    assert.equal(p.document.isPlan, true);
    assert.equal((await post('/flow/arrival-receive', f.receiveInput(), '')).status, 403);
    const input = f.receiveInput(['5000'], {
      planId: p.document.id,
      expectedPlanVersion: p.document.version,
    });
    const outcomes = await Promise.all([
      post('/flow/arrival-receive', input),
      post('/flow/arrival-receive', input),
    ]);
    assert.ok(outcomes.every((r) => r.status === 200));
    assert.equal(f.moves().length, 1);
    const list = await fetch(base + '/flow/arrival-records?purchaseId=' + f.purchase.id, {
      headers: { Cookie: cookie },
    });
    assert.equal((await list.json()).length, 1);
    assert.match(warehouseArrivalHash('#arrivals?doc=12'), /#warehouse\?.*arrivals=1/);
    assert.match(pageLink('arrivals'), /warehouse\?arrivals=1/);
    assert.match(pageLink('arrival_plans'), /arrivals=1/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    f.store.close();
  }
});
