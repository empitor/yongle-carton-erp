import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { stockItemSchema, quantityString, quantityUnits, lineMoney } from '../shared/operations.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Navigation from '../src/Navigation.js';
const password = 'fictional-operations-password-123';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-operations-')),
    file = join(dir, 'erp.sqlite'),
    authFile = join(dir, 'users.sqlite'),
    store = new Store(file),
    auth = new AuthManager(authFile),
    server = createApp(store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  let cookie = '';
  const req = (path: string, body?: unknown, method = 'POST', who = 'owner', csrf = true) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : method,
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-ERP-Auth-Token': auth.csrf } : {}),
        ...(who === 'owner' && cookie
          ? { Cookie: cookie }
          : who === 'reader' && readerCookie
            ? { Cookie: readerCookie }
            : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let readerCookie = '';
  const r = await req('/auth/setup', { name: '采购仓库测试管理员', password });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  const db = new DatabaseSync(authFile),
    row = db.prepare('SELECT * FROM users LIMIT 1').get()!;
  db.prepare(
    'INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)',
  ).run(randomUUID(), '只读', row.salt, row.password_hash, '[]', 'admin');
  db.close();
  const reader = await req('/auth/login', { name: '只读', password }, 'POST', 'anonymous');
  readerCookie = reader.headers.get('set-cookie')!.split(';')[0];
  const good = async (path: string, body?: unknown, method = 'POST') => {
    const r = await req(path, body, method),
      v = await r.json();
    assert.ok(r.ok, JSON.stringify({ path, status: r.status, ...v }));
    return v;
  };
  const supplier = await good('/suppliers', { name: '外购纸板供应商（虚构）' }),
    customer = await good('/customers', { name: '采购关联客户（虚构）' }),
    product = await good('/products', { name: '成品纸箱（虚构）' }),
    order = await good('/orders', {
      customerId: customer.id,
      orderDate: '2026-10-25',
      deliveryDate: '2026-11-05',
      status: '已确认',
      lines: [
        {
          productId: product.id,
          quantity: 1000,
          unitPriceCents: 139,
          unitPriceExact: '1.3900',
          unit: '只',
        },
      ],
    });
  const line = (patch: any = {}) => ({
    name: '外购三层纸板（虚构）',
    unit: '张',
    quantity: '1000',
    unitPrice: '1.3900',
    ...patch,
  });
  const purchase = (patch: any = {}) =>
    good('/purchases', {
      supplierId: supplier.id,
      customerOrderId: order.id,
      orderDate: '2026-10-25',
      status: '已订货',
      lines: [line()],
      ...patch,
    });
  const receive = (p: any, qty: string, reference = 'DN-' + randomUUID(), patch: any = {}) => ({
    expectedVersion: p.version,
    requestId: randomUUID(),
    reference,
    date: '2026-10-26',
    items: [{ lineId: p.lines[0].id, quantity: qty }],
    acknowledged: true,
    ...patch,
  });
  const move = (item: any, action: string, quantity: string, patch: any = {}) => ({
    expectedVersion: item.version,
    requestId: randomUUID(),
    action,
    quantity,
    date: '2026-10-26',
    notes: '经人工核对的虚构库存用途',
    acknowledged: true,
    ...patch,
  });
  const batch = (entity: string, row: any, action = 'archive') =>
    good('/' + entity + '/batch', {
      action,
      acknowledged: true,
      items: [{ id: row.id, version: row.version }],
    });
  return {
    dir,
    file,
    store,
    auth,
    req,
    good,
    supplier,
    customer,
    product,
    order,
    line,
    purchase,
    receive,
    move,
    batch,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      auth.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('数量及金额使用十进制精确换算，库存按数量单位保存；缺少尺寸配纸价格可创建采购', async () => {
  assert.equal(quantityUnits('0.125'), 125);
  assert.equal(quantityString(1000000), '1000');
  assert.equal(lineMoney('0.125', '1.2345'), '0.1543125');
  assert.equal(
    stockItemSchema.parse({
      name: '可选资料空白',
      kind: 'raw',
      unit: '张',
      length: ' ',
      productId: '',
    }).length,
    null,
  );
  assert.throws(() => quantityUnits('1.2345'));
  const f = await fixture();
  try {
    const p = await f.purchase({
      customerOrderId: null,
      expectedDate: null,
      status: '待订货',
      lines: [f.line({ unitPrice: null })],
    });
    assert.equal(p.lines[0].length, null);
    assert.equal(p.lines[0].unitPrice, null);
    assert.equal(p.totalAmount, null);
    assert.equal(p.customerOrderId, null);
    assert.equal(p.status, '待订货');
    assert.equal((await f.req('/purchases/' + p.id + '/receive', f.receive(p, '10'))).status, 400);
    assert.equal((await f.good('/warehouse/items')).length, 0);
    assert.ok(f.store.db.prepare("SELECT 1 FROM business_audit WHERE entity='purchases'").get());
  } finally {
    await f.close();
  }
});

test('供应商创建编辑搜索筛选、历史采购关联及采购单客户订单关联真实持久保存', async () => {
  const f = await fixture();
  try {
    let p = await f.purchase();
    assert.equal(p.customerOrderId, f.order.id);
    assert.equal(p.customerOrderNumber, f.order.number);
    assert.equal(p.totalAmount, '1390.0000000');
    let s = await f.good(
      '/suppliers/' + f.supplier.id,
      { ...f.supplier, phone: '13800000000', notes: '送货时间协商' },
      'PUT',
    );
    assert.equal(s.version, 2);
    const rows = await f.good('/suppliers?q=13800000000');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].purchaseHistory[0].id, p.id);
    assert.equal((await f.good('/purchases?supplierId=' + s.id + '&status=已订货')).length, 1);
    const other = await f.good('/suppliers', { name: '第二供应商' });
    p = await f.good(
      '/purchases/' + p.id,
      { ...p, supplierId: other.id, status: p.baseStatus, notes: '变更供应商' },
      'PUT',
    );
    assert.equal(p.supplierName, other.name);
    const copy = new Store(f.file);
    assert.equal(copy.purchases()[0].supplierId, other.id);
    assert.equal(copy.suppliers().find((s) => s.id === f.supplier.id)!.phone, '13800000000');
    assert.equal(copy.orders().length, 1);
    copy.close();
  } finally {
    await f.close();
  }
});

test('采购分两批到货自动增加同一原材料库存，派生部分/全部状态，重启后流水和数量完整', async () => {
  const f = await fixture();
  try {
    let p = await f.purchase();
    let result = await f.good('/purchases/' + p.id + '/receive', f.receive(p, '400', 'DN-FIRST'));
    p = result.purchase;
    assert.equal(p.status, '部分到货');
    assert.equal(p.lines[0].receivedQuantity, '400');
    let stock = (await f.good('/warehouse/items?kind=raw'))[0];
    assert.equal(stock.quantity, '400');
    const id = stock.id;
    result = await f.good('/purchases/' + p.id + '/receive', f.receive(p, '600', 'DN-SECOND'));
    p = result.purchase;
    assert.equal(p.status, '全部到货');
    assert.equal(p.lines[0].receivedQuantity, '1000');
    stock = (await f.good('/warehouse/items'))[0];
    assert.equal(stock.id, id);
    assert.equal(stock.quantity, '1000');
    assert.equal(p.receipts.length, 2);
    const movements = await f.good('/warehouse/movements?itemId=' + id);
    assert.equal(movements.length, 2);
    assert.equal(movements[0].source_kind, 'purchase_receipt');
    assert.equal(movements[0].actor_name, '采购仓库测试管理员');
    assert.equal(movements[0].purchaseNumber, p.number);
    const summary = await f.good('/warehouse/summary?kind=raw');
    assert.equal(summary[0].quantity, '1000');
    assert.equal(summary[0].unit, '张');
    const copy = new Store(f.file);
    assert.equal(copy.stock_items()[0].quantity, '1000');
    assert.equal(copy.purchases()[0].status, '全部到货');
    assert.deepEqual(copy.db.prepare('PRAGMA foreign_key_check').all(), []);
    copy.close();
  } finally {
    await f.close();
  }
});

test('到货幂等、同送货单不同凭据重复拦截、超量、并发旧版本和整批失败都不产生重复库存', async () => {
  const f = await fixture();
  try {
    let p = await f.purchase();
    const body = f.receive(p, '400', 'UNIQUE-DN');
    const a = await f.good('/purchases/' + p.id + '/receive', body),
      b = await f.good('/purchases/' + p.id + '/receive', body);
    assert.equal(a.receiptId, b.receiptId);
    p = a.purchase;
    assert.equal(
      (await f.req('/purchases/' + p.id + '/receive', f.receive(p, '100', 'UNIQUE-DN'))).status,
      409,
    );
    assert.equal((await f.req('/purchases/' + p.id + '/receive', f.receive(p, '601'))).status, 409);
    assert.equal((await f.good('/warehouse/items'))[0].quantity, '400');
    const results = await Promise.all([
      f.req('/purchases/' + p.id + '/receive', f.receive(p, '100', 'CONCURRENT-A')),
      f.req('/purchases/' + p.id + '/receive', f.receive(p, '100', 'CONCURRENT-B')),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await f.good('/warehouse/items'))[0].quantity, '500');
    const multi = await f.purchase({
      lines: [f.line({ name: '原材料A' }), f.line({ name: '原材料B' })],
    });
    const before = f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n;
    const bad = f.receive(multi, '10', 'ROLLBACK', {
      items: [
        { lineId: multi.lines[0].id, quantity: '10' },
        { lineId: multi.lines[1].id, quantity: '1001' },
      ],
    });
    assert.equal((await f.req('/purchases/' + multi.id + '/receive', bad)).status, 409);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, before);
    assert.equal((await f.good('/warehouse/items')).length, 1);
    assert.equal(f.store.purchases().find((p) => p.id === multi.id)!.lines[0].receivedUnits, 0);
    assert.equal(f.store.purchases().find((p) => p.id === multi.id)!.receipts.length, 0);
  } finally {
    await f.close();
  }
});

test('原材料与成品手工入出库、盘点记录增减、版本和幂等；负库存与未确认写入被拒绝', async () => {
  const f = await fixture();
  try {
    let raw = await f.good('/warehouse/items', { name: '独立纸板', kind: 'raw', unit: '平方米' }),
      finished = await f.good('/warehouse/items', {
        name: '成品箱',
        kind: 'finished',
        unit: '只',
        productId: f.product.id,
      });
    let body = f.move(raw, 'in', '0.125');
    let r = await f.good('/warehouse/items/' + raw.id + '/move', body);
    raw = r.item;
    assert.equal(raw.quantity, '0.125');
    assert.equal(
      (await f.good('/warehouse/items/' + raw.id + '/move', body)).movementId,
      r.movementId,
    );
    assert.equal(
      (await f.req('/warehouse/items/' + raw.id + '/move', f.move(raw, 'out', '0.126'))).status,
      409,
    );
    r = await f.good('/warehouse/items/' + raw.id + '/move', f.move(raw, 'out', '0.025'));
    raw = r.item;
    assert.equal(raw.quantity, '0.1');
    r = await f.good('/warehouse/items/' + raw.id + '/move', f.move(raw, 'adjust', '0'));
    raw = r.item;
    assert.equal(raw.quantity, '0');
    finished = (
      await f.good(
        '/warehouse/items/' + finished.id + '/move',
        f.move(finished, 'in', '500', { customerOrderId: f.order.id }),
      )
    ).item;
    assert.equal(finished.quantity, '500');
    finished = (
      await f.good('/warehouse/items/' + finished.id + '/move', f.move(finished, 'out', '100'))
    ).item;
    assert.equal(finished.quantity, '400');
    const summary = await f.good('/warehouse/summary');
    assert.equal(summary.length, 2);
    assert.ok(summary.some((s: any) => s.unit === '平方米' && s.quantity === '0'));
    assert.ok(summary.some((s: any) => s.unit === '只' && s.quantity === '400'));
    const flows = await f.good('/warehouse/movements?kind=raw');
    assert.equal(flows.length, 3);
    assert.equal(flows[0].action, 'adjust');
    assert.equal(flows[0].delta, '0.1');
    assert.equal(flows[0].after, '0');
    assert.equal(
      (
        await f.req(
          '/warehouse/items/' + raw.id + '/move',
          f.move(raw, 'in', '1', { acknowledged: false }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.req(
          '/warehouse/items/' + raw.id + '/move',
          f.move(raw, 'in', '1', { source_kind: 'purchase_receipt' }),
        )
      ).status,
      400,
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('mm/cm采购和库存尺寸正确换算；选用已有档案不猜测数量单位，有流水后不能改实际规格', async () => {
  const f = await fixture();
  try {
    let item = await f.good('/warehouse/items', {
      name: '厘米纸板',
      kind: 'raw',
      unit: '张',
      length: 30,
      width: 20,
      dimensionUnit: 'cm',
    });
    const p = await f.purchase({
      lines: [
        f.line({
          ...stockItemSchema.parse(item),
          stockItemId: item.id,
          length: 300,
          width: 200,
          dimensionUnit: 'mm',
        }),
      ],
    });
    await f.good('/purchases/' + p.id + '/receive', f.receive(p, '10'));
    item = (await f.good('/warehouse/items'))[0];
    assert.equal(item.quantity, '10');
    item = await f.good(
      '/warehouse/items/' + item.id,
      { ...item, length: 300, width: 200, dimensionUnit: 'mm' },
      'PUT',
    );
    assert.equal(item.length, 300);
    assert.equal(
      (await f.req('/warehouse/items/' + item.id, { ...item, length: 400 }, 'PUT')).status,
      400,
    );
    assert.equal(
      (
        await f.req('/purchases', {
          supplierId: f.supplier.id,
          orderDate: '2026-10-25',
          status: '已订货',
          lines: [f.line({ ...stockItemSchema.parse(item), stockItemId: item.id, unit: '只' })],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.req('/warehouse/items', {
          name: '未知单位数字',
          kind: 'raw',
          unit: '张',
          length: 30,
          dimensionUnit: '英寸',
        })
      ).status,
      400,
    );
    assert.equal(item.dimensionUnit, 'mm');
  } finally {
    await f.close();
  }
});

test('普通/超级权限、CSRF及归档编辑有效；采购、订单、库存关联阻止破坏性删除', async () => {
  const f = await fixture();
  try {
    for (const [path, body] of [
      ['/suppliers', { name: '越权' }],
      [
        '/purchases',
        { supplierId: f.supplier.id, orderDate: '2026-10-25', status: '已订货', lines: [f.line()] },
      ],
      ['/warehouse/items', { name: '越权', kind: 'raw', unit: '张' }],
    ] as const) {
      assert.equal((await f.req(path, body, 'POST', 'anonymous')).status, 401);
      assert.equal((await f.req(path, body, 'POST', 'reader')).status, 403);
      assert.equal((await f.req(path, body, 'POST', 'owner', false)).status, 403);
    }
    let p = await f.purchase();
    const deleteOrder = await f.batch('orders', f.order);
    assert.equal(
      (await f.req('/purchases/' + p.id + '/receive', f.receive(p, '1'), 'POST', 'reader')).status,
      403,
    );
    assert.equal(
      (await f.req('/purchases/' + p.id + '/receive', f.receive(p, '1'), 'POST', 'anonymous'))
        .status,
      401,
    );
    assert.equal(deleteOrder.results[0].success, false);
    await f.batch('suppliers', f.supplier);
    assert.equal(
      (await f.req('/suppliers/' + f.supplier.id, { ...f.supplier, notes: '普通越权' }, 'PUT'))
        .status,
      404,
    );
    await f.good('/auth/super-admin/enter', { password });
    const edited = await f.good(
      '/suppliers/' + f.supplier.id,
      { ...f.supplier, notes: '超级模式修改归档' },
      'PUT',
    );
    assert.equal(edited.notes, '超级模式修改归档');
    assert.equal(edited.archived, true);
    await f.batch('suppliers', edited, 'restore');
    p = (await f.good('/purchases/' + p.id + '/receive', f.receive(p, '400'))).purchase;
    for (const [entity, row] of [
      ['suppliers', edited],
      ['purchases', p],
      ['orders', f.order],
      ['stock_items', (await f.good('/warehouse/items'))[0]],
    ]) {
      const preview = await f.good('/admin/permanent-deletions/preview', {
        entity,
        items: [{ id: row.id, version: row.version }],
        includeRelatedOrders: true,
      });
      assert.ok(preview.plan.blockers.length, entity);
      assert.equal(
        (
          await f.req('/admin/permanent-deletions/execute', {
            previewId: preview.id,
            acknowledged: true,
            confirmation: '永久删除',
            password,
          })
        ).status,
        409,
      );
    }
    const item = (await f.good('/warehouse/items'))[0];
    assert.equal((await f.batch('stock_items', item)).results[0].success, false);
    assert.equal(f.store.order(f.order.id)!.id, f.order.id);
    assert.equal(f.store.purchases().length, 1);
    assert.equal(f.store.stock_items()[0].quantity, '400');
  } finally {
    await f.close();
  }
});

test('部分到货后锁定明细和实际库存；取消仅停止余量，归档恢复不回退流水', async () => {
  const f = await fixture();
  try {
    let p = await f.purchase();
    p = (await f.good('/purchases/' + p.id + '/receive', f.receive(p, '400'))).purchase;
    assert.equal((await f.batch('purchases', p)).results[0].success, false);
    assert.equal(
      (
        await f.req(
          '/purchases/' + p.id,
          { ...p, status: p.baseStatus, lines: [{ ...p.lines[0], quantity: '2000' }] },
          'PUT',
        )
      ).status,
      400,
    );
    p = await f.good(
      '/purchases/' + p.id,
      { ...p, status: '已取消', notes: '取消未到货600张' },
      'PUT',
    );
    assert.equal(p.status, '已取消');
    assert.equal((await f.req('/purchases/' + p.id + '/receive', f.receive(p, '600'))).status, 400);
    assert.equal((await f.batch('purchases', p)).results[0].success, true);
    assert.equal(f.store.stock_items()[0].quantity, '400');
    assert.equal((await f.batch('purchases', p, 'restore')).results[0].success, true);
    assert.equal(f.store.stock_items()[0].quantity, '400');
    assert.equal(f.store.purchases()[0].receipts.length, 1);
    const receipts = f.store.db.prepare('SELECT COUNT(*) n FROM purchase_receipts').get()!.n;
    assert.equal(receipts, 1);
    let item = (await f.good('/warehouse/items'))[0];
    item = (await f.good('/warehouse/items/' + item.id + '/move', f.move(item, 'out', '400'))).item;
    assert.equal(
      (
        await f.req(
          '/warehouse/items/' + item.id + '/move',
          f.move(item, 'in', '1'),
          'POST',
          'reader',
        )
      ).status,
      403,
    );
    assert.equal((await f.batch('stock_items', item)).results[0].success, true);
    await f.good('/auth/super-admin/enter', { password });
    p = await f.good(
      '/purchases/' + p.id,
      { ...p, status: p.baseStatus, notes: '归档库存引用保留时修改历史采购备注' },
      'PUT',
    );
    assert.match(p.notes, /历史采购备注/);
  } finally {
    await f.close();
  }
});

test('供应商批量归档/恢复及无历史记录永久删除沿用受控模式，重启保留', async () => {
  const f = await fixture();
  try {
    const a = await f.good('/suppliers', { name: '待删供应商A' }),
      b = await f.good('/suppliers', { name: '待删供应商B' });
    let results = await f.good('/suppliers/batch', {
      action: 'archive',
      acknowledged: true,
      items: [
        { id: a.id, version: a.version },
        { id: b.id, version: b.version },
      ],
    });
    assert.ok(results.results.every((r: any) => r.success));
    assert.equal((await f.good('/suppliers?archived=1')).length, 2);
    await f.good('/auth/super-admin/enter', { password });
    const preview = await f.good('/admin/permanent-deletions/preview', {
      entity: 'suppliers',
      items: [
        { id: a.id, version: 1 },
        { id: b.id, version: 1 },
      ],
      includeRelatedOrders: false,
    });
    assert.equal(preview.plan.blockers.length, 0);
    assert.equal(
      (
        await f.req('/admin/permanent-deletions/execute', {
          previewId: preview.id,
          acknowledged: true,
          confirmation: '永久删除',
          password,
        })
      ).status,
      200,
    );
    const copy = new Store(f.file);
    assert.equal(copy.suppliers(true).length, 1);
    copy.close();
    assert.equal((await f.batch('suppliers', a, 'restore')).results[0].success, false);
  } finally {
    await f.close();
  }
});

test('版本5非空业务库安全迁移为6，旧订单/明细/审计原样保留，新模块不自动填入示例', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify([
      f.store.customers(true),
      f.store.products(true),
      f.store.orders(true),
      f.store.db.prepare('SELECT * FROM business_audit ORDER BY id').all(),
    ]);
    f.store.db.exec(
      'DROP TABLE stock_movements; DROP TABLE purchase_receipts; DROP TABLE operation_requests; DROP TABLE purchase_lines; DROP TABLE purchases; DROP TABLE stock_items; DROP TABLE suppliers; DELETE FROM schema_migrations WHERE version=6',
    );
    const copy = new Store(f.file);
    try {
      assert.equal(
        JSON.stringify([
          copy.customers(true),
          copy.products(true),
          copy.orders(true),
          copy.db.prepare('SELECT * FROM business_audit ORDER BY id').all(),
        ]),
        before,
      );
      assert.equal(copy.suppliers().length, 0);
      assert.equal(copy.purchases().length, 0);
      assert.equal(copy.stock_items().length, 0);
      assert.equal(copy.db.prepare('SELECT MAX(version) n FROM schema_migrations').get()!.n, 11);
      assert.deepEqual(copy.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      copy.close();
    }
  } finally {
    await f.close();
  }
});

test('导航分组和业务元数据对应实际新表，采购库存不是AI可执行工具', async () => {
  const nav = renderToStaticMarkup(
    createElement(Navigation, { page: 'purchases', navigate: () => {} }),
  );
  for (const t of [
    '订单业务',
    '客户订单',
    '采购订货',
    '往来单位',
    '供应商管理',
    '仓库管理',
    'aria-expanded',
  ])
    assert.ok(nav.includes(t));
  const f = await fixture();
  try {
    const meta = await f.good('/business/metadata');
    assert.equal(meta.catalogVersion, '26');
    assert.equal(meta.purchasingWarehouse.aiEnabled, false);
    assert.ok(meta.modules.suppliers);
    assert.ok(meta.modules.purchase_receipts);
    assert.ok(meta.modules.stock_movements);
    assert.ok(!meta.operations.some((o: any) => o.name.startsWith('purchases.')));
    assert.ok(!meta.plannedModules.some((m: any) => ['inventory', 'purchasing'].includes(m.id)));
  } finally {
    await f.close();
  }
});
