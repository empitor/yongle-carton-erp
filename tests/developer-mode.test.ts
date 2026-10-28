import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { developerActor, isDeveloperActor } from '../server/developer-capability.js';
import { DeveloperService } from '../server/developer-service.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { arrivalAssistantFixture } from './arrival-assistant-fixture.js';
import { superActor, actor, assistantFixture } from './assistant-fixture.js';
import { APP_VERSION } from '../shared/version.js';
const dev = () => developerActor(superActor());
const command = (module: string, action: string, items: any[] = [], patch: any = {}) => ({
  requestId: randomUUID(),
  module,
  action,
  items: items.map(({ id, version }) => ({ id, version })),
  patch,
  reason: '虚构开发验收',
});
function basics() {
  const store = new Store(':memory:'),
    service = new DeveloperService(store),
    who = dev();
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构开发客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构开发纸箱' }));
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-27',
      status: '已发货',
      lines: [{ productId: product.id, quantity: 100, unitPriceCents: 123 }],
    }),
  );
  return { store, service, who, customer, product, order };
}
test('开发者能力不能由普通对象属性伪造；普通账号和关闭模式均拒绝服务', () => {
  const f = basics();
  try {
    for (const who of [null, actor, superActor(), { ...superActor(), developerMode: true }]) {
      assert.equal(isDeveloperActor(who), false);
      assert.throws(
        () => f.service.execute(command('customers', 'create', [], { name: '不可创建' }), who, 's'),
        /开发者/,
      );
    }
    assert.equal(f.store.customers().length, 1);
  } finally {
    f.store.close();
  }
});
test('本机超级管理员启停需真实身份，生产环境/代理/缺CSRF拒绝；启停及重启恢复正常权限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-developer-auth-')),
    store = new Store(':memory:'),
    file = join(dir, 'users.sqlite'),
    auth = new AuthManager(file, Date.now, { localDevelopment: true });
  const server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = 'http://127.0.0.1:' + (server.address() as any).port,
    password = 'fictional-developer-pass-123';
  let cookie = '';
  const request = (path: string, body?: any, headers: any = {}) =>
    fetch(url + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
        Cookie: cookie,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const setup = await request('/auth/setup', { name: '开发者验收', password });
    cookie = setup.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/auth/developer-mode', { enabled: true })).status, 400);
    assert.equal(
      (
        await request(
          '/auth/developer-mode',
          { enabled: true, password },
          { 'X-ERP-Auth-Token': '' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/auth/developer-mode',
          { enabled: true, password },
          { 'X-Forwarded-For': '127.0.0.1' },
        )
      ).status,
      403,
    );
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.equal(
        (await request('/auth/developer-mode', { enabled: true, password })).status,
        403,
      );
    } finally {
      if (old === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = old;
    }
    const enabled = await request('/auth/developer-mode', { enabled: true, password });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).actor.developerMode, true);
    assert.equal(
      (
        await request(
          '/developer/execute',
          command('customers', 'create', [], { name: '虚构API客户' }),
        )
      ).status,
      200,
    );
    assert.equal((await request('/auth/developer-mode', { enabled: false })).status, 200);
    assert.equal((await request('/developer/records?module=customers')).status, 403);
    const db = new DatabaseSync(file),
      salt = 'fictional-dev-salt';
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      '普通账号',
      salt,
      scryptSync(password, salt, 64).toString('hex'),
      '["business:edit"]',
      'admin',
    );
    db.close();
    const login = await request('/auth/login', { name: '普通账号', password });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/auth/developer-mode', { enabled: true, password })).status, 403);
    auth.close();
    const reopened = new AuthManager(file, Date.now, { localDevelopment: true });
    try {
      assert.equal(
        reopened.actor({ headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } } as any),
        null,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('完成/归档订单可修改与永久删除；版本、幂等、批量原子及普通关联保护保留', () => {
  const f = basics();
  try {
    const archived = f.service.execute(command('orders', 'archive', [f.order]), f.who, 's');
    assert.equal(archived.count, 1);
    let row = f.store.order(f.order.id, true)!;
    const edit = command('orders', 'update', [row], {
      notes: '归档后修正',
      lines: [{ ...row.lines[0], quantity: 200, unitPriceExact: '1.2345' }],
      roundingPolicy: 'half-up-cent',
    });
    const a = f.service.execute(edit, f.who, 's');
    assert.equal(a.results[0].totalAmountExact, '246.9000');
    assert.equal(f.store.order(row.id, true)!.notes, '归档后修正');
    assert.deepEqual(f.service.execute(edit, f.who, 's'), a);
    assert.throws(
      () => f.service.execute({ ...edit, requestId: randomUUID() }, f.who, 's'),
      /变化/,
    );
    row = f.store.order(row.id, true)!;
    assert.throws(
      () =>
        f.service.execute(
          command('orders', 'update', [row, { id: 9999, version: 1 }], { notes: '应回滚' }),
          f.who,
          's',
        ),
      /变化/,
    );
    assert.equal(f.store.order(row.id, true)!.notes, '归档后修正');
    f.service.execute(command('orders', 'permanent-delete', [row]), f.who, 's');
    assert.equal(f.store.orders(true).length, 0);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM business_audit WHERE source='local-developer'")
        .get()!.n,
    );
  } finally {
    f.store.close();
  }
});
test('开发者库存调整仍登记原流水、版本与请求幂等，拒绝负库存和更换已使用单位', () => {
  const f = basics(),
    ops = new OperationsService(f.store);
  try {
    const item = ops.saveItem({ name: '虚构原料', kind: 'raw', unit: '张' }, f.who),
      v = command('stock_items', 'move', [item], {
        action: 'adjust',
        quantity: '300',
        date: '2026-10-27',
        notes: '虚构盘点',
      });
    f.service.execute(v, f.who, 's');
    f.service.execute(v, f.who, 's');
    assert.equal(ops.repo.balance(item.id), 300000);
    assert.equal(ops.repo.movements().length, 1);
    const now = ops.repo.items()[0];
    assert.throws(
      () =>
        f.service.execute(command('stock_items', 'update', [now], { unit: '平方米' }), f.who, 's'),
      /不能改动/,
    );
    assert.throws(
      () =>
        f.service.execute(
          command('stock_items', 'move', [now], {
            action: 'out',
            quantity: '301',
            date: '2026-10-27',
            notes: '虚构出库',
          }),
          f.who,
          's',
        ),
      /不足/,
    );
    assert.equal(ops.repo.balance(item.id), 300000);
  } finally {
    f.store.close();
  }
});
test('已确认到货更正复用原冲销和更正单；库存同步、请求重放不重复、业务依赖不足整单回滚', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const who = dev(),
      service = new DeveloperService(f.store),
      flow = new FlowService(f.store),
      draft = f.view().draft;
    const saved = flow.save('arrival', draft, who),
      preview = flow.preview(saved.id, who, 's'),
      doc = flow.confirm(
        saved.id,
        { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true },
        who,
        's',
      );
    const patch = {
        lines: doc.lines.map((l: any, i: number) => ({
          ...l,
          quantity: i ? '100' : '150',
          differenceReason: '开发测试差异',
        })),
      },
      v = command('arrival', 'update', [doc], patch);
    const changed = service.execute(v, who, 's').results[0];
    assert.notEqual(changed.id, doc.id);
    assert.equal(changed.status, 'confirmed');
    assert.equal(flow.get(doc.id).status, 'reversed');
    assert.equal(f.ops.repo.balance(changed.lines[0].stockId), 150000);
    service.execute(v, who, 's');
    assert.equal(f.ops.repo.balance(changed.lines[0].stockId), 150000);
    const stock = f.ops.repo.items().find((x) => x.id === changed.lines[0].stockId)!;
    f.ops.move(
      stock.id,
      {
        expectedVersion: stock.version,
        requestId: randomUUID(),
        action: 'out',
        quantity: '140',
        date: '2026-10-27',
        notes: '虚构后续领用',
        acknowledged: true,
      },
      who,
    );
    assert.throws(
      () => service.execute(command('arrival', 'permanent-delete', [changed]), who, 's'),
      /后续业务|冲销/,
    );
    assert.equal(flow.get(changed.id).status, 'confirmed');
    assert.equal(f.ops.repo.balance(stock.id), 10000);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.close();
  }
});
test('开发者可调整已有收货采购的价格/计划数量但不能低于实收数量，关闭后原限制生效', () => {
  const f = basics(),
    ops = new OperationsService(f.store);
  try {
    const supplier = ops.saveSupplier({ name: '虚构供方' }, f.who),
      p = ops.savePurchase(
        {
          supplierId: supplier.id,
          orderDate: '2026-10-01',
          status: '已订货',
          lines: [{ name: '虚构纸板', unit: '张', quantity: '100', unitPrice: '1' }],
        },
        f.who,
      );
    ops.receive(
      p.id,
      {
        expectedVersion: p.version,
        requestId: randomUUID(),
        reference: 'FICTIONAL-DH',
        date: '2026-10-27',
        notes: '虚构',
        items: [{ lineId: p.lines[0].id, quantity: '20' }],
        acknowledged: true,
      },
      f.who,
    );
    let row = ops.repo.purchases()[0];
    const patch = { lines: [{ ...row.lines[0], quantity: '200', unitPrice: '1.2345' }] };
    f.service.execute(command('purchases', 'update', [row], patch), f.who, 's');
    row = ops.repo.purchases()[0];
    assert.equal(row.lines[0].quantity, '200');
    assert.equal(row.lines[0].receivedQuantity, '20');
    assert.equal(row.lines[0].unitPrice, '1.2345');
    assert.throws(
      () =>
        ops.savePurchase(
          { ...row, status: row.baseStatus, lines: [{ ...row.lines[0], quantity: '300' }] },
          actor,
          row.id,
        ),
      /已登记到货/,
    );
    assert.throws(
      () =>
        f.service.execute(
          command('purchases', 'update', [row], { lines: [{ ...row.lines[0], quantity: '10' }] }),
          f.who,
          's',
        ),
      /已收货/,
    );
  } finally {
    f.store.close();
  }
});
test('AI注册开发者工具真实执行并审计，普通账号被拒绝，无额外密码审核，重复消息不重复新增', async () => {
  const f = assistantFixture();
  try {
    const who = dev(),
      thread = f.manager.create(who),
      args = command('customers', 'create', [], { name: '虚构AI开发客户' });
    f.replies.push(
      { message: '', toolCalls: [{ name: 'developer.execute', args }] },
      { message: '已经按服务器结果创建。' },
    );
    const request = f.input('创建一个名为虚构AI开发客户的测试客户', randomUUID());
    const r = await f.manager.chat(
      thread.id,
      request,
      who,
      's',
      () => {},
      () => who,
    );
    assert.equal(f.store.customers().length, 1);
    assert.equal(r.messages.at(-1)!.plans?.length || 0, 0);
    await f.manager.chat(
      thread.id,
      request,
      who,
      's',
      () => {},
      () => who,
    );
    assert.equal(f.store.customers().length, 1);
    const customer = f.store.customers()[0];
    f.replies.push(
      {
        message: '',
        toolCalls: [
          {
            name: 'records.propose_permanent_delete',
            args: { module: 'customers', id: customer.id },
          },
        ],
      },
      { message: '服务器已经删除指定客户。' },
    );
    await f.manager.chat(
      thread.id,
      f.input('永久删除刚才创建的测试客户，编号' + customer.id, randomUUID()),
      who,
      's',
      () => {},
      () => who,
    );
    assert.equal(f.store.customers().length, 0);
    await assert.rejects(
      () =>
        f.manager.registry.dispatch('developer.execute', args, actor, {
          read: () => {},
          business: () => {},
          workflow: () => {},
        }),
      /开发者/,
    );
    assert.ok(
      f.store.db.prepare("SELECT 1 FROM business_audit WHERE source='local-developer'").get(),
    );
  } finally {
    f.close();
  }
});
test('AI工作区可独立复制、恢复及永久清理；原件与识别草稿隔离且保留正式业务数据', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const who = dev(),
      clone = await f.manager.developerFork(f.workspace.id, who);
    assert.notEqual(clone.id, f.workspace.id);
    assert.equal(clone.fileHash, f.workspace.fileHash);
    assert.equal(clone.arrivalDocId, null);
    await f.manager.remove(clone.id, { expectedRevision: clone.revision, acknowledged: true });
    await f.manager.restore(clone.id);
    const latest = f.manager.get(clone.id);
    await f.manager.remove(clone.id, { expectedRevision: latest.revision, acknowledged: true });
    await f.manager.developerPurge(clone.id, who);
    assert.ok(f.manager.get(f.workspace.id));
    assert.equal(f.manager.trash().length, 0);
    assert.equal(f.store.customers().length, 0);
    assert.equal(f.ai.sources().length, 1);
  } finally {
    f.close();
  }
});
test('版本号的包、锁文件与界面来源一致', () => {
  assert.equal(APP_VERSION, '0.5.3');
  for (const file of ['package.json', 'package-lock.json'])
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, APP_VERSION);
  assert.match(readFileSync('src/App.tsx', 'utf8'), /APP_VERSION/);
  assert.doesNotMatch(readFileSync('src/App.tsx', 'utf8'), /v0\.1/);
});
test('开发者生产更正、分批送货与订单数量纠错同步库存和履约，不允许凭空取消交付', () => {
  const f = basics(),
    ops = new OperationsService(f.store),
    flow = new FlowService(f.store);
  try {
    const who = f.who,
      initial = f.store.order(f.order.id)!;
    f.store.saveOrder(
      orderSchema.parse({
        ...initial,
        status: '已确认',
        lines: initial.lines.map((l) => ({ ...l, unit: '只' })),
      }),
      initial.id,
      initial.version,
    );
    const raw = ops.saveItem({ name: '虚构领用纸板', kind: 'raw', unit: '张' }, who),
      finished = ops.saveItem(
        { name: '虚构成品', kind: 'finished', unit: '只', productId: f.product.id },
        who,
      );
    f.service.execute(
      command('stock_items', 'move', [raw], {
        action: 'in',
        quantity: '300',
        date: '2026-10-27',
        notes: '虚构期初',
      }),
      who,
      's',
    );
    const confirm = (kind: any, input: any) => {
      const d = flow.save(kind, input, who),
        p = flow.preview(d.id, who, 's');
      return flow.confirm(
        d.id,
        { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
        who,
        's',
      );
    };
    const task = confirm('task', {
      date: '2026-10-27',
      productId: f.product.id,
      quantity: '150',
      unit: '只',
      orderIds: [f.order.id],
    });
    const production = confirm('production', {
      date: '2026-10-27',
      taskId: task.id,
      productId: f.product.id,
      finishedStockId: finished.id,
      goodQuantity: '100',
      scrapQuantity: '5',
      operator: '虚构操作员',
      materials: [{ stockId: raw.id, issued: '110', returned: '10' }],
    });
    const corrected = f.service.execute(
      command('production', 'update', [production], { goodQuantity: '120' }),
      who,
      's',
    ).results[0];
    assert.equal(corrected.status, 'confirmed');
    assert.equal(ops.repo.balance(raw.id), 200000);
    assert.equal(ops.repo.balance(finished.id), 120000);
    let currentTask = flow.get(task.id);
    f.service.execute(
      command('task', 'update', [currentTask], { quantity: '180', notes: '测试计划修正' }),
      who,
      's',
    );
    assert.equal(flow.get(task.id).completed, '120');
    let order = f.store.order(f.order.id)!;
    const line = order.lines[0];
    confirm('delivery', {
      customerId: f.customer.id,
      date: '2026-10-27',
      lines: [{ orderId: order.id, orderLineId: line.id, stockId: finished.id, quantity: '40' }],
    });
    assert.equal(f.store.order(order.id)!.status, '待发货');
    confirm('delivery', {
      customerId: f.customer.id,
      date: '2026-10-27',
      lines: [{ orderId: order.id, orderLineId: line.id, stockId: finished.id, quantity: '60' }],
    });
    assert.equal(ops.repo.balance(finished.id), 20000);
    order = f.store.order(order.id)!;
    assert.equal(order.status, '已发货');
    f.service.execute(
      command('orders', 'update', [order], { lines: [{ ...order.lines[0], quantity: 120 }] }),
      who,
      's',
    );
    assert.equal(f.store.order(order.id)!.status, '待发货');
    order = f.store.order(order.id)!;
    assert.throws(
      () =>
        f.service.execute(
          command('orders', 'update', [order], { lines: [{ ...order.lines[0], quantity: 99 }] }),
          who,
          's',
        ),
      /已交付/,
    );
    assert.throws(
      () => f.service.execute(command('orders', 'update', [order], { status: '已取消' }), who, 's'),
      /实际交付/,
    );
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});
