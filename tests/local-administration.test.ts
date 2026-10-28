import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { localAdministratorActor, isLocalAdministrator } from '../server/developer-capability.js';
import { DeveloperService } from '../server/developer-service.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { changeLifecycle } from '../server/business/management.js';

import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { manageWorkspaces } from '../server/workspace-management.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { assistantFixture, superActor, actor } from './assistant-fixture.js';
import { arrivalAssistantFixture } from './arrival-assistant-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
const owner = () => localAdministratorActor(superActor());
const cmd = (module: string, action: string, rows: any[] = [], patch: any = {}) => ({
  module,
  action,
  patch,
  items: rows.map((r) => ({ id: r.id, version: r.version })),
  requestId: randomUUID(),
  reason: '虚构本机管理验收',
});
function fixture(store = new Store(':memory:')) {
  const who = owner(),
    service = new DeveloperService(store),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构本机客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-30',
      status: '已确认',
      lines: [{ productId: product.id, quantity: 1000, unitPriceCents: 100, unit: '只' }],
    }),
  );
  const supplier = ops.saveSupplier({ name: '虚构供应商' }, who);
  const raw = ops.saveItem({ name: '虚构原料', kind: 'raw', unit: '张' }, who),
    finished = ops.saveItem(
      { name: '虚构成品', kind: 'finished', unit: '只', productId: product.id },
      who,
    );
  const confirm = (kind: any, input: any) => {
    const d = flow.save(kind, { date: '2026-10-27', ...input }, who),
      p = flow.preview(d.id, who, 's');
    return flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      who,
      's',
    );
  };
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: order.id,
      orderDate: '2026-10-01',
      status: '已订货',
      lines: [
        { name: raw.name, stockItemId: raw.id, unit: '张', quantity: '1000', unitPrice: '1' },
      ],
    },
    who,
  );
  const arrival = () =>
    confirm('arrival', {
      supplierId: supplier.id,
      reference: randomUUID(),
      lines: [
        {
          stockId: raw.id,
          purchaseLineId: purchase.lines[0].id,
          item: { name: raw.name, unit: '张' },
          quantity: '1000',
          unitPrice: '1',
          priceBasis: 'quantity',
        },
      ],
    });
  const task = () =>
    confirm('task', { productId: product.id, quantity: '1000', unit: '只', orderIds: [order.id] });
  const production = (taskId: number | null = null) =>
    confirm('production', {
      productId: product.id,
      finishedStockId: finished.id,
      goodQuantity: '860',
      scrapQuantity: '0',
      operator: '虚构员工',
      taskId,
      materials: [{ stockId: raw.id, issued: '900', returned: '0' }],
    });
  const delivery = () =>
    confirm('delivery', {
      customerId: customer.id,
      lines: [
        {
          orderId: order.id,
          orderLineId: order.lines[0].id,
          stockId: finished.id,
          quantity: '100',
        },
      ],
    });
  return {
    store,
    who,
    service,
    ops,
    flow,
    customer,
    product,
    order,
    supplier,
    raw,
    finished,
    purchase,
    arrival,
    task,
    production,
    delivery,
  };
}

test('真实本机最高管理员登录即获完整能力；超15分钟仍有效，CSRF、代理、普通账号及退出限制保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-local-admin-')),
    file = join(dir, 'users.sqlite'),
    store = new Store(':memory:');
  let now = Date.now();
  const auth = new AuthManager(file, () => now, { localAdministration: true });
  const server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = 'http://127.0.0.1:' + (server.address() as any).port,
    password = 'fictional-local-admin-123';
  let cookie = '';
  const req = (path: string, body?: any, extra: any = {}, method = body ? 'POST' : 'GET') =>
    fetch(url + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
        Cookie: cookie,
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await req('/management/records?module=orders')).status, 403);
    const setup = await req('/auth/setup', { name: '虚构最高管理员', password });
    cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const state = await (await req('/auth/state')).json();
    assert.equal(state.actor.localAdministrator, true);
    assert.equal(state.actor.developerMode, undefined);
    assert.equal(isLocalAdministrator(state.actor), false, '序列化对象无法携带服务端能力');
    now += 16 * 60000;
    assert.equal((await (await req('/auth/state')).json()).actor.localAdministrator, true);
    const command = cmd('customers', 'create', [], { name: '虚构无需模式客户' });
    assert.equal(
      (await req('/management/execute', command, { 'X-ERP-Auth-Token': '' })).status,
      403,
    );
    assert.equal(
      (await req('/management/execute', command, { 'X-Forwarded-For': '127.0.0.1' })).status,
      403,
    );
    assert.equal((await req('/management/execute', command)).status, 200);
    assert.equal((await req('/management/execute', command)).status, 200);
    assert.equal(store.customers().length, 1);
    const f = fixture(store),
      order = store.order(f.order.id)!;
    const updated = await req(
      '/orders/' + order.id,
      { ...orderSchema.parse(order), version: order.version, notes: '直接编辑已确认订单' },
      {},
      'PUT',
    );
    assert.equal(updated.status, 200);
    assert.equal(store.order(order.id)!.notes, '直接编辑已确认订单');
    const clean = store.customers().find((r) => r.name === '虚构无需模式客户')!;
    const preview = await (
      await req('/admin/permanent-deletions/preview', {
        entity: 'customers',
        items: [{ id: clean.id, version: clean.version }],
      })
    ).json();
    assert.equal(
      (
        await req('/admin/permanent-deletions/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req('/admin/permanent-deletions/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    const db = new DatabaseSync(file),
      salt = 'fictional-local-admin-salt';
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      '虚构普通账号',
      salt,
      scryptSync(password, salt, 64).toString('hex'),
      '["business:edit"]',
      'admin',
    );
    db.close();
    const login = await req('/auth/login', { name: '虚构普通账号', password });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await (await req('/auth/state')).json()).actor.localAdministrator, undefined);
    assert.equal(
      (await req('/management/execute', cmd('customers', 'create', [], { name: '不可创建' })))
        .status,
      403,
    );
    await req('/auth/logout', {});
    assert.equal((await req('/management/records?module=orders')).status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('已确认生产860直接编辑850，原材料/成品/任务同步且请求幂等', () => {
  const f = fixture();
  try {
    f.arrival();
    const task = f.task(),
      production = f.production(task.id);
    const command = cmd('production', 'update', [production], { goodQuantity: '850' });
    const result = f.service.execute(command, f.who, 's').results[0];
    assert.equal(result.status, 'confirmed');
    assert.equal(result.goodQuantity, '850');
    assert.equal(f.flow.get(production.id).status, 'confirmed');
    assert.equal(result.id, production.id);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.equal(f.ops.repo.balance(f.finished.id), 850000);
    assert.equal(f.flow.get(task.id).completed, '850');
    const count = f.ops.repo.movements().length;
    f.service.execute(command, f.who, 's');
    assert.equal(f.ops.repo.movements().length, count);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('单据备注直接编辑无需回退已消耗库存；数量更正若库存不足，原业务和全部流水保持不变', () => {
  const f = fixture();
  try {
    f.arrival();
    const task = f.task(),
      production = f.production(task.id);
    f.delivery();
    const before = f.ops.repo.movements().length;
    const result = f.service.execute(
      cmd('production', 'update', [production], { notes: '直接修正备注', operator: '实际机长' }),
      f.who,
      's',
    ).results[0];
    assert.equal(result.id, production.id);
    assert.equal(result.operator, '实际机长');
    assert.equal(f.ops.repo.movements().length, before);
    assert.throws(
      () =>
        f.service.execute(
          cmd('production', 'update', [result], { goodQuantity: '50' }),
          f.who,
          's',
        ),
      /库存|冲销/,
    );
    assert.equal(f.flow.get(production.id).status, 'confirmed');
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.equal(f.ops.repo.movements().length, before);
    assert.throws(
      () =>
        f.service.execute(
          cmd('stock_items', 'update', [f.ops.repo.items().find((s) => s.id === f.raw.id)!], {
            balanceUnits: -1,
          }),
          f.who,
          's',
        ),
      /字段/,
    );
  } finally {
    f.store.close();
  }
});

test('删除关联订单实际移除订单及依赖送货，保留独立生产和库存并解除可空引用', () => {
  const f = fixture();
  try {
    f.arrival();
    const task = f.task();
    f.production(task.id);
    f.delivery();
    const order = f.store.order(f.order.id)!,
      maintenance = new DatabaseMaintenanceService(f.store),
      selection = { module: 'orders', items: [{ id: order.id, version: order.version }] };
    const archived = changeLifecycle(
      f.store,
      'orders',
      { action: 'archive', items: selection.items },
      f.who,
    );
    assert.equal(archived.results[0].success, false);
    const preview = maintenance.preview(selection, f.who),
      command = { ...cmd('orders', 'delete', [order]), deletionDigest: preview.digest };
    f.service.execute(command, f.who, 's');
    assert.equal(f.store.order(order.id, true), undefined);
    assert.equal(f.flow.list('delivery', true).length, 0);
    assert.equal(f.flow.list('production', true).length, 1);
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.deepEqual(f.flow.get(task.id).orderIds, []);
    assert.equal(f.store.purchases(true)[0].customerOrderId, null);
    assert.equal(f.store.archived('orders', order.id), false);
    f.service.execute(command, f.who, 's');
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('关联删除范围变化拒绝旧范围，数据库异常整单回滚；未完成订单仍可物理删除', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    const maintenance = new DatabaseMaintenanceService(f.store);
    let order = f.store.order(f.order.id)!;
    const selection = () => ({
        module: 'orders',
        items: [{ id: order.id, version: order.version }],
      }),
      old = maintenance.preview(selection(), f.who);
    f.delivery();
    order = f.store.order(order.id)!;
    assert.throws(
      () =>
        f.service.execute(
          { ...cmd('orders', 'delete', [order]), deletionDigest: old.digest },
          f.who,
          's',
        ),
      /范围|变化/,
    );
    const fresh = maintenance.preview(selection(), f.who);
    f.store.db.exec(
      "CREATE TRIGGER fictional_delete_failure BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT,'fixture abort'); END",
    );
    assert.throws(
      () =>
        f.service.execute(
          { ...cmd('orders', 'delete', [order]), deletionDigest: fresh.digest },
          f.who,
          's',
        ),
      /fixture abort/,
    );
    assert.ok(f.store.order(order.id, true));
    assert.equal(f.flow.list('delivery', true).length, 1);
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    f.store.db.exec('DROP TRIGGER fictional_delete_failure');
    const p = maintenance.preview(selection(), f.who);
    f.service.execute(
      { ...cmd('orders', 'delete', [order]), deletionDigest: p.digest },
      f.who,
      's',
    );
    assert.equal(f.store.order(order.id, true), undefined);
  } finally {
    f.store.close();
  }
});

test('AI按真实本机权限修改订单和已确认生产、删除采购；无待审密码步骤，回执及刷新事件真实', async () => {
  const a = assistantFixture(),
    f = fixture(a.store),
    thread = a.manager.create(f.who),
    effects: any[] = [];
  const chat = async (text: string, tool: string, args: any) => {
    a.replies.push(
      { message: '', toolCalls: [{ name: tool, args }] },
      { message: '依据服务器结果完成。' },
    );
    const input = a.input(text, randomUUID());
    const result = await a.manager.chat(
      thread.id,
      input,
      f.who,
      's',
      (event, data) => {
        if (event === 'effect') effects.push(data);
      },
      () => f.who,
    );
    assert.equal(result.messages.at(-1)?.plans?.length || 0, 0);
    return { result, input };
  };
  try {
    await chat('把订单数量改成500', 'records.propose_save', {
      module: 'orders',
      id: f.order.id,
      patch: { lines: f.order.lines.map((l) => ({ ...l, quantity: 500 })) },
    });
    assert.equal(f.store.order(f.order.id)!.lines[0].quantity, 500);
    assert.equal(f.store.order(f.order.id)!.totalCents, 50000);
    f.arrival();
    const p = f.production();
    await chat('生产登记实际850只，请修改', 'records.propose_save', {
      module: 'production_records',
      id: p.id,
      patch: { goodQuantity: '850' },
    });
    assert.equal(f.ops.repo.balance(f.finished.id), 850000);
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-27',
        status: '待订货',
        lines: [{ name: '虚构待删纸板', unit: '张', quantity: '10' }],
      },
      f.who,
    );
    const { input } = await chat('删除刚建的采购单' + purchase.number, 'records.delete', {
      module: 'purchases',
      id: purchase.id,
    });
    assert.equal(
      f.store.purchases(true).some((p) => p.id === purchase.id),
      false,
    );
    await a.manager.chat(
      thread.id,
      input,
      f.who,
      's',
      () => {},
      () => f.who,
    );
    assert.equal(f.ops.repo.balance(f.finished.id), 850000);
    assert.ok(effects.some((e) => e.type === 'business'));
    const request = JSON.stringify(a.requests.at(-1)!.body);
    assert.ok(request.includes('management.execute'));
    assert.ok(
      f.store.db.prepare('SELECT 1 FROM assistant_previews WHERE result IS NOT NULL').get(),
    );
  } finally {
    a.close();
  }
});

test('管理工具不接受模型伪造身份，双端启停有效，失败不会写入', async () => {
  const a = assistantFixture(),
    f = fixture(a.store),
    args = cmd('customers', 'create', [], { name: '不可伪造客户' });
  try {
    const fake = { ...superActor(), localAdministrator: true };
    assert.equal(isLocalAdministrator(fake), false);
    await assert.rejects(
      () =>
        a.manager.registry.dispatch('management.execute', args, fake, {
          read: () => {},
          business: () => {},
          workflow: () => {},
        }),
      /本机最高管理员/,
    );
    assert.throws(
      () => a.manager.tools.prepare('management.execute', args, actor, 's'),
      /本机最高管理员/,
    );
    a.manager.registry.set(
      { name: 'management.execute', enabled: false, expectedRevision: 0 },
      f.who,
    );
    await assert.rejects(
      () =>
        a.manager.registry.dispatch('management.execute', args, f.who, {
          read: () => {},
          business: () => {},
          workflow: () => {},
        }),
      /停用/,
    );
    assert.equal(f.store.customers().length, 1);
  } finally {
    a.close();
  }
});

test('只有生产任务关联时可直接改客户、规格和未引用明细；有效送货与历史明细引用仍受保护', () => {
  const f = fixture();
  try {
    f.task();
    const another = f.store.saveCustomer(customerSchema.parse({ name: '虚构更正客户' }));
    const otherProduct = f.store.saveProduct(productSchema.parse({ name: '虚构新增产品' }));
    let order = f.store.order(f.order.id)!;
    const input = {
      customerId: another.id,
      lines: [
        { ...order.lines[0], specification: '合理修正规格', quantity: 500 },
        { productId: otherProduct.id, quantity: 100, unitPriceCents: 200, unit: '只' },
      ],
    };
    order = f.service.execute(cmd('orders', 'update', [order], input), f.who, 's').results[0];
    assert.equal(order.customerId, another.id);
    assert.equal(order.lines.length, 2);
    assert.equal(order.lines[0].id, f.order.lines[0].id);
    assert.equal(order.totalCents, 70000);
    const addedId = order.lines[1].id;
    order = f.service.execute(
      cmd('orders', 'update', [order], { lines: [order.lines[0]] }),
      f.who,
      's',
    ).results[0];
    assert.equal(order.lines.length, 1);
    assert.ok(!f.store.db.prepare('SELECT 1 FROM order_lines WHERE id=?').get(addedId!));
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('统一management.execute真实执行与恢复核验，不通过提示词伪造能力；明确永久删除无需文字口令', async () => {
  const a = assistantFixture(),
    f = fixture(a.store),
    thread = a.manager.create(f.who);
  try {
    const command = cmd('orders', 'update', [f.order], { notes: '统一工具实际写入' });
    a.replies.push(
      { toolCalls: [{ name: 'management.execute', args: command }] },
      { message: '已保存。' },
    );
    const result = await a.manager.chat(
      thread.id,
      a.input('修改此订单备注', randomUUID()),
      f.who,
      's',
      () => {},
      () => f.who,
    );
    assert.equal(f.store.order(f.order.id)!.notes, '统一工具实际写入');
    assert.equal(result.messages.at(-1)?.plans?.length || 0, 0);
    a.manager.tasks.verify(thread.id, f.who, a.manager.tools);
    const step = a.manager.tasks
      .get(thread.id, f.who)!
      .steps.find((s) => s.tool === 'management.execute')!;
    assert.equal((step.verification as any).current.record.notes, '统一工具实际写入');
    const clean = f.store.saveCustomer(customerSchema.parse({ name: '虚构明确永久删除客户' }));
    a.replies.push(
      {
        toolCalls: [
          { name: 'management.execute', args: cmd('customers', 'permanent-delete', [clean]) },
        ],
      },
      { message: '已删除。' },
    );
    await a.manager.chat(
      thread.id,
      a.input('永久删除这个虚构客户', randomUUID()),
      f.who,
      's',
      () => {},
      () => f.who,
    );
    assert.equal(f.store.customer(clean.id, true), undefined);
  } finally {
    a.close();
  }
});

test('AI工作区工具实际走统一服务，列表刷新、不触发重新识别计费，重复消息不重复复制', async () => {
  const f = createOrderWorkflowFixture(),
    who = owner(),
    thread = f.manager.create(who),
    events: any[] = [];
  try {
    const w = (await f.imports.upload(imageFixture(), '虚构管理工具.png', true)).workspace;
    const args = { action: 'fork', requestId: randomUUID(), items: [{ id: w.id }] };
    f.replies.push(
      { toolCalls: [{ name: 'management.workspaces', args }] },
      { message: '已按实际结果复制。' },
    );
    const input = {
      text: '将这个工作区复制为独立任务',
      requestId: randomUUID(),
      profile: f.settings.view().active,
    };
    await f.manager.chat(
      thread.id,
      input,
      who,
      's',
      (event, data) => events.push({ event, data }),
      () => who,
    );
    const count = f.imports.status().workspaces.length;
    assert.equal(count, 2);
    assert.equal(f.recognitionCalls(), 0);
    assert.ok(events.some((e) => e.event === 'effect' && e.data.module === 'workspaces'));
    await f.manager.chat(
      thread.id,
      input,
      who,
      's',
      () => {},
      () => who,
    );
    assert.equal(f.imports.status().workspaces.length, count);
  } finally {
    f.close();
  }
});

test('AI工作区复制/删除/恢复/清理共用服务，重复和并发请求只复制一次，正式来源保留', async () => {
  const f = await arrivalAssistantFixture(),
    who = owner(),
    binding = 'workspace-local';
  try {
    const raw = { requestId: randomUUID(), action: 'fork', items: [{ id: f.workspace.id }] };
    const concurrent = await Promise.allSettled([
      manageWorkspaces(f.store, f.manager, raw, who, binding),
      manageWorkspaces(f.store, f.manager, raw, who, binding),
    ]);
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    const saved = await manageWorkspaces(f.store, f.manager, raw, who, binding),
      cloned = saved.results[0].result;
    assert.notEqual(cloned.id, f.workspace.id);
    await manageWorkspaces(
      f.store,
      f.manager,
      {
        requestId: randomUUID(),
        action: 'remove',
        items: [{ id: cloned.id, revision: cloned.revision }],
      },
      who,
      binding,
    );
    await manageWorkspaces(
      f.store,
      f.manager,
      { requestId: randomUUID(), action: 'restore', items: [{ id: cloned.id }] },
      who,
      binding,
    );
    const current = f.manager.get(cloned.id);
    await manageWorkspaces(
      f.store,
      f.manager,
      {
        requestId: randomUUID(),
        action: 'remove',
        items: [{ id: cloned.id, revision: current.revision }],
      },
      who,
      binding,
    );
    const purge = { requestId: randomUUID(), action: 'purge', items: [{ id: cloned.id }] };
    assert.equal(
      (await manageWorkspaces(f.store, f.manager, purge, who, binding)).results[0].success,
      true,
    );
    assert.equal(
      (await manageWorkspaces(f.store, f.manager, purge, who, binding)).results[0].success,
      true,
    );
    assert.ok(f.manager.get(f.workspace.id));
    assert.equal(f.ai.sources().length, 1);
    f.store.db.exec(
      "CREATE TRIGGER fictional_audit_failure BEFORE INSERT ON business_audit BEGIN SELECT RAISE(ABORT,'fictional audit unavailable'); END",
    );
    const uncertain = { requestId: randomUUID(), action: 'fork', items: [{ id: f.workspace.id }] };
    await assert.rejects(
      () => manageWorkspaces(f.store, f.manager, uncertain, who, binding),
      /待核验/,
    );
    const actualCount = f.manager.status().workspaces.length;
    await assert.rejects(
      () => manageWorkspaces(f.store, f.manager, uncertain, who, binding),
      /待核对/,
    );
    assert.equal(f.manager.status().workspaces.length, actualCount);
  } finally {
    f.close();
  }
});
