// Codex 复审确认的问题：每条先按复审给的复现场景写成测试。内存库、虚构数据、模型替身。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { buildToday } from '../server/business/workbench.js';
import { orderNextSteps } from '../shared/order-next-step.js';
import { chatDeleteAuthorized, askedInChat } from '../server/assistant/task-routing.js';
import { AssistantExtraTools } from '../server/assistant/extra-tools.js';
import { MarkImportService } from '../server/marks/mark-import.js';
import { prepareArrivalRecognition } from '../server/flow/arrival-recognition.js';
import { productCandidatesForLine } from '../shared/import-matching.js';
import { matchMarkToProducts } from '../shared/mark-matching.js';
import { financeAmountsInYuan } from '../server/finance/assistant.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { financePermissions } from '../shared/finance.js';
import { analysisSchema } from '../shared/order-draft.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';
import { workflowAnalysis } from './assistant-workflow-fixture.js';

const admin = localAdministratorActor({
  id: 'fixture-owner',
  name: '虚构维护',
  role: 'super_admin',
  permissions: ['business:edit'],
  superAdminMode: true,
  superAdminUntil: Date.now() + 3600000,
});

test('1. 删聊天：否定、撤销、否定的确认都不算；明确要删后面附带问句仍算', () => {
  for (const text of [
    '不删除聊天记录',
    '取消删除聊天记录',
    '暂时保留聊天记录，不清空',
    '聊天记录先不删',
    '别把会话清空',
    '不要删聊天记录',
    '怎么删聊天记录？',
    '能不能把聊天记录删了？',
  ])
    assert.equal(chatDeleteAuthorized(text), false, text);
  assert.equal(chatDeleteAuthorized('确认不执行', '把其他聊天记录删掉'), false);
  assert.equal(chatDeleteAuthorized('好的，先别删', '把其他聊天记录删掉'), false);
  assert.equal(chatDeleteAuthorized('好的', '不删除聊天记录'), false);
  assert.equal(chatDeleteAuthorized('确认', '把其他聊天记录删掉'), true);
  assert.equal(chatDeleteAuthorized('好的，删吧', '能不能把聊天记录删了？'), true);
  assert.equal(chatDeleteAuthorized('把聊天记录删了，告诉我怎么恢复'), true);
  assert.equal(chatDeleteAuthorized('把其他聊天记录都删掉，当前这个留着'), true);
  assert.equal(askedInChat(/移除.{0,8}唛头/, '先不要移除这份唛头'), false);
  assert.equal(askedInChat(/移除.{0,8}唛头/, '移除这份唛头'), true);
});

const profileA = { id: 'a', endpoint: 'https://a.example.invalid/v1', model: 'fictional-a', apiStyle: 'responses' };
const profileB = { ...profileA, id: 'b', endpoint: 'https://b.example.invalid/v1' };

test('2. 唛头识别带上本条消息确认的模型；读原件期间换了配置就停下', async () => {
  const store = new Store(':memory:');
  try {
    let captured: any;
    const tools = new AssistantExtraTools(store, {} as any);
    tools.imports = {
      get: () => ({ id: 'w', mode: 'mark', revision: 1 }),
      setMode: () => {},
      markReview: () => null,
    } as any;
    tools.marks = {
      recognize: async (_id: string, raw: any) => {
        captured = raw;
      },
      summary: () => ({}),
      ai: { abort: () => {} },
    } as any;
    await tools.call(
      'marks.recognize',
      { workspaceId: randomUUID() },
      {
        threadId: randomUUID(),
        actor: admin,
        requestId: randomUUID(),
        text: '',
        files: [],
        profile: profileA,
        check: () => admin,
        signal: new AbortController().signal,
        emit: () => {},
      } as any,
    );
    assert.deepEqual(captured.profile, profileA);

    let active: any = { ...profileA, hasApiKey: true };
    const service = new MarkImportService(
      {
        get: () => ({ id: 'w', mode: 'mark', revision: 1 }),
        markReview: () => null,
        original: async () => {
          active = { ...profileB, hasApiKey: true };
          return { bytes: new Uint8Array([1]), fileName: '虚构唛头.png' };
        },
      } as any,
      {
        settings: { view: () => ({ active }) },
        store,
        upload: () => {
          throw new Error('不该外发');
        },
      } as any,
    );
    await assert.rejects(
      service.recognize('w', { profile: profileA }, () => admin),
      /AI配置已变化/,
    );
  } finally {
    store.close();
  }
});

test('2. 到货识别同样核对配置，读原件期间换了就停下', async () => {
  let active: any = { ...profileA, hasApiKey: true };
  await assert.rejects(
    prepareArrivalRecognition(
      {
        get: () => ({ id: 'w', mode: 'arrival', revision: 1, arrivalDocId: null }),
        original: async () => {
          active = { ...profileB, hasApiKey: true };
          return { bytes: new Uint8Array([1]), fileName: '虚构到货单.png' };
        },
      } as any,
      {
        settings: { view: () => ({ active }) },
        upload: () => {
          throw new Error('不该外发');
        },
      } as any,
      'w',
      admin,
      { profile: profileA },
    ),
    /AI配置已变化/,
  );
});

test('3. 名称包含但数字不同、或多出说明文字的，只列候选不自动对应', () => {
  const store = new Store(':memory:');
  try {
    const save = (name: string) =>
      store.saveProduct(
        productSchema.parse({ name, length: 10, width: 20, height: 30, dimensionUnit: 'cm' }),
      );
    const line = (name: string) => {
      const a = analysisSchema.parse(workflowAnalysis());
      const fields = a.lines[0];
      for (const [key, value] of Object.entries({
        productName: name,
        specification: '',
        length: '10',
        width: '20',
        height: '30',
        dimensionUnit: 'cm',
        material: '',
        flute: '',
        productCode: '',
      }))
        (fields as any)[key].value = value;
      return { id: randomUUID(), fields };
    };
    const one = save('虚构纸箱1');
    const plain = save('虚构纸箱甲');
    const pick = (name: string, p: any) =>
      productCandidatesForLine(line(name) as any, [p]).find((c) => c.id === p.id);
    assert.equal(pick('虚构纸箱10', one)?.recommended, false, '1 和 10 是两个货');
    assert.equal(pick('虚构纸箱甲加厚', plain)?.recommended, false, '加厚是另一款');
    assert.equal(pick('虚构纸箱甲（虚构渠道）', plain)?.recommended, true, '只差括号说明还是同一个');
  } finally {
    store.close();
  }
});

test('4. 唛头同名但两边料号明确不同，不自动挂', () => {
  const [candidate] = matchMarkToProducts(
    { productName: '虚构纸箱', itemCode: 'B-002' } as any,
    [{ id: 1, name: '虚构纸箱', customerProductCode: 'A-001' } as any],
  );
  assert.equal(candidate.recommended, false);
  assert.ok(candidate.conflicts.includes('料号不同'));
  const [same] = matchMarkToProducts(
    { productName: '虚构纸箱', itemCode: 'A-001' } as any,
    [{ id: 1, name: '虚构纸箱', customerProductCode: 'A-001' } as any],
  );
  assert.equal(same.recommended, true);
});

function flowFixture() {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' })),
    supplier = ops.saveSupplier({ name: '虚构供应商' }, admin),
    raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, admin),
    finished = ops.saveItem(
      { name: '虚构成品', kind: 'finished', unit: '只', productId: product.id },
      admin,
    ),
    boxes = ops.saveItem(
      { name: '虚构成品箱', kind: 'finished', unit: '箱', productId: product.id },
      admin,
    );
  const confirm = (kind: any, input: any) => {
    const d = flow.save(kind, { date: '2026-10-27', ...input }, admin),
      p = flow.preview(d.id, admin, 's');
    return flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      admin,
      's',
    );
  };
  confirm('arrival', {
    supplierId: supplier.id,
    reference: randomUUID(),
    lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '100' }],
  });
  const order = (lines: number[]) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-12-30',
        status: '已确认',
        lines: lines.map((quantity) => ({
          productId: product.id,
          quantity,
          unit: '只',
          unitPriceCents: 100,
        })),
      }),
    );
  const make = (orderIds: number[], quantity: string, unit = '只') => {
    const task = confirm('task', {
      productId: product.id,
      quantity,
      unit,
      orderIds,
      plannedDate: '2026-10-27',
    });
    confirm('production', {
      taskId: task.id,
      productId: product.id,
      finishedStockId: unit === '只' ? finished.id : boxes.id,
      goodQuantity: quantity,
      operator: '虚构员工',
      materials: [{ stockId: raw.id, issued: '1', returned: '0' }],
    });
    return task;
  };
  const steps = (id: number) =>
    orderNextSteps(store.order(id), {
      tasks: flow.list('task').filter((t: any) => t.orderIds.includes(id)),
      stocks: ops.repo.items(),
      deliveries: [],
      purchases: [],
    });
  const unscheduled = (id: number) =>
    buildToday(store, '2026-10-27').unscheduled.some((o: any) => o.id === id);
  return { store, order, make, steps, unscheduled };
}

test('5. 同产品两行各 100，只做了 100：不算做完，要提醒再排 100', () => {
  const f = flowFixture();
  try {
    const o = f.order([100, 100]);
    f.make([o.id], '100');
    assert.equal(f.store.order(o.id)!.status, '生产中');
    assert.ok(f.unscheduled(o.id));
    const schedule = f.steps(o.id).steps.filter((s) => s.kind === 'schedule');
    assert.equal(schedule.length, 1, '同一产品只提醒一次');
    assert.equal(schedule[0].params?.quantity, '100');
  } finally {
    f.store.close();
  }
});

test('5. 一张任务挂两张单，各要 100 只做了 100：两张都不算做完；做够 200 才算', () => {
  const f = flowFixture();
  try {
    const a = f.order([100]),
      b = f.order([100]);
    f.make([a.id, b.id], '100');
    assert.equal(f.store.order(a.id)!.status, '生产中');
    assert.equal(f.store.order(b.id)!.status, '生产中');
    assert.ok(f.unscheduled(a.id) && f.unscheduled(b.id));
    f.make([a.id, b.id], '100');
    assert.equal(f.store.order(a.id)!.status, '待发货');
    assert.equal(f.store.order(b.id)!.status, '待发货');
  } finally {
    f.store.close();
  }
});

test('6. 任务按箱做、订单按只要：不换算，不算做完，并说明单位不同', () => {
  const f = flowFixture();
  try {
    const o = f.order([100]);
    f.make([o.id], '100', '箱');
    assert.equal(f.store.order(o.id)!.status, '生产中');
    assert.ok(f.unscheduled(o.id));
    const next = f.steps(o.id);
    assert.ok(next.steps.some((s) => s.kind === 'schedule'));
    assert.ok(next.notes.some((n) => n.includes('箱') && n.includes('只')));
    assert.equal(next.lines[0].production, 'none', '箱的数量不算进只');
  } finally {
    f.store.close();
  }
});

test('7. 财务金额：paid、linked、creditLimit 换成元，编号不换', () => {
  const out: any = financeAmountsInYuan({
    paid: 11300,
    linked: 11300,
    creditLimit: 11300,
    amount: 11300,
    id: 5,
    party_id: 7,
    voucherId: 9,
    quantity_units: 1000,
  });
  assert.equal(out.paid, '113.00');
  assert.equal(out.linked, '113.00');
  assert.equal(out.creditLimit, '113.00');
  assert.equal(out.amount, '113.00');
  assert.equal(out.id, 5);
  assert.equal(out.party_id, 7);
  assert.equal(out.voucherId, 9);
  assert.equal(out.quantity_units, 1000);
});

test('8. 部分红票按累计分摊释放额度，合计正好等于红票额', () => {
  const store = new Store(':memory:');
  try {
    const maker = {
      id: 'maker',
      name: '虚构制单员',
      role: 'super_admin' as const,
      permissions: [...financePermissions, 'business:edit'],
    };
    const settings = new FinanceSettings(store);
    settings.enable(maker, { period: '2026-02', taxpayer: 'general', version: 1, requestId: 'e', rows: [] });
    store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
    const obligation = (cents: number) =>
      Number(
        store.db
          .prepare(
            "INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description) VALUES('receivable','1','虚构客户','2026-02-10',?,'虚构送货')",
          )
          .run(cents).lastInsertRowid,
      );
    const small = obligation(1),
      large = obligation(99);
    const invoices = new FinanceInvoices(store);
    const bill = (extra: Record<string, unknown>) =>
      ({ direction: 'sale', type: '虚构数电票', partyId: 1, rate: '0', tax: 0, ...extra }) as any;
    const blue = invoices.create(
      maker,
      bill({ requestId: 'b', number: 'B-1', date: '2026-02-10', net: 100, gross: 100 }),
    );
    invoices.link(maker, blue.id, {
      version: 1,
      requestId: 'l',
      links: [
        { obligationId: small, amount: 1 },
        { obligationId: large, amount: 99 },
      ],
    });
    invoices.confirm(maker, blue.id, { version: 2, requestId: 'bc' });
    const red = invoices.create(
      maker,
      bill({ requestId: 'r', number: 'R-1', date: '2026-02-11', net: -1, gross: -1, originalId: blue.id }),
    );
    invoices.confirm(maker, red.id, { version: 1, requestId: 'rc' });
    const rows = invoices.unmatched(maker, { kind: 'receivable' }).rows as any[];
    const total = rows
      .filter((r) => [small, large].includes(r.id))
      .reduce((n, r) => n + Number(r.invoiced || 0), 0);
    assert.equal(total, 99, '开了 100，红冲 1，还占 99');
  } finally {
    store.close();
  }
});

test('升级时按新规则把老订单状态重算一次：只改变了的，记审计，只跑一次', () => {
  const f = flowFixture();
  try {
    const stale = f.order([100, 100]);
    f.make([stale.id], '100');
    const fine = f.order([100]);
    f.make([fine.id], '100');
    // 模拟旧规则留下的状态：只做了一半也标成了待发货
    f.store.db.prepare("UPDATE orders SET status='待发货' WHERE id=?").run(stale.id);
    const versionOf = (id: number) =>
      Number(f.store.db.prepare('SELECT version FROM orders WHERE id=?').get(id)!.version);
    const fineVersion = versionOf(fine.id);
    const flow = new FlowService(f.store);
    const changed = flow.recomputeOrderStatusesOnce('fixture-marker');
    assert.deepEqual(
      changed?.map((c) => [c.id, c.from, c.to]),
      [[stale.id, '待发货', '生产中']],
    );
    assert.equal(f.store.order(stale.id)!.status, '生产中');
    assert.equal(versionOf(fine.id), fineVersion, '状态没变的不动版本号');
    const audits = f.store.db
      .prepare("SELECT document FROM business_audit WHERE action='recompute-order-status'")
      .all();
    assert.equal(audits.length, 1);
    assert.equal(JSON.parse(String(audits[0].document)).changed[0].to, '生产中');
    assert.equal(flow.recomputeOrderStatusesOnce('fixture-marker'), null, '跑过就不再跑');
    f.store.db.prepare("UPDATE orders SET status='待发货' WHERE id=?").run(stale.id);
    assert.equal(flow.recomputeOrderStatusesOnce('fixture-marker'), null);
    assert.equal(f.store.order(stale.id)!.status, '待发货', '第二次没有再改');
  } finally {
    f.store.close();
  }
});

test('第二轮审查：发票再加一条关联时，原来带数量和单位的关联原样保留', () => {
  const store = new Store(':memory:');
  try {
    const maker = {
      id: 'maker',
      name: '虚构制单员',
      role: 'super_admin' as const,
      permissions: [...financePermissions, 'business:edit'],
    };
    new FinanceSettings(store).enable(maker, { period: '2026-02', taxpayer: 'general', version: 1, requestId: 'e', rows: [] });
    store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
    const obligation = () =>
      Number(
        store.db
          .prepare(
            "INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description) VALUES('receivable','1','虚构客户','2026-02-10',5000,'虚构送货')",
          )
          .run().lastInsertRowid,
      );
    const first = obligation(),
      second = obligation();
    const invoices = new FinanceInvoices(store);
    const blue = invoices.create(maker, {
      requestId: 'b', direction: 'sale', type: '虚构数电票', partyId: 1, rate: '0', tax: 0,
      number: 'B-1', date: '2026-02-10', net: 10000, gross: 10000,
    } as any);
    invoices.link(maker, blue.id, {
      version: 1, requestId: 'l1', links: [{ obligationId: first, amount: 5000, quantity: '12.5', unit: '只' }],
    });
    const view: any = invoices.get(maker, blue.id);
    assert.equal(view.links[0].quantity, '12.5', '返回给页面的是数量文字');
    // 照页面的做法：原有关联原样带回，再加一条
    invoices.link(maker, blue.id, {
      version: view.invoice.version,
      requestId: 'l2',
      links: [
        ...view.links.map((l: any) => ({
          obligationId: l.obligation_id,
          amount: l.amount_cents,
          ...(l.quantity != null && l.unit ? { quantity: l.quantity, unit: l.unit } : {}),
        })),
        { obligationId: second, amount: 5000 },
      ],
    });
    const after: any = invoices.get(maker, blue.id);
    assert.equal(after.links.length, 2);
    assert.equal(after.links[0].quantity, '12.5');
    assert.equal(after.links[0].unit, '只');
  } finally {
    store.close();
  }
});

test('第二轮审查：维护已确认的生产任务，产品名和确认信息不丢', () => {
  const f = flowFixture();
  try {
    const o = f.order([100]);
    const task = f.make([o.id], '100');
    const flow = new FlowService(f.store);
    const before: any = flow.get(task.id);
    assert.ok(before.confirmedBy && before.productName);
    flow.developerUpdateTask(
      task.id,
      {
        version: before.version, date: before.date, productId: before.productId, quantity: '120',
        unit: before.unit, orderIds: before.orderIds, plannedDate: before.plannedDate,
      },
      admin,
    );
    const after: any = flow.get(task.id);
    assert.equal(after.quantity, '120');
    assert.equal(after.productName, before.productName);
    assert.equal(after.confirmedBy, before.confirmedBy);
    assert.equal(after.confirmedAt, before.confirmedAt);
  } finally {
    f.store.close();
  }
});

test('第二轮审查：多产品订单里，已经做好且库存够的产品不再提醒排产', () => {
  const line = (id: number, productId: number, remainingQuantity: number) => ({
    id, productId, productName: '虚构箱' + id, quantity: remainingQuantity, remainingQuantity, unit: '只',
  });
  const order = { id: 9, status: '生产中', lines: [line(1, 1, 100), line(2, 2, 50)] };
  const next = orderNextSteps(order, {
    tasks: [
      { id: 1, number: 'SC-1', productId: 1, quantity: '100', completed: '100', unit: '只', status: 'confirmed' },
      { id: 2, number: 'SC-2', productId: 2, quantity: '50', completed: '10', unit: '只', status: 'confirmed' },
    ],
    stocks: [{ productId: 1, unit: '只', availableUnits: 100000 }],
    deliveries: [],
    purchases: [],
  });
  assert.equal(next.steps.some((s) => s.kind === 'schedule'), false, 'A 已做好够发，B 还在做');
  assert.ok(next.steps.some((s) => s.kind === 'delivery'));
});
