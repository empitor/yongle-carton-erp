// 代码审查确认的问题：先复现再修。全部用内存库、临时目录和虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { ImportManager } from '../server/import/manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { MarkService } from '../server/marks/service.js';
import { PermanentDeletionService } from '../server/business/permanent-deletion.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import {
  DevelopmentResetService,
  financeResetTables,
} from '../server/business/development-reset.js';
import { createBusinessService } from '../server/business/service.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { ReceiptAi } from '../server/flow/receipt-ai.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceSettlements } from '../server/finance/settlements.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { periodJob } from '../server/finance/jobs.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { financePermissions } from '../shared/finance.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { AssistantExtraTools } from '../server/assistant/extra-tools.js';
import { chatDeleteAuthorized, askedInChat } from '../server/assistant/task-routing.js';
import { matchMarkToProducts } from '../shared/mark-matching.js';
import { exactText } from '../shared/precision.js';
import { safeFileName } from '../server/inbox/wecom-bot.js';
import { customerSchema, orderDisplayStatus, orderSchema, productSchema } from '../shared/domain.js';
import { buildToday } from '../server/business/workbench.js';
import { orderNextSteps } from '../shared/order-next-step.js';
import { makeSettings, superActor as fixtureSuperActor } from './assistant-fixture.js';

const who = () =>
  localAdministratorActor({
    id: 'fixture-owner',
    name: '虚构维护',
    role: 'super_admin',
    permissions: ['business:edit'],
    superAdminMode: true,
    superAdminUntil: Date.now() + 3600000,
  });

async function webFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-review-'));
  const store = new Store(':memory:'),
    settings = makeSettings((async () => ({})) as any),
    imports = new ImportManager({
      directory: join(dir, 'imports'),
      settings,
      promptPresets: new PromptPresetManager(':memory:'),
    }),
    auth = new AuthManager(':memory:'),
    server = createApp(store, { auth, aiSettings: settings, imports }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  const send = (path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];
  const admin = cookieOf(
    await send('/auth/setup', { name: '虚构管理员', password: 'Fictional-admin-123' }),
  );
  const account = async (name: string, level: string) => {
    const password = 'Fictional-account-1';
    await send('/auth/apply', { name, password, note: '虚构' });
    const { requests } = await (await send('/auth/requests', undefined, admin)).json();
    const request = requests.find((r: any) => r.name === name);
    assert.equal(
      (await send('/auth/requests/' + request.id + '/approve', { level }, admin)).status,
      200,
    );
    return cookieOf(await send('/auth/login', { name, password }));
  };
  const stop = async () => {
    await new Promise((r) => server.close(r));
    auth.close();
    store.close();
    // 导入工作区的库还开着，Windows 删不掉；留给系统临时目录清理。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { send, admin, account, settings, imports, stop, base };
}

test('只读和业务账号不能改 AI 设置；只读账号不能动导入工作区和提示词', async () => {
  const f = await webFixture();
  try {
    const viewer = await f.account('虚构只读', 'viewer'),
      staff = await f.account('虚构业务', 'staff');
    const settingsToken = { 'X-ERP-AI-Token': f.settings.csrfToken },
      importToken = { 'X-ERP-AI-Token': f.imports.csrfToken };
    for (const cookie of [viewer, staff])
      assert.equal(
        (await f.send('/ai/settings/delete', { id: 'x' }, cookie, settingsToken)).status,
        403,
        'AI 设置只有管理员能改',
      );
    assert.notEqual(
      (await f.send('/ai/settings/delete', { id: 'x' }, f.admin, settingsToken)).status,
      403,
    );
    // 能读当前配置，聊天要用
    assert.equal((await f.send('/ai/settings', undefined, viewer)).status, 200);

    const upload = await fetch(f.base + '/ai/imports/upload', {
      method: 'POST',
      headers: {
        Cookie: viewer,
        'Content-Type': 'application/octet-stream',
        'X-ERP-Auth-Token': 'x',
        'X-File-Name': encodeURIComponent('虚构.png'),
        'X-Upload-Id': randomUUID(),
        ...importToken,
      },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(upload.status, 403, '只读账号不能上传');
    assert.equal(
      (await f.send('/ai/imports/' + randomUUID() + '/remove', {}, viewer, importToken)).status,
      403,
      '只读账号不能删工作区',
    );
    assert.equal((await f.send('/ai/prompts/activate', {}, viewer, importToken)).status, 403);
    assert.equal((await f.send('/ai/imports', undefined, viewer)).status, 200, '可以看');
  } finally {
    await f.stop();
  }
});

test('删聊天授权：否定和询问不算，确认要接在真的要删后面', () => {
  assert.equal(chatDeleteAuthorized('把聊天记录删了'), true);
  assert.equal(chatDeleteAuthorized('确认', '把其他聊天记录都删掉'), true);
  assert.equal(chatDeleteAuthorized('确认', '能不能把聊天记录删了？'), true);
  for (const text of [
    '不要删聊天记录',
    '别清空会话',
    '先别删这些聊天记录',
    '聊天记录不用删',
    '怎么删聊天记录？',
    '如何清除会话',
    '我不清楚聊天记录在哪',
    '能不能把聊天记录删了？',
  ])
    assert.equal(chatDeleteAuthorized(text), false, text);
  assert.equal(chatDeleteAuthorized('好的', '不要删聊天记录'), false);
  assert.equal(chatDeleteAuthorized('好的', '怎么删聊天记录？'), false);
  assert.equal(askedInChat(/移除.{0,8}唛头/, '先不要移除这份唛头'), false);
});

test('纯括号款号不会因为去括号后都是空串而对应上', () => {
  const product = { id: 1, name: '虚构箱', customerProductCode: '(B款)' } as any;
  assert.deepEqual(matchMarkToProducts({ itemCode: '(A款)' } as any, [product]), []);
});

test('exactText 负数不错位，文件名不超过下游 180 字', () => {
  assert.equal(exactText(-15000n), '-1.5000');
  assert.equal(exactText(-5n), '-0.0005');
  const name = safeFileName('虚'.repeat(300) + '.pdf', 'x');
  assert.ok(name.length <= 180);
  assert.ok(name.endsWith('.pdf'));
});

function businessFixture() {
  const store = new Store(':memory:'),
    actor = who(),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' })),
    supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
    raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor),
    glue = ops.saveItem({ name: '虚构胶水', kind: 'raw', unit: '公斤' }, actor),
    finished = ops.saveItem(
      { name: '虚构成品', kind: 'finished', unit: '只', productId: product.id },
      actor,
    );
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-30',
      status: '已确认',
      lines: [{ productId: product.id, quantity: 1000, unit: '只', unitPriceCents: 100 }],
    }),
  );
  const confirm = (kind: any, input: any) => {
    const d = flow.save(kind, { date: '2026-10-27', ...input }, actor),
      p = flow.preview(d.id, actor, 's');
    return flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      actor,
      's',
    );
  };
  const arrival = (quantity: string) =>
    confirm('arrival', {
      supplierId: supplier.id,
      reference: randomUUID(),
      lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity }],
    });
  const task = (quantity: string) =>
    confirm('task', {
      productId: product.id,
      quantity,
      unit: '只',
      orderIds: [order.id],
      plannedDate: '2026-10-27',
    });
  const production = (taskId: number, goodQuantity: string) =>
    confirm('production', {
      taskId,
      productId: product.id,
      finishedStockId: finished.id,
      goodQuantity,
      operator: '虚构员工',
      materials: [{ stockId: raw.id, issued: '10', returned: '0' }],
    });
  return {
    store,
    actor,
    ops,
    flow,
    customer,
    product,
    supplier,
    raw,
    glue,
    finished,
    order,
    confirm,
    arrival,
    task,
    production,
  };
}

test('采购进度按明细行判断，不把张和公斤加在一起', () => {
  const f = businessFixture();
  try {
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        customerOrderId: f.order.id,
        orderDate: '2026-10-01',
        status: '已订货',
        lines: [
          { stockItemId: f.raw.id, name: f.raw.name, quantity: '100', unit: '张' },
          { stockItemId: f.glue.id, name: f.glue.name, quantity: '100', unit: '公斤' },
        ],
      },
      f.actor,
    );
    // 历史数据里有超收：第一行多到 100 张，第二行一公斤没到。按总量相加会误报“全部到货”。
    f.store.db
      .prepare('UPDATE purchase_lines SET received_units=200000 WHERE id=?')
      .run(purchase.lines[0].id);
    assert.equal((f.store.order(f.order.id) as any).materialProgress, 'partial');
  } finally {
    f.store.close();
  }
});

test('只做完一部分的生产任务不算待发货，做够了才算', () => {
  const f = businessFixture();
  try {
    f.arrival('100');
    const t = f.task('100');
    f.production(t.id, '100');
    assert.equal(f.store.order(f.order.id)!.status, '生产中', '订单要 1000，只做了 100');
    const more = f.task('900');
    f.production(more.id, '900');
    assert.equal(f.store.order(f.order.id)!.status, '待发货');
  } finally {
    f.store.close();
  }
});

test('分批做分批发：今天做一半发一半是部分发货，明天做完发完才是已发货', () => {
  const f = businessFixture();
  const date = '2026-10-27';
  try {
    const order = () => f.store.order(f.order.id)!;
    const shown = () => orderDisplayStatus(order());
    const today = () => buildToday(f.store, date);
    const has = (rows: any[]) => rows.some((o) => o.id === f.order.id);
    const steps = () =>
      orderNextSteps(order(), {
        tasks: f.flow.list('task'),
        stocks: f.ops.repo.items(),
        deliveries: [],
        purchases: [],
      }).steps;
    const ship = (quantity: string) =>
      f.confirm('delivery', {
        customerId: f.customer.id,
        lines: [
          { orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.finished.id, quantity },
        ],
      });
    f.arrival('100');
    const first = f.task('500');
    f.production(first.id, '500');
    assert.equal(shown(), '生产中');
    assert.ok(has(today().ready), '做好一批就能发，不用等全部做完');
    assert.ok(has(today().unscheduled), '还差 500 没排');

    ship('500');
    assert.equal(order().shippingProgress, '部分发货');
    assert.equal(shown(), '部分发货');
    assert.equal(today().ready.some((o: any) => o.id === f.order.id), false, '货发完了，没有可发的');
    assert.ok(has(today().unscheduled), '发了一半，剩下的还没排');
    const next = steps().find((s) => s.kind === 'schedule');
    assert.equal(next?.params?.quantity, '500', '预填还差的数量');

    const second = f.task('500');
    assert.equal(has(today().unscheduled), false, '排上了就不再提醒');
    assert.equal(steps().some((s) => s.kind === 'schedule'), false);
    assert.equal(shown(), '部分发货', '第二批在做，仍然是发了一半');

    f.production(second.id, '500');
    assert.equal(order().status, '待发货');
    assert.equal(shown(), '部分发货');
    assert.ok(has(today().ready));

    ship('500');
    assert.equal(order().status, '已发货');
    assert.equal(shown(), '已发货');
  } finally {
    f.store.close();
  }
});

test('删除完工单后订单状态跟着重算，保留库存时改写流水要留修订', () => {
  const f = businessFixture();
  try {
    f.arrival('100');
    const t = f.task('1000');
    const done = f.production(t.id, '1000');
    assert.equal(f.store.order(f.order.id)!.status, '待发货');
    const service = new DatabaseMaintenanceService(f.store);
    const del = (module: string, row: any, inventoryPolicy: string) => {
      const selection = { module, items: [{ id: row.id, version: row.version }], inventoryPolicy },
        p = service.preview(selection as any, f.actor);
      return service.delete(
        { ...selection, requestId: randomUUID(), deletionDigest: p.digest } as any,
        f.actor,
        's',
      );
    };
    const revisions = () =>
      Number(f.store.db.prepare('SELECT count(*) AS n FROM stock_movement_revisions').get()!.n);
    const before = revisions();
    del('production', f.flow.get(done.id), 'preserve');
    assert.equal(f.store.order(f.order.id)!.status, '生产中');
    assert.ok(revisions() > before, '保留的流水被改写，要留修订记录');
  } finally {
    f.store.close();
  }
});

test('订单换客户拆分送货单时，保留确认时的明细快照', () => {
  const f = businessFixture();
  try {
    f.arrival('100');
    const t = f.task('1000');
    f.production(t.id, '1000');
    const second = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        number: '虚构共享送货订单',
        lines: f.order.lines.map(({ id, ...l }: any) => l),
      }),
    );
    const delivery = f.confirm('delivery', {
      customerId: f.customer.id,
      lines: [f.order, second].map((o) => ({
        orderId: o.id,
        orderLineId: o.lines[0].id,
        stockId: f.finished.id,
        quantity: '100',
      })),
    });
    const snapshot = delivery.lines.find((l: any) => l.orderId === f.order.id);
    assert.ok(snapshot.amountExact, '确认时应有金额快照');
    const revisions = () =>
      Number(f.store.db.prepare('SELECT count(*) AS n FROM stock_movement_revisions').get()!.n);
    const movementsBefore = revisions();
    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构新客户' }));
    const current = f.store.order(f.order.id)!;
    createBusinessService(f.store).execute(
      {
        entity: 'orders',
        action: 'update',
        id: current.id,
        input: { ...current, customerId: other.id },
      } as any,
      { source: 'manual-ui', operatorId: f.actor.id, superAdminMode: true, developerActor: f.actor },
    );
    const moved = f.flow.list('delivery').find((d: any) => d.customerId === other.id)!;
    const line = moved.lines[0];
    assert.equal(line.amountExact, snapshot.amountExact);
    assert.equal(line.unitPriceExact, snapshot.unitPriceExact);
    assert.equal(line.productName, snapshot.productName);
    assert.ok(revisions() > movementsBefore, '改写了流水归属，要留修订记录');
  } finally {
    f.store.close();
  }
});

test('送货单导出金额修剪尾零，没有金额才写未记录', () => {
  const f = businessFixture();
  try {
    f.arrival('100');
    const t = f.task('1000');
    f.production(t.id, '1000');
    const delivery = f.confirm('delivery', {
      customerId: f.customer.id,
      lines: [
        {
          orderId: f.order.id,
          orderLineId: f.order.lines[0].id,
          stockId: f.finished.id,
          quantity: '100',
        },
      ],
    });
    const docs = new BusinessDocuments(f.store) as any;
    const { form } = docs.rawForm('delivery', delivery.id);
    assert.equal(form.lineData[0].amount, '100.00');
  } finally {
    f.store.close();
  }
});

test('带唛头的产品可以永久删除，唛头一起清掉', () => {
  const store = new Store(':memory:');
  try {
    const actor = who();
    const superActor = fixtureSuperActor();
    const product = store.saveProduct(productSchema.parse({ name: '虚构带唛头产品' }));
    new MarkService(store).add(
      {
        productId: product.id,
        bytes: new Uint8Array([9, 9]),
        name: '虚构.png',
        mime: 'image/png',
        fields: {},
        sourceKind: 'manual',
      },
      actor,
    );
    const permanent = new PermanentDeletionService(store);
    const { id: previewId } = permanent.preview(
      { entity: 'products', items: [{ id: product.id, version: product.version }] },
      superActor,
      's',
    ) as any;
    permanent.execute({ previewId, acknowledged: true, confirmation: '永久删除' }, superActor, 's');
    assert.equal(store.product(product.id, true), undefined);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM product_marks').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mark_files').get()!.n, 0);
  } finally {
    store.close();
  }
});

test('从产品上移除唛头前留快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-review-'));
  const store = new Store(join(dir, 'erp.sqlite'));
  try {
    const actor = who();
    const product = store.saveProduct(productSchema.parse({ name: '虚构带唛头产品' }));
    const marks = new MarkService(store);
    const mark = marks.add(
      {
        productId: product.id,
        bytes: new Uint8Array([9, 9]),
        name: '虚构.png',
        mime: 'image/png',
        fields: {},
        sourceKind: 'manual',
      },
      actor,
    );
    marks.remove(mark.id, { expectedVersion: mark.version }, actor);
    const snapshots = readdirSync(dir, { recursive: true }).filter((f) =>
      /erp-.*\.sqlite$/.test(String(f)),
    );
    assert.equal(snapshots.length, 1);
    assert.ok(existsSync(join(dir, String(snapshots[0]))));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('到货识别不复用唛头的识别记录', () => {
  const store = new Store(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'erp-review-'));
  try {
    store.db
      .prepare('INSERT INTO flow_sources VALUES(?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        '虚构唛头.png',
        'a'.repeat(64),
        'png',
        new Uint8Array([1]),
        JSON.stringify({ result: null, kind: 'shipping-mark' }),
        'fixture',
        new Date().toISOString(),
      );
    const ai = new ReceiptAi(store, makeSettings((async () => ({})) as any), new PromptPresetManager(':memory:'));
    assert.deepEqual(ai.sources(), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const financeActor = {
  id: 'maker',
  name: '虚构制单员',
  role: 'super_admin' as const,
  permissions: [...financePermissions, 'business:edit'],
};
function financeFixture(period = '2026-01') {
  const store = new Store(':memory:');
  const settings = new FinanceSettings(store);
  settings.enable(financeActor, {
    period,
    taxpayer: 'general',
    version: 1,
    requestId: 'enable',
    rows: [],
  });
  settings.update(financeActor, {
    version: 2,
    requestId: 'rates',
    taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 },
  });
  return store;
}

test('清空业务数据连同往来条款、资金账户和导入模板一起清', () => {
  const store = financeFixture();
  try {
    assert.ok(financeResetTables.includes('fin_party_terms' as any));
    assert.ok(financeResetTables.includes('fin_cash_accounts' as any));
    assert.ok(financeResetTables.includes('fin_mapping_profiles' as any));
    new FinanceSettlements(store).saveAccount(financeActor, {
      kind: 'bank',
      name: '虚构资金账户',
      accountCode: '1002',
      lastFour: '0001',
      requestId: 'bank',
    });
    const actor = who();
    new DevelopmentResetService(store).execute('business', actor);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM fin_cash_accounts').get()!.n, 0);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.close();
  }
});

test('助手清空业务数据时，财务已有记录就拒绝，不留孤儿也不替财务写入', () => {
  const store = financeFixture();
  try {
    const actor = who();
    new FinanceSettlements(store).saveAccount(financeActor, {
      kind: 'bank',
      name: '虚构资金账户',
      accountCode: '1002',
      lastFour: '0001',
      requestId: 'bank',
    });
    store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
    const tools = new AssistantTools(store);
    assert.throws(
      () => (tools as any).prepare('management.reset', { scope: 'business' }, actor),
      /财务/,
    );
    assert.ok(store.db.prepare('SELECT count(*) AS n FROM customers').get()!.n);
    // 预览时就说清楚，不等到执行才拒绝
    const preview: any = new AssistantExtraTools(store, {} as any).read(
      'management.reset_preview',
      { scope: 'business' },
      actor,
    );
    assert.ok(preview.financeRows > 0);
    assert.match(preview.blocked, /系统维护/);
  } finally {
    store.close();
  }
});

test('红字发票不用关联往来单，全额红冲后额度释放，可以重新开票', () => {
  const store = financeFixture('2026-02');
  try {
    store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
    const invoices = new FinanceInvoices(store);
    const obligation = Number(
      store.db
        .prepare(
          "INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description) VALUES('receivable','1','虚构客户','2026-02-10',11300,'虚构送货')",
        )
        .run().lastInsertRowid,
    );
    const bill = (extra: Record<string, unknown>) => ({
      direction: 'sale',
      type: '虚构数电票',
      partyId: 1,
      rate: '13',
      ...extra,
    });
    const blue = invoices.create(
      financeActor,
      bill({ requestId: 'blue', number: 'B-1', date: '2026-02-10', net: 10000, tax: 1300, gross: 11300 }) as any,
    );
    invoices.link(financeActor, blue.id, {
      version: 1,
      requestId: 'blue-link',
      links: [{ obligationId: obligation, amount: 11300 }],
    });
    invoices.confirm(financeActor, blue.id, { version: 2, requestId: 'blue-confirm' });
    const invoiced = () =>
      (invoices.unmatched(financeActor, { kind: 'receivable' }).rows as any[]).find(
        (r) => r.id === obligation,
      )?.invoiced;
    assert.equal(invoiced(), 11300);
    const red = invoices.create(
      financeActor,
      bill({
        requestId: 'red',
        number: 'R-1',
        date: '2026-02-11',
        net: -10000,
        tax: -1300,
        gross: -11300,
        originalId: blue.id,
      }) as any,
    );
    invoices.confirm(financeActor, red.id, { version: 1, requestId: 'red-confirm' });
    assert.equal(invoiced(), 0, '全额红冲后额度释放');
  } finally {
    store.close();
  }
});

test('12 月先做月末损益结转，再做年度利润结转', () => {
  const store = financeFixture('2026-12');
  try {
    const closing = new FinanceClosing(store);
    const step = () =>
      (closing.check(financeActor, { period: '2026-12' }).steps as any[]).find(
        (s) => s.key === 'profit',
      );
    assert.equal(step().annualNext, false, '月末损益还没结转时不该走年度');
    periodJob(store, financeActor, '2026-12', 'profit_close', null, {});
    assert.equal(step().annualNext, true);
  } finally {
    store.close();
  }
});
