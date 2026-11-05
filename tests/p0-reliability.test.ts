// 只使用临时虚构库：覆盖全局鉴权、订单状态派生、账号管理、流水修订、备份恢复和读取规模。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { AuthManager, type Actor } from '../server/auth.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { createBusinessService } from '../server/business/service.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { DevelopmentResetService } from '../server/business/development-reset.js';
import {
  createFullBackup,
  restoreFullBackup,
  snapshotBeforeDestructive,
} from '../server/backup.js';
import { customerSchema, orderSchema, productSchema } from '../shared/domain.js';

const actor: Actor = { id: 'p0', name: '虚构操作员', permissions: ['business:edit'] };
const superActor = (): Actor => ({
  ...actor,
  role: 'super_admin',
  superAdminMode: true,
  superAdminUntil: Date.now() + 60000,
});
const rawInput = {
  name: '虚构五层纸板',
  kind: 'raw',
  unit: '张',
  length: 1000,
  width: 800,
  height: null,
  dimensionUnit: 'mm',
  material: 'K=A',
  flute: 'BC',
  specification: '',
  notes: '',
  productId: null,
};
function fixture(file = ':memory:') {
  const store = new Store(file),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    pa = store.saveProduct(productSchema.parse({ name: '虚构箱A' })),
    pb = store.saveProduct(productSchema.parse({ name: '虚构箱B' }));
  const raw = ops.saveItem(rawInput, actor),
    fa = ops.saveItem({ ...rawInput, name: '成品A', kind: 'finished', unit: '只', productId: pa.id }, actor);
  ops.move(
    raw.id,
    {
      action: 'in',
      quantity: '100000',
      date: '2026-10-01',
      notes: '虚构期初',
      acknowledged: true,
      requestId: randomUUID(),
      expectedVersion: raw.version,
    },
    actor,
  );
  const confirm = (d: any, who: Actor = actor) => {
    const p = flow.preview(d.id, who, 's');
    return flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      who,
      's',
    );
  };
  const line = (p: any, quantity = 100) => ({
    productId: p.id,
    productName: p.name,
    specification: '',
    quantity,
    unit: '只',
    unitPriceCents: 100,
    notes: '',
  });
  const order = (lines: any[]) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        notes: '',
        costs: null,
        lines,
      }),
    );
  const task = (o: any, p: any) =>
    confirm(
      flow.save(
        'task',
        { date: '2026-10-02', productId: p.id, quantity: '100', unit: '只', orderIds: [o.id] },
        actor,
      ),
    );
  const production = (taskId: number | null, p: any, stock: any, quantity: string) =>
    confirm(
      flow.save(
        'production',
        {
          date: '2026-10-05',
          taskId,
          productId: p.id,
          finishedStockId: stock.id,
          goodQuantity: quantity,
          scrapQuantity: '0',
          operator: '虚构机长',
          materials: [{ stockId: raw.id, issued: '10', returned: '0' }],
        },
        actor,
      ),
    );
  return { store, ops, flow, customer, pa, pb, raw, fa, confirm, line, order, task, production };
}

test('多产品订单只完工部分产品时仍是生产中；全部完工后才待发货', () => {
  const f = fixture(),
    fb = f.ops.saveItem(
      { ...rawInput, name: '成品B', kind: 'finished', unit: '只', productId: f.pb.id },
      actor,
    ),
    o = f.order([f.line(f.pa), f.line(f.pb)]);
  const a = f.task(o, f.pa);
  assert.equal(f.store.order(o.id)!.status, '生产中');
  f.production(a.id, f.pa, f.fa, '100');
  assert.equal(f.store.order(o.id)!.status, '生产中', '产品B尚未排产');
  const b = f.task(o, f.pb);
  f.production(b.id, f.pb, fb, '100');
  assert.equal(f.store.order(o.id)!.status, '待发货');
  f.store.close();
});

test('冲销生产登记或生产任务后，订单状态随事实回退', () => {
  const f = fixture(),
    o = f.order([f.line(f.pa)]),
    t = f.task(o, f.pa),
    done = f.production(t.id, f.pa, f.fa, '100');
  assert.equal(f.store.order(o.id)!.status, '待发货');
  f.flow.reverse(
    done.id,
    { version: f.flow.get(done.id).version, reason: '虚构冲销', acknowledged: true },
    superActor(),
  );
  assert.equal(f.flow.get(t.id).progress, 0);
  assert.equal(f.store.order(o.id)!.status, '生产中');
  f.flow.reverse(
    t.id,
    { version: f.flow.get(t.id).version, reason: '虚构冲销', acknowledged: true },
    superActor(),
  );
  assert.equal(f.store.order(o.id)!.status, '已确认');
  f.store.close();
});

test('已取消订单不会被后续单据重算覆盖', () => {
  const f = fixture(),
    o = f.order([f.line(f.pa)]),
    t = f.task(o, f.pa);
  f.store.db.prepare("UPDATE orders SET status='已取消' WHERE id=?").run(o.id);
  f.flow.reverse(
    t.id,
    { version: f.flow.get(t.id).version, reason: '虚构冲销', acknowledged: true },
    superActor(),
  );
  assert.equal(f.store.order(o.id)!.status, '已取消');
  f.store.close();
});

test('普通账号不能手工设置派生状态；本机管理员保留历史数据维护', () => {
  const f = fixture(),
    o = f.order([f.line(f.pa)]),
    business = createBusinessService(f.store),
    input = (status: string) => {
      const current = f.store.order(o.id)!;
      return {
        customerId: current.customerId,
        orderDate: current.orderDate,
        deliveryDate: current.deliveryDate,
        status,
        notes: '',
        costs: null,
        version: current.version,
        lines: current.lines,
      };
    },
    update = (status: string, who: Actor) =>
      business.execute(
        { entity: 'orders', action: 'update', id: String(o.id), input: input(status) },
        { source: 'manual-ui', operatorId: who.id, developerActor: who },
      );
  assert.throws(() => update('已发货', actor), /自动更新/);
  assert.equal(f.store.order(o.id)!.status, '已确认');
  assert.equal((update('已取消', actor) as any).status, '已取消');
  assert.equal((update('已发货', localAdministratorActor(superActor())) as any).status, '已发货');
  f.store.close();
});

test('管理员改写已确认送货会留下流水修订，余额与当前流水一致', () => {
  const f = fixture(),
    o = f.order([f.line(f.pa)]);
  f.production(null, f.pa, f.fa, '100');
  const lines = [{ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.fa.id, quantity: '40' }];
  const d = f.confirm(
    f.flow.save('delivery', { date: '2026-10-06', customerId: f.customer.id, lines }, actor),
  );
  const moved = f.store.db
    .prepare("SELECT id FROM stock_movements WHERE source_kind='flow_delivery'")
    .get()!;
  const current = f.flow.get(d.id);
  f.flow.maintenanceUpdate(
    d.id,
    {
      date: current.date,
      customerId: current.customerId,
      version: current.version,
      lines: [{ ...lines[0], quantity: '25' }],
    },
    localAdministratorActor(superActor()),
  );
  assert.equal(f.ops.repo.balance(f.fa.id), 75000);
  const revision = f.store.db
    .prepare('SELECT * FROM stock_movement_revisions WHERE movement_id=?')
    .get(moved.id)!;
  assert.equal(JSON.parse(String(revision.before_document)).delta_units, -40000);
  assert.equal(JSON.parse(String(revision.after_document)).delta_units, -25000);
  const listed = f.ops.repo.movements().find((m) => m.id === moved.id);
  assert.equal(listed.revisionCount, 1);
  f.store.close();
});

test('读取次数不随订单量增长：单条查询不扫描全部送货单', () => {
  const f = fixture(),
    insertOrder = f.store.db.prepare(
      "INSERT INTO orders(id,number,customer_id,customer_name,order_date,delivery_date,status,notes,total_cents,created_at,updated_at) VALUES(?,?,?,?,'2026-10-01','2026-10-30','已确认','',0,'t','t')",
    ),
    insertLine = f.store.db.prepare(
      "INSERT INTO order_lines(order_id,product_id,product_name,specification,quantity,unit_price_cents) VALUES(?,?,'虚构','',100,100)",
    ),
    insertFlow = f.store.db.prepare(
      "INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at) VALUES('delivery',?,'2026-10-06','confirmed',?,'t','t','t','t')",
    ),
    insertRef = f.store.db.prepare(
      'INSERT INTO flow_refs(document_id,order_id,order_line_id,stock_id) VALUES(?,?,?,?)',
    );
  f.store.db.exec('BEGIN');
  for (let i = 1; i <= 3000; i++) {
    insertOrder.run(i, 'B-' + i, f.customer.id, '虚构客户');
    const line = Number(insertLine.run(i, f.pa.id).lastInsertRowid);
    if (i % 2) {
      const doc = Number(
        insertFlow.run(
          'SH-' + i,
          JSON.stringify({
            customerId: f.customer.id,
            lines: [{ orderId: i, orderLineId: line, stockId: f.fa.id, quantity: '1' }],
          }),
        ).lastInsertRowid,
      );
      insertRef.run(doc, i, line, f.fa.id);
    }
  }
  f.store.db.exec('COMMIT');
  const started = performance.now();
  const one = f.store.order(1)!;
  const single = performance.now() - started;
  assert.equal(one.lines[0].shippedQuantity, 1);
  const listStart = performance.now();
  const all = f.store.orders();
  const list = performance.now() - listStart;
  assert.equal(all.length, 3000);
  // 旧实现在此规模下单条约17秒、列表约17秒；放宽阈值避免机器差异造成误报。
  assert.ok(single < 100, '单条订单读取耗时 ' + single + 'ms');
  assert.ok(list < 1500, '全部订单读取耗时 ' + list + 'ms');
  f.store.close();
});

test('破坏性操作前自动生成可打开的恢复快照，5分钟内不重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-p0-snapshot-')),
    file = join(dir, 'erp.sqlite');
  try {
    const f = fixture(file);
    new DevelopmentResetService(f.store).execute('business', localAdministratorActor(superActor()));
    assert.equal(f.store.customers(true).length, 0);
    const snapshots = readdirSync(join(dir, 'snapshots'));
    assert.equal(snapshots.length, 1);
    const copy = new Store(join(dir, 'snapshots', snapshots[0]));
    assert.equal(copy.customers(true)[0].name, '虚构客户');
    copy.close();
    assert.equal(snapshotBeforeDestructive(f.store, 'again'), join(dir, 'snapshots', snapshots[0]));
    assert.equal(readdirSync(join(dir, 'snapshots')).length, 1);
    f.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('物理删除前同样生成快照，内存库和事务内安全跳过', () => {
  const f = fixture();
  assert.equal(snapshotBeforeDestructive(f.store, 'memory'), null);
  f.store.close();
  const dir = mkdtempSync(join(tmpdir(), 'erp-p0-delete-'));
  try {
    const g = fixture(join(dir, 'erp.sqlite'));
    g.store.db.exec('SAVEPOINT outer_tx');
    assert.equal(snapshotBeforeDestructive(g.store, 'in-tx'), null);
    g.store.db.exec('RELEASE outer_tx');
    const customer = g.store.saveCustomer(customerSchema.parse({ name: '待删除虚构客户' }));
    new DatabaseMaintenanceService(g.store).delete(
      {
        module: 'customers',
        items: [{ id: customer.id, version: customer.version }],
        requestId: randomUUID(),
      },
      localAdministratorActor(superActor()),
      'session',
    );
    assert.equal(g.store.customer(customer.id, true), undefined);
    assert.equal(readdirSync(join(dir, 'snapshots')).length, 1);
    g.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('完整备份含账号、工作区与原件并可校验恢复；篡改后拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-p0-backup-')),
    data = join(dir, 'data'),
    backups = join(dir, 'backups');
  try {
    const f = fixture(join(data, 'erp.sqlite')),
      auth = new AuthManager(join(data, 'security', 'users.sqlite'));
    mkdirSync(join(data, 'ai-imports', 'files'), { recursive: true });
    writeFileSync(join(data, 'ai-imports', 'files', 'a.bin'), 'fictional-original');
    writeFileSync(join(data, 'erp.sqlite.running'), '1');
    mkdirSync(join(data, 'snapshots'));
    writeFileSync(join(data, 'snapshots', 'erp-old.sqlite'), 'skip');
    const result = await createFullBackup({ dataDir: data, backupRoot: backups });
    assert.ok(existsSync(join(result.dir, 'security', 'users.sqlite')));
    assert.ok(existsSync(join(result.dir, 'ai-imports', 'files', 'a.bin')));
    assert.ok(!existsSync(join(result.dir, 'erp.sqlite.running')));
    assert.ok(!existsSync(join(result.dir, 'snapshots')));
    f.store.saveCustomer(customerSchema.parse({ name: '备份之后的虚构客户' }));
    f.store.close();
    auth.close();
    const restored = restoreFullBackup(result.dir, data);
    assert.ok(existsSync(restored.previous));
    const back = new Store(join(data, 'erp.sqlite'));
    assert.equal(back.customers(true).length, 1);
    back.close();
    writeFileSync(join(result.dir, 'ai-imports', 'files', 'a.bin'), 'tampered');
    assert.throws(() => restoreFullBackup(result.dir, data), /校验失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP：未登录读取一律401；账号建立、改密、停用、只读级别按预期生效', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const send = (path: string, body?: unknown, cookie = '', method = 'POST') =>
    fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : method,
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];
  try {
    for (const path of [
      '/orders',
      '/customers',
      '/products',
      '/dashboard',
      '/suppliers',
      '/purchases',
      '/warehouse/items',
      '/warehouse/movements',
      '/ai/settings',
      '/business/metadata',
    ])
      assert.equal((await send(path)).status, 401, path);
    assert.equal((await send('/health')).status, 200);
    assert.equal((await send('/auth/state')).status, 200);

    const admin = cookieOf(
      await send('/auth/setup', { name: '虚构管理员', password: 'fictional-admin-123' }),
    );
    assert.equal((await send('/orders', undefined, admin)).status, 200);
    assert.equal((await send('/auth/users', undefined, admin)).status, 200);

    const created = await send(
      '/auth/users',
      { name: '虚构只读', password: 'fictional-viewer-123', level: 'viewer' },
      admin,
    );
    assert.equal(created.status, 201);
    const viewerRow = (await created.json()).users.find((u: any) => u.name === '虚构只读');
    assert.equal(viewerRow.level, 'viewer');
    const viewer = cookieOf(
      await send('/auth/login', { name: '虚构只读', password: 'fictional-viewer-123' }),
    );
    assert.equal((await send('/orders', undefined, viewer)).status, 200);
    assert.equal((await send('/auth/users', undefined, viewer)).status, 403);
    assert.equal((await send('/customers', { name: '虚构写入' }, viewer)).status, 403);

    const reset = await send(
      '/auth/users/' + viewerRow.id + '/password',
      { password: 'fictional-viewer-456' },
      admin,
    );
    assert.equal(reset.status, 200);
    assert.equal((await send('/orders', undefined, viewer)).status, 401, '旧会话失效');
    assert.equal(
      (await send('/auth/login', { name: '虚构只读', password: 'fictional-viewer-123' })).status,
      401,
    );
    const viewer2 = cookieOf(
      await send('/auth/login', { name: '虚构只读', password: 'fictional-viewer-456' }),
    );
    assert.equal(
      (await send('/auth/users/' + viewerRow.id, { disabled: true }, admin, 'PUT')).status,
      200,
    );
    assert.equal((await send('/orders', undefined, viewer2)).status, 401, '停用后立即下线');
    assert.equal(
      (await send('/auth/login', { name: '虚构只读', password: 'fictional-viewer-456' })).status,
      403,
    );

    const adminId = (await (await send('/auth/users', undefined, admin)).json()).users.find(
      (u: any) => u.name === '虚构管理员',
    ).id;
    assert.equal(
      (await send('/auth/users/' + adminId, { disabled: true }, admin, 'PUT')).status,
      409,
      '不能停用最后一个管理员',
    );
    assert.equal(
      (await send('/auth/password', { current: '错误密码', password: 'fictional-admin-456' }, admin))
        .status,
      401,
    );
    assert.equal(
      (
        await send(
          '/auth/password',
          { current: 'fictional-admin-123', password: 'fictional-admin-456' },
          admin,
        )
      ).status,
      200,
    );
    assert.equal((await send('/orders', undefined, admin)).status, 200, '当前会话保留');
  } finally {
    await new Promise((r) => server.close(r));
    auth.close();
    f.store.close();
  }
});
