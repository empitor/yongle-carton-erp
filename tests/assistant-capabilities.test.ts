import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, superActor, assistantFixture } from './assistant-fixture.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/domain.js';
import { buildDashboard } from '../server/business/dashboard.js';
import { toolCatalog } from '../server/assistant/tools.js';
import type { Actor } from '../server/auth.js';

const call = (name: string, args: any) => ({
  message: '准备调用业务工具。',
  toolCalls: [{ name, args }],
});
async function chat(
  f: ReturnType<typeof assistantFixture>,
  thread: any,
  text: string,
  name?: string,
  args?: any,
  who: Actor = actor,
  context?: any,
) {
  if (name) f.replies.push(call(name, args));
  const input = f.input(text, randomUUID(), context);
  delete (input as any).consent;
  return f.manager.chat(
    thread.id,
    input,
    who,
    'capabilities',
    () => {},
    () => who,
  );
}

test('普通聊天/查询无需consent；明确常规新增和修改直接执行，结果/审计真实且请求幂等', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    await chat(f, t, '你好');
    const input: any = f.input('创建客户“全新虚构客户”', randomUUID());
    delete input.consent;
    f.replies.push(
      call('records.propose_save', { module: 'customers', patch: { name: '全新虚构客户' } }),
    );
    const result = await f.manager.chat(
      t.id,
      input,
      actor,
      'capabilities',
      () => {},
      () => actor,
    );
    assert.equal(f.store.customers().length, 1);
    assert(result.messages.at(-1)!.executed);
    assert.equal(result.messages.at(-1)!.plans.length, 0);
    assert.match(result.messages.at(-1)!.text, /已实际执行/);
    const count = f.calls();
    await f.manager.chat(
      t.id,
      input,
      actor,
      'capabilities',
      () => {},
      () => actor,
    );
    assert.equal(f.calls(), count);
    assert.equal(f.store.customers().length, 1);
    const c = f.store.customers()[0];
    await chat(f, t, `把客户编号${c.id}的联系电话修改为13800000000`, 'records.propose_save', {
      module: 'customers',
      id: c.id,
      patch: { phone: '13800000000' },
    });
    assert.equal(f.store.customer(c.id)!.phone, '13800000000');
    const audit = f.store.db
      .prepare("SELECT document FROM assistant_audit WHERE state='executed'")
      .all();
    assert.equal(audit.length, 2);
    assert.match(String(audit[0].document), /explicit-user-request/);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('常规工具覆盖档案、两种订单、库存档案及四类实物草稿，编辑逐项持久保存且不偷偷确认库存', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    const create = async (module: string, title: string, patch: any) => {
      const r = await chat(f, t, `创建${title} ${patch.name || ''}`, 'records.propose_save', {
        module,
        patch,
      });
      const saved = r.messages.at(-1)!.executed?.result;
      assert(saved?.id, JSON.stringify(r.messages.at(-1)));
      return saved;
    };
    const customer = await create('customers', '客户', { name: '虚构闭环客户' });
    const supplier = await create('suppliers', '供应商', { name: '虚构闭环供应商' });
    const product = await create('products', '产品', { name: '虚构闭环纸箱' });
    const raw = await create('raw_inventory', '原材料库存档案', { name: '虚构板', unit: '张' });
    const finished = await create('finished_inventory', '成品库存档案', {
      name: '虚构箱',
      unit: '只',
      productId: product.id,
    });
    const order = await create('orders', '客户订单', {
      customerId: customer.id,
      orderDate: today(),
      deliveryDate: today(),
      status: '已确认',
      lines: [{ productId: product.id, quantity: 100, unit: '只', unitPriceExact: '1.2345' }],
    });
    const purchase = await create('purchases', '采购订单', {
      supplierId: supplier.id,
      orderDate: today(),
      status: '已订货',
      lines: [
        { name: '板', stockItemId: raw.id, unit: '张', quantity: '100', unitPrice: '0.1234' },
      ],
    });
    const arrival = await create('arrivals', '到货草稿', {
      date: today(),
      supplierId: supplier.id,
      reference: 'DRAFT-ONLY',
      lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '10' }],
    });
    const task = await create('production_tasks', '生产任务', {
      date: today(),
      productId: product.id,
      quantity: '10',
      unit: '只',
      orderIds: [order.id],
    });
    const production = await create('production_records', '生产登记', {
      date: today(),
      productId: product.id,
      finishedStockId: finished.id,
      goodQuantity: '5',
      scrapQuantity: '1',
      operator: '虚构员工',
      materials: [{ stockId: raw.id, issued: '7', returned: '1' }],
    });
    const delivery = await create('deliveries', '送货草稿', {
      date: today(),
      customerId: customer.id,
      lines: [
        { orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: '3' },
      ],
    });
    for (const [module, title, row, field] of [
      ['customers', '客户', customer, 'notes'],
      ['suppliers', '供应商', supplier, 'notes'],
      ['products', '产品', product, 'requirements'],
      ['orders', '客户订单', order, 'notes'],
      ['purchases', '采购', purchase, 'notes'],
      ['raw_inventory', '原材料库存', raw, 'notes'],
      ['finished_inventory', '成品库存', finished, 'notes'],
      ['arrivals', '到货', arrival, 'notes'],
      ['production_tasks', '生产任务', task, 'notes'],
      ['production_records', '生产登记', production, 'notes'],
      ['deliveries', '送货', delivery, 'notes'],
    ] as const) {
      const result = await chat(
        f,
        t,
        `把${title}编号${row.id}备注修改为已核对`,
        'records.propose_save',
        { module, id: row.id, patch: { [field]: '已核对' } },
      );
      assert.equal(result.messages.at(-1)!.executed?.result[field], '已核对', module);
      assert.equal(
        f.manager.tools.read('records.get', { module, id: row.id }, actor).record[field],
        '已核对',
      );
    }
    assert.equal(f.manager.tools.ops.repo.movements().length, 0);
    assert.equal(f.manager.tools.ops.repo.balance(raw.id), 0);
    assert.equal(f.manager.tools.ops.repo.balance(finished.id), 0);
    assert.equal(f.store.order(order.id)!.status, '已确认');
    const confirmed = await chat(f, t, `确认生产任务编号${task.id}`, 'flow.propose_confirmation', {
      id: task.id,
    });
    assert(confirmed.messages.at(-1)!.executed);
    assert.equal(f.manager.tools.flow.get(task.id).status, 'confirmed');
    assert.equal(
      f.manager.tools.read(
        'records.search',
        { module: 'production_tasks', filters: { customerId: customer.id } },
        actor,
      ).total,
      1,
    );
    assert.equal(f.manager.tools.ops.repo.movements().length, 0);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('信息不足时模型提问，服务器拒绝只读账户写入及虚假成功声明', async () => {
  const f = assistantFixture();
  try {
    const p = f.store.saveProduct(
        productSchema.parse({ name: '虚构防护产品', requirements: '旧值' }),
      ),
      t = f.manager.create(actor);
    f.replies.push({ message: '请说明要修改成什么内容。', toolCalls: [] });
    await chat(f, t, '修改产品备注');
    assert.equal(f.store.product(p.id)!.requirements, '旧值');
    const reader = { ...actor, permissions: [] };
    await chat(
      f,
      t,
      '修改产品编号1备注为越权值',
      'records.propose_save',
      { module: 'products', id: p.id, patch: { requirements: '越权值' } },
      reader,
    );
    assert.equal(f.store.product(p.id)!.requirements, '旧值');
    f.replies.push({ message: '已修改产品备注。', toolCalls: [] });
    const r = await chat(f, t, '修改产品编号1备注为新值');
    assert.match(r.messages.at(-1)!.text, /没有成功的后端写入结果|未完成事项/);
    assert.equal(f.store.product(p.id)!.requirements, '旧值');
  } finally {
    f.close();
  }
});

test('单条及批量按明确指令执行；显式预览保留，事务失败不部分提交', async () => {
  const f = assistantFixture(),
    owner = superActor();
  try {
    const a = f.store.saveProduct(productSchema.parse({ name: '甲' })),
      b = f.store.saveProduct(productSchema.parse({ name: '乙' })),
      t = f.manager.create(owner);
    await chat(
      f,
      t,
      `归档产品编号${a.id}`,
      'records.propose_lifecycle',
      { module: 'products', id: a.id, action: 'archive' },
      owner,
    );
    assert(f.store.archived('products', a.id));
    assert.equal(
      f.manager.tools.read(
        'records.search',
        { module: 'products', filters: { lifecycle: 'archived' } },
        actor,
      ).total,
      1,
    );
    await chat(
      f,
      t,
      `恢复产品编号${a.id}`,
      'records.propose_lifecycle',
      { module: 'products', id: a.id, action: 'restore' },
      owner,
    );
    assert(!f.store.archived('products', a.id));
    const args = { module: 'products', ids: [a.id, b.id], action: 'archive' };
    const result = await chat(
        f,
        t,
        '先预览批量归档这两项产品',
        'records.propose_batch_lifecycle',
        args,
        owner,
      ),
      plan = result.messages.at(-1)!.plans[0];
    assert(plan.highRisk);
    assert(!f.store.archived('products', a.id));
    f.manager.execute(
      plan.id,
      { acknowledged: true, secondConfirmation: true },
      owner,
      'capabilities',
    );
    assert(f.store.archived('products', a.id) && f.store.archived('products', b.id));
    const restore = f.manager.tools.prepare(
      'records.propose_batch_lifecycle',
      { ...args, action: 'restore' },
      owner,
      'capabilities',
    );
    // Change the second record after preview: first record's restoration must roll back.
    f.store.db.prepare('UPDATE products SET version=version+1 WHERE id=?').run(b.id);
    assert.throws(() => f.manager.tools.commit(restore, owner, 'capabilities'), /已修改|已变化/);
    assert(f.store.archived('products', a.id) && f.store.archived('products', b.id));
    assert(
      f.manager.tools.prepare(
        'records.propose_batch_lifecycle',
        { ...args, action: 'restore' },
        actor,
        'capabilities',
      ),
    );
    assert.throws(
      () =>
        f.manager.tools.prepare(
          'records.propose_batch_lifecycle',
          args,
          { ...actor, permissions: [] },
          'capabilities',
        ),
      /权限/,
    );
  } finally {
    f.close();
  }
});

test('全量汇总不被20条分页截断，日期历史与回收站分开，经营概览与原查询一致', () => {
  const f = assistantFixture(),
    owner = superActor();
  try {
    const c = f.store.saveCustomer(customerSchema.parse({ name: '统计客户' })),
      p = f.store.saveProduct(productSchema.parse({ name: '统计产品' }));
    for (let i = 0; i < 25; i++)
      f.store.saveOrder(
        orderSchema.parse({
          customerId: c.id,
          orderDate: i === 0 ? '2020-01-01' : today(),
          deliveryDate: today(),
          status: i === 0 ? '已发货' : '已确认',
          roundingPolicy: 'half-up-cent',
          lines: [{ productId: p.id, quantity: 1, unitPriceCents: 12, unitPriceExact: '0.1234' }],
        }),
      );
    const summary = f.manager.tools.read('records.summarize', { module: 'orders' }, actor);
    assert.equal(summary.total, 25);
    assert.equal(summary.metrics.pending, 24);
    assert.equal(Number(summary.metrics.amount), 3.085);
    assert.equal(
      f.manager.tools.read('records.search', { module: 'orders', limit: 20 }, actor).results!
        .length,
      20,
    );
    assert.equal(
      f.manager.tools.read(
        'records.search',
        { module: 'orders', filters: { view: 'history' } },
        actor,
      ).total,
      1,
    );
    assert.equal(
      f.manager.tools.read(
        'records.search',
        { module: 'orders', filters: { lifecycle: 'archived' } },
        owner,
      ).total,
      0,
    );
    const { url, ...overview } = f.manager.tools.read('overview.get', { allDates: true }, actor);
    assert.equal(url, '#dashboard');
    assert.deepEqual(
      overview,
      buildDashboard(f.store, f.store.orders(), { allDates: true } as any),
    );
  } finally {
    f.close();
  }
});

test('库存汇总不混单位、面积准确；流水按日期/方向/仓库筛选，当前库存保持实时余额', () => {
  const f = assistantFixture(),
    owner = superActor();
  try {
    const ops = f.manager.tools.ops,
      raw = ops.saveItem(
        {
          name: '纸板',
          kind: 'raw',
          unit: '张',
          length: 100,
          width: 50,
          dimensionUnit: 'cm',
          material: 'K',
          flute: 'B',
        },
        actor,
      );
    const other = ops.saveItem({ name: '另一单位', kind: 'finished', unit: '箱' }, actor);
    const move = (id: number, action: string, quantity: string, date: string) => {
      const row = ops.repo.items().find((r) => r.id === id)!;
      ops.move(
        id,
        {
          action,
          quantity,
          date,
          expectedVersion: row.version,
          requestId: randomUUID(),
          acknowledged: true,
          notes: '虚构验收',
        },
        owner,
      );
    };
    move(raw.id, 'in', '10', '2020-01-01');
    move(raw.id, 'out', '2', today());
    move(other.id, 'in', '3', today());
    const stock = f.manager.tools.read(
      'records.summarize',
      { module: 'raw_inventory', filters: { start: today() } },
      actor,
    );
    assert.equal(stock.metrics.areaSquareMetres, '4');
    assert.deepEqual(stock.metrics.quantities, [{ unit: '张', quantity: '8' }]);
    const flows = f.manager.tools.read(
      'records.summarize',
      {
        module: 'movements',
        filters: { start: today(), end: today(), kind: 'raw', direction: 'out' },
      },
      actor,
    );
    assert.equal(flows.total, 1);
    assert.equal(flows.metrics.groups[0].outgoing, '2');
    assert.equal(flows.metrics.groups[0].incoming, '0');
    assert.equal(flows.metrics.groups[0].currentQuantity, '8');
    const emptyPeriod = f.manager.tools.read(
      'records.summarize',
      { module: 'movements', filters: { stockId: raw.id, start: '2099-01-01', end: '2099-02-01' } },
      actor,
    );
    assert.equal(emptyPeriod.total, 0);
    assert.equal(emptyPeriod.metrics.groups[0].incoming, '0');
    assert.equal(emptyPeriod.metrics.groups[0].currentQuantity, '8');
    assert.throws(() => f.manager.tools.read('records.propose_movement', {}, actor), /未注册/);
    assert(toolCatalog.some((t) => t.name === 'overview.get'));
  } finally {
    f.close();
  }
});

test('部分到货采购备注可以编辑且累计收货不变，不能用编辑状态回退库存', async () => {
  const f = assistantFixture();
  try {
    const ops = f.manager.tools.ops,
      s = ops.saveSupplier({ name: '部分到货供应商' }, actor),
      p = ops.savePurchase(
        {
          supplierId: s.id,
          orderDate: today(),
          status: '已订货',
          lines: [{ name: '纸板', quantity: '10', unit: '张' }],
        },
        actor,
      );
    ops.receive(
      p.id,
      {
        expectedVersion: p.version,
        requestId: randomUUID(),
        reference: 'PARTIAL',
        date: today(),
        notes: '',
        items: [{ lineId: p.lines[0].id, quantity: '4' }],
        acknowledged: true,
      },
      actor,
    );
    const t = f.manager.create(actor),
      r = await chat(f, t, `修改采购编号${p.id}备注为实收待补`, 'records.propose_save', {
        module: 'purchases',
        id: p.id,
        patch: { notes: '实收待补' },
      });
    assert(r.messages.at(-1)!.executed);
    const saved = ops.repo.purchases()[0];
    assert.equal(saved.status, '部分到货');
    assert.equal(saved.lines[0].receivedQuantity, '4');
    assert.equal(ops.repo.items()[0].quantity, '4');
    const summary = f.manager.tools.read(
      'records.summarize',
      { module: 'purchases', filters: { supplierId: s.id } },
      actor,
    );
    assert.deepEqual(summary.metrics.outstanding, [{ unit: '张', quantity: '6' }]);
  } finally {
    f.close();
  }
});
