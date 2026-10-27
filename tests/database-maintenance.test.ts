import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { changeLifecycle } from '../server/business/management.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { assistantFixture } from './assistant-fixture.js';
import { arrivalAssistantFixture } from './arrival-assistant-fixture.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBusinessService } from '../server/business/service.js';
import { migrateOperations } from '../server/operations/schema.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { actor as fixtureActor } from './assistant-fixture.js';
import { imageFixture } from './import-fixtures.js';
function fixture(store = new Store(':memory:')) {
  const who = localAdministratorActor({
      id: 'fixture-owner',
      name: '虚构数据库维护',
      role: 'super_admin',
      permissions: ['business:edit'],
      superAdminMode: true,
      superAdminUntil: Date.now() + 3600000,
    }),
    ops = new OperationsService(store),
    flow = new FlowService(store),
    service = new DatabaseMaintenanceService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' })),
    supplier = ops.saveSupplier({ name: '虚构供应商' }, who);
  const raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, who),
    finished = ops.saveItem(
      { name: '虚构成品', kind: 'finished', unit: '只', productId: product.id },
      who,
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
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: order.id,
      orderDate: '2026-10-01',
      status: '已订货',
      lines: [{ stockItemId: raw.id, name: raw.name, quantity: '1000', unit: '张' }],
    },
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
  const arrival = () =>
    confirm('arrival', {
      supplierId: supplier.id,
      reference: randomUUID(),
      lines: [
        {
          stockId: raw.id,
          item: { name: raw.name, unit: '张' },
          quantity: '1000',
          purchaseLineId: purchase.lines[0].id,
        },
      ],
    });
  const production = () =>
    confirm('production', {
      productId: product.id,
      finishedStockId: finished.id,
      goodQuantity: '860',
      operator: '虚构员工',
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
  const del = (module: string, row: any, inventoryPolicy = 'preserve') => {
    const selection = { module, items: [{ id: row.id, version: row.version }], inventoryPolicy },
      p = service.preview(selection, who);
    return service.delete(
      { ...selection, requestId: randomUUID(), deletionDigest: p.digest },
      who,
      's',
    );
  };
  return {
    store,
    who,
    ops,
    flow,
    service,
    customer,
    product,
    supplier,
    raw,
    finished,
    order,
    purchase,
    arrival,
    production,
    delivery,
    del,
  };
}
test('数据库证据：已确认订单/采购物理删除，原表和生命周期中均无目标行', () => {
  const f = fixture();
  try {
    for (const [module, row] of [
      ['orders', f.order],
      ['purchases', f.purchase],
    ] as const) {
      const current = (f.store as any)[module](true).find((r: any) => r.id === row.id);
      const before = f.store.db.prepare('SELECT id FROM ' + module + ' WHERE id=?').all(row.id);
      f.del(module, current);
      const after = f.store.db.prepare('SELECT id FROM ' + module + ' WHERE id=?').all(row.id);
      console.log(
        JSON.stringify({
          table: module,
          id: row.id,
          before,
          after,
          lifecycle: f.store.db
            .prepare('SELECT * FROM record_lifecycle WHERE entity=? AND record_id=?')
            .all(module, row.id),
        }),
      );
      assert.equal(before.length, 1);
      assert.equal(after.length, 0);
    }
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('非零库存删除不受归档条件限制，删除库存档案及它的流水并解除采购引用', () => {
  const f = fixture();
  try {
    f.arrival();
    const current = f.ops.repo.items(true).find((r) => r.id === f.raw.id)!;
    assert.equal(current.balanceUnits, 1000000);
    const archived = changeLifecycle(
      f.store,
      'stock_items',
      { action: 'archive', items: [{ id: current.id, version: current.version }] },
      f.who,
    );
    assert.equal(archived.results[0].success, false);
    const before = f.store.db.prepare('SELECT id FROM stock_items WHERE id=?').all(current.id);
    f.del('stock_items', current);
    const after = f.store.db.prepare('SELECT id FROM stock_items WHERE id=?').all(current.id);
    console.log(
      JSON.stringify({
        table: 'stock_items',
        balanceBefore: current.balanceUnits,
        before,
        after,
        movementsAfter: f.store.db
          .prepare('SELECT id FROM stock_movements WHERE item_id=?')
          .all(current.id),
      }),
    );
    assert.equal(after.length, 0);
    assert.equal(f.ops.repo.purchases(true)[0].lines[0].stockItemId, null);
    assert.deepEqual(f.flow.list('arrival', true)[0].movements, []);
    for (const r of f.store.db.prepare('SELECT document FROM purchase_receipts').all())
      assert.deepEqual(JSON.parse(String(r.document)).movements, []);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('零库存仍有未完成生产工作时不能归档，但库存档案仍可直接删除', () => {
  const f = fixture();
  try {
    const task = f.flow.save(
      'task',
      {
        date: '2026-10-27',
        productId: f.product.id,
        quantity: '1000',
        unit: '只',
        orderIds: [f.order.id],
      },
      f.who,
    );
    const p = f.flow.preview(task.id, f.who, 's');
    f.flow.confirm(
      task.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      f.who,
      's',
    );
    const stock = f.ops.repo.items(true).find((s) => s.id === f.finished.id)!;
    const result = changeLifecycle(
      f.store,
      'stock_items',
      { action: 'archive', items: [{ id: stock.id, version: stock.version }] },
      f.who,
    );
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].message, /未完成的生产任务/);
    f.del('stock_items', stock);
    assert.equal(
      f.store.db.prepare('SELECT id FROM stock_items WHERE id=?').get(stock.id),
      undefined,
    );
    assert.ok(f.flow.get(task.id));
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('归档只保留并隐藏记录，恢复只针对归档；未完成采购归档失败但删除仍成功', () => {
  const f = fixture();
  try {
    assert.equal(
      changeLifecycle(
        f.store,
        'purchases',
        { action: 'archive', items: [f.purchase].map(({ id, version }) => ({ id, version })) },
        f.who,
      ).results[0].success,
      false,
    );
    f.del('purchases', f.purchase);
    assert.equal(f.store.purchases(true).length, 0);
    f.store.db.prepare("UPDATE orders SET status='已发货' WHERE id=?").run(f.order.id);
    const item = { id: f.order.id, version: f.order.version };
    assert.equal(
      changeLifecycle(f.store, 'orders', { action: 'archive', items: [item] }, f.who).results[0]
        .success,
      true,
    );
    assert.equal(f.store.orders().length, 0);
    assert.equal(f.store.orders(true).length, 1);
    assert.equal(
      changeLifecycle(f.store, 'orders', { action: 'restore', items: [item] }, f.who).results[0]
        .success,
      true,
    );
    assert.equal(f.store.orders().length, 1);
  } finally {
    f.store.close();
  }
});
test('已确认生产和送货可直接物理删除并明确保留/重算库存，关联引用和统计同步', () => {
  const f = fixture();
  try {
    f.arrival();
    const production = f.production(),
      delivery = f.delivery();
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    f.del('delivery', delivery, 'recalculate');
    assert.equal(f.flow.list('delivery', true).length, 0);
    assert.equal(f.ops.repo.balance(f.finished.id), 860000);
    assert.equal(f.store.order(f.order.id)!.lines[0].shippedQuantity, 0);
    f.del('production', production);
    assert.equal(f.flow.list('production', true).length, 0);
    assert.equal(f.ops.repo.balance(f.finished.id), 860000);
    assert.ok(
      f.store.db
        .prepare("SELECT 1 FROM stock_movements WHERE source_kind='database-maintenance'")
        .get(),
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('数据库直接编辑已确认生产860→850，已发货100时仍可同步维护余额而无需先冲销', () => {
  const f = fixture();
  try {
    f.arrival();
    const p = f.production();
    f.delivery();
    const n = f.flow.list(undefined, true).length;
    const saved = f.flow.maintenanceUpdate(
      p.id,
      { ...p, goodQuantity: '850', version: p.version },
      f.who,
    );
    assert.equal(saved.id, p.id);
    assert.equal(saved.status, 'confirmed');
    assert.equal(f.flow.list(undefined, true).length, n);
    assert.equal(f.ops.repo.balance(f.finished.id), 750000);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('删除客户、产品、供应商和已归档记录按真实依赖处理，原表消失且不进入回收站', () => {
  for (const module of ['customers', 'products', 'suppliers'] as const) {
    const f = fixture();
    try {
      f.arrival();
      f.production();
      f.delivery();
      const row =
        module === 'customers' ? f.customer : module === 'products' ? f.product : f.supplier;
      f.del(module, row);
      assert.equal(
        (f.store as any)[module](true).some((r: any) => r.id === row.id),
        false,
      );
      assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(
        f.store.db
          .prepare('SELECT 1 FROM record_lifecycle WHERE entity=? AND record_id=?')
          .get(module, row.id),
        undefined,
      );
    } finally {
      f.store.close();
    }
  }
});
test('所有四类实物单据及成品库存均可物理删除，关联清理后余额和外键准确', () => {
  for (const kind of ['arrival', 'task', 'production', 'delivery', 'stock_items']) {
    const f = fixture();
    try {
      const arrival = f.arrival(),
        task = f.flow.save(
          'task',
          {
            date: '2026-10-27',
            productId: f.product.id,
            quantity: '1000',
            unit: '只',
            orderIds: [f.order.id],
          },
          f.who,
        ),
        p = f.flow.preview(task.id, f.who, 's');
      f.flow.confirm(
        task.id,
        { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
        f.who,
        's',
      );
      const production = f.production(),
        delivery = f.delivery();
      const row =
        kind === 'arrival'
          ? f.flow.get(arrival.id)
          : kind === 'task'
            ? f.flow.get(task.id)
            : kind === 'production'
              ? production
              : kind === 'delivery'
                ? delivery
                : f.ops.repo.items(true).find((i) => i.id === f.finished.id)!;
      f.del(kind, row);
      const table = kind === 'stock_items' ? 'stock_items' : 'flow_documents';
      assert.equal(
        f.store.db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?').get(row.id),
        undefined,
      );
      assert.equal(
        f.store.db
          .prepare('SELECT 1 FROM record_lifecycle WHERE entity=? AND record_id=?')
          .get(kind === 'stock_items' ? kind : 'flow_' + kind, row.id),
        undefined,
      );
      assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      f.store.close();
    }
  }
});
test('AI删除、归档、恢复使用不同操作，已归档记录删除后在原表与归档中均不存在', async () => {
  const a = assistantFixture(),
    f = fixture(a.store),
    thread = a.manager.create(f.who);
  const chat = async (text: string, name: string, args: any) => {
    a.replies.push({ toolCalls: [{ name, args }] }, { message: '服务器实际结果已返回' });
    return a.manager.chat(
      thread.id,
      a.input(text, randomUUID()),
      f.who,
      's',
      () => {},
      () => f.who,
    );
  };
  try {
    f.store.db.prepare("UPDATE orders SET status='已发货' WHERE id=?").run(f.order.id);
    await chat('归档订单001', 'records.propose_lifecycle', {
      module: 'orders',
      id: f.order.id,
      action: 'archive',
    });
    assert.ok(f.store.order(f.order.id, true));
    assert.equal(f.store.archived('orders', f.order.id), true);
    await chat('恢复订单001', 'records.propose_lifecycle', {
      module: 'orders',
      id: f.order.id,
      action: 'restore',
    });
    assert.equal(f.store.archived('orders', f.order.id), false);
    const result = await chat('删除订单001', 'records.delete', {
      module: 'orders',
      id: f.order.id,
    });
    assert.equal(f.store.order(f.order.id, true), undefined);
    assert.equal(f.store.archived('orders', f.order.id), false);
    assert.equal(result.messages.at(-1)?.plans?.length || 0, 0);
    const tools = f.store.db
      .prepare(
        "SELECT json_extract(document,'$.plan.tool') AS tool FROM assistant_previews WHERE result IS NOT NULL",
      )
      .all()
      .map((r) => r.tool);
    assert.ok(tools.includes('records.delete'));
    assert.equal(tools.filter((t) => t === 'records.propose_lifecycle').length, 2);
    assert.ok(result.messages.at(-1)?.executed);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    a.close();
  }
});
test('AI工作区归档保留数据库和文件；删除实际移除工作区、草稿、任务和原件且无法恢复', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const who = localAdministratorActor({
        id: 'workspace-owner',
        name: '虚构维护',
        role: 'super_admin',
        permissions: ['business:edit'],
      }),
      id = f.workspace.id;
    const archived = f.manager.archiveWorkspace(id, f.manager.get(id).revision, who);
    const db = new DatabaseSync(join(f.dir, 'imports', 'workspaces.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM workspaces WHERE id=?').get(id)!.n, 1);
    assert.ok(f.manager.archives().some((r) => r.id === id));
    assert.ok(existsSync(join(f.dir, 'imports', id)));
    await f.manager.deleteWorkspace(id, archived.revision, who);
    const evidence = {
      table: 'workspaces',
      id,
      before: 1,
      after: db.prepare('SELECT COUNT(*) n FROM workspaces WHERE id=?').get(id)!.n,
      archives: db.prepare('SELECT COUNT(*) n FROM workspace_trash WHERE id=?').get(id)!.n,
      originalExists: existsSync(join(f.dir, 'imports', id)),
    };
    console.log(JSON.stringify(evidence));
    assert.equal(evidence.after, 0);
    assert.equal(evidence.archives, 0);
    assert.equal(evidence.originalExists, false);
    await assert.rejects(() => f.manager.restoreWorkspace(id, who));
    db.close();
  } finally {
    f.close();
  }
});
test('有到货的采购可改计划到实收以下或更换供应商，旧实收关联解除且原库存数量不伪造', () => {
  const f = fixture();
  try {
    f.arrival();
    let p = f.store.purchases(true)[0];
    p = f.ops.savePurchase(
      { ...p, status: p.baseStatus, lines: p.lines.map((l: any) => ({ ...l, quantity: '500' })) },
      f.who,
      p.id,
    )!;
    assert.equal(p.lines[0].quantity, '500');
    assert.equal(p.lines[0].receivedQuantity, '1000');
    assert.equal(p.status, '全部到货');
    const supplier = f.ops.saveSupplier({ name: '明确更正的另一供应商' }, f.who);
    p = f.ops.savePurchase({ ...p, status: p.baseStatus, supplierId: supplier.id }, f.who, p.id)!;
    assert.equal(p.supplierId, supplier.id);
    assert.equal(p.lines[0].receivedQuantity, '0');
    assert.equal(f.ops.repo.balance(f.raw.id), 1000000);
    assert.equal(f.flow.list('arrival')[0].lines[0].purchaseLineId, null);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('订单可直接修改客户及已交付后的计划数量，金额与关联送货客户同步', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    f.delivery();
    const customer = f.store.saveCustomer(customerSchema.parse({ name: '明确更正的客户' })),
      before = f.store.order(f.order.id)!;
    const saved = createBusinessService(f.store).execute(
      {
        entity: 'orders',
        action: 'update',
        id: before.id,
        input: {
          ...before,
          customerId: customer.id,
          lines: before.lines.map((l) => ({ ...l, quantity: 50 })),
          version: before.version,
        },
      },
      { source: 'manual-ui', operatorId: f.who.id, superAdminMode: true, developerActor: f.who },
    ) as any;
    assert.equal(saved.customerId, customer.id);
    assert.equal(saved.lines[0].quantity, 50);
    assert.equal(saved.totalCents, 5000);
    assert.equal(f.flow.list('delivery')[0].customerId, customer.id);
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('旧采购明细上限约束迁移保留非空实收、库存流水和外键，计划可低于实收', () => {
  const f = fixture();
  try {
    f.arrival();
    const db = f.store.db,
      before = db.prepare('SELECT * FROM purchase_lines').all();
    // 仅构造旧版本库；正式迁移运行时和所有业务操作外键保持开启。
    db.exec(`PRAGMA foreign_keys=OFF; SAVEPOINT old_fixture;
      CREATE TABLE purchase_lines_old(id INTEGER PRIMARY KEY,purchase_id INTEGER NOT NULL REFERENCES purchases(id),stock_item_id INTEGER REFERENCES stock_items(id),document TEXT NOT NULL,quantity_units INTEGER NOT NULL CHECK(quantity_units>0),received_units INTEGER NOT NULL DEFAULT 0 CHECK(received_units>=0 AND received_units<=quantity_units));
      INSERT INTO purchase_lines_old SELECT * FROM purchase_lines;
      DROP TABLE purchase_lines; ALTER TABLE purchase_lines_old RENAME TO purchase_lines;
      RELEASE old_fixture; PRAGMA foreign_keys=ON;`);
    migrateOperations(db);
    assert.deepEqual(db.prepare('SELECT * FROM purchase_lines').all(), before);
    db.prepare('UPDATE purchase_lines SET quantity_units=500000 WHERE id=?').run(before[0].id);
    assert.equal(
      db.prepare('SELECT received_units FROM purchase_lines').get()!.received_units,
      1000000,
    );
    assert.equal(f.ops.repo.balance(f.raw.id), 1000000);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  } finally {
    f.store.close();
  }
});

test('已归档确认单据直接编辑原ID，修改数量同步重算且归档状态保留', () => {
  const f = fixture();
  try {
    f.arrival();
    const production = f.production();
    f.flow.archive(production.id, false, f.who, production.version);
    const current = f.flow.get(production.id);
    const saved = f.flow.maintenanceUpdate(current.id, { ...current, goodQuantity: '850' }, f.who);
    assert.equal(saved.id, production.id);
    assert.equal(saved.archived, true);
    assert.equal(saved.status, 'confirmed');
    assert.equal(f.ops.repo.balance(f.finished.id), 850000);
    assert.equal(f.flow.list('production').length, 0);
    assert.equal(f.flow.list('production', true).length, 1);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('共享送货订单更换客户时拆分准确关联，已有出库不重复扣减', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    const second = f.store.saveOrder(
      orderSchema.parse({
        ...f.order,
        number: '虚构共享送货订单',
        lines: f.order.lines.map(({ id, ...l }) => l),
      }),
    );
    const draft = f.flow.save(
      'delivery',
      {
        date: '2026-10-27',
        customerId: f.customer.id,
        lines: [f.order, second].map((o) => ({
          orderId: o.id,
          orderLineId: o.lines[0].id,
          stockId: f.finished.id,
          quantity: '100',
        })),
      },
      f.who,
    );
    const preview = f.flow.preview(draft.id, f.who, 's');
    f.flow.confirm(
      draft.id,
      { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true },
      f.who,
      's',
    );
    const other = f.store.saveCustomer(customerSchema.parse({ name: '共享送货更正客户' }));
    const current = f.store.order(f.order.id)!;
    createBusinessService(f.store).execute(
      {
        entity: 'orders',
        action: 'update',
        id: current.id,
        input: { ...current, customerId: other.id },
      },
      { source: 'manual-ui', operatorId: f.who.id, superAdminMode: true, developerActor: f.who },
    );
    const deliveries = f.flow.list('delivery');
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every((d) => d.status === 'confirmed' && d.lines.length === 1));
    assert.equal(deliveries.find((d) => d.customerId === other.id)!.lines[0].orderId, f.order.id);
    assert.equal(
      deliveries.find((d) => d.customerId === f.customer.id)!.lines[0].orderId,
      second.id,
    );
    assert.equal(f.ops.repo.balance(f.finished.id), 660000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('物理删除到货后工作区解除跨库引用，保留独立识别草稿而非悬空404', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const who = localAdministratorActor({
      id: 'fixture-owner',
      name: '虚构维护',
      role: 'super_admin',
      permissions: ['business:edit'],
    });
    const supplier = new OperationsService(f.store).saveSupplier(
      { name: '解除关联虚构供应商' },
      who,
    );
    const flow = new FlowService(f.store);
    const arrival = flow.save(
      'arrival',
      {
        date: '2026-10-27',
        supplierId: supplier.id,
        reference: randomUUID(),
        lines: [{ item: { name: '独立纸板', unit: '张' }, quantity: '100' }],
      },
      who,
    );
    f.manager.linkArrival(f.workspace.id, {
      expectedRevision: f.manager.get(f.workspace.id).revision,
      docId: arrival.id,
    });
    f.manager.arrivalDocumentExists = (id) =>
      !!f.store.db.prepare('SELECT 1 FROM flow_documents WHERE id=?').get(id);
    const service = new DatabaseMaintenanceService(f.store),
      selection = { module: 'arrival', items: [{ id: arrival.id, version: arrival.version }] };
    const plan = service.preview(selection, who);
    service.delete(
      { ...selection, requestId: randomUUID(), deletionDigest: plan.digest },
      who,
      's',
    );
    assert.equal(f.manager.get(f.workspace.id).arrivalDocId, null);
    assert.ok(f.manager.get(f.workspace.id).arrivalSourceId);
  } finally {
    f.close();
  }
});

test('旧回收格式工作区可直接编辑并保留归档状态，也可不恢复而直接物理删除', async () => {
  for (const action of ['edit', 'delete']) {
    const f = await arrivalAssistantFixture();
    try {
      const who = localAdministratorActor({
          id: 'legacy-archive-owner',
          name: '虚构维护',
          role: 'super_admin',
          permissions: ['business:edit'],
        }),
        id = f.workspace.id;
      await f.manager.remove(id, {
        expectedRevision: f.manager.get(id).revision,
        acknowledged: true,
      });
      assert.ok(f.manager.archives().some((r) => r.id === id));
      if (action === 'edit') {
        const archived = await f.manager.openArchivedWorkspace(id, who);
        assert.equal((archived as any).archived, true);
        f.manager.saveArrivalAssistant(id, archived.revision, {
          draft: { notes: '在归档状态直接编辑' },
        });
        assert.equal(f.manager.arrivalAssistant(id).draft.notes, '在归档状态直接编辑');
        assert.ok(f.manager.archives().some((r) => r.id === id));
        assert.ok(!f.manager.status().workspaces.some((r) => r.id === id));
        assert.ok(existsSync(join(f.dir, 'imports', id, 'original')));
      } else {
        await f.manager.deleteWorkspace(id, undefined, who);
        assert.ok(!f.manager.archives().some((r) => r.id === id));
        assert.ok(!existsSync(join(f.dir, 'imports', '_trash', id)));
        await assert.rejects(() => f.manager.restoreWorkspace(id, who));
      }
    } finally {
      f.close();
    }
  }
});

test('已正式导入的工作区可由本机管理员编辑、撤销和归档，正式订单及来源回执不被重复执行', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const user = { ...fixtureActor, permissions: ['business:edit', 'import:execute'] };
    const attachment = await f.manager.attachments.upload(
      f.thread.id,
      imageFixture(),
      '虚构已导入草稿.png',
      randomUUID(),
      user,
    );
    await f.send('识别这张客户订单', [attachment.id]);
    await f.send('确认导入');
    const original = f.store.orders()[0];
    assert.ok(original);
    const who = localAdministratorActor({ ...user, name: '虚构维护', role: 'super_admin' });
    let w = f.current();
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [
          {
            op: 'set-line',
            lineId: w.draft!.lines[0].id,
            field: 'quantity',
            value: '250',
            reason: '管理员明确更正工作草稿',
          },
        ],
      },
      'manual',
      who,
    );
    assert.equal(w.draft!.lines[0].fields.quantity.value, '250');
    assert.equal(f.store.order(original.id)!.lines[0].quantity, 100);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n, 1);
    w = f.imports.undo(w.id, { expectedRevision: w.revision }, who);
    assert.equal(w.draft!.lines[0].fields.quantity.value, '100');
    f.replies.push(
      {
        toolCalls: [
          {
            name: 'order_import.edit',
            args: {
              expectedRevision: w.revision,
              operations: [
                {
                  op: 'set-line',
                  lineId: w.draft!.lines[0].id,
                  field: 'quantity',
                  value: '275',
                  reason: '用户明确修改工作草稿',
                },
              ],
            },
          },
        ],
      },
      { message: '已保存工作草稿。' },
    );
    await f.send('把已导入订单的工作区草稿第一行数量改为275，不重复导入', [], randomUUID(), who);
    w = f.current();
    assert.equal(w.draft!.lines[0].fields.quantity.value, '275');
    assert.equal(f.store.order(original.id)!.lines[0].quantity, 100);
    f.imports.archiveWorkspace(w.id, w.revision, who);
    assert.ok(f.imports.archives().some((r) => r.id === w.id));
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.recognitionCalls(), 1);
  } finally {
    f.close();
  }
});
