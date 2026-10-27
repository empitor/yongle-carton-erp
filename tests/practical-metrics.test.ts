import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { OperationsService } from '../server/operations/service.js';
import { changeLifecycle } from '../server/business/management.js';
import {
  orderMetrics,
  purchaseMetrics,
  inventoryMetrics,
  productMetrics,
  productIncomplete,
  summarizeMovements,
} from '../shared/business-metrics.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/domain.js';
import { monthsBefore } from '../shared/date-ranges.js';
test('交付逾期和采购未收齐按真实状态/日期/收货量计算，空日期和取消不判逾期', () => {
  assert.deepEqual(
    orderMetrics(
      [
        { status: '已确认', deliveryDate: '2026-10-24' },
        { status: '生产中', deliveryDate: null },
        { status: '待发货', deliveryDate: '2026-10-25' },
        { status: '已发货', deliveryDate: '2026-01-01' },
        { status: '已取消', deliveryDate: '2026-01-01' },
        { status: '草稿', deliveryDate: '2026-01-01' },
        { status: '已确认', deliveryDate: '' },
        { status: '生产中', deliveryDate: '2026-02-30' },
      ],
      '2026-10-25',
    ),
    { total: 8, pending: 5, overdue: 1 },
  );
  const p = (status: string, received: number, date: string | null) => ({
    status,
    expectedDate: date,
    lines: [{ quantityUnits: 10000, receivedUnits: received }],
  });
  assert.deepEqual(
    purchaseMetrics(
      [
        p('部分到货', 4000, '2026-10-24'),
        p('全部到货', 10000, '2026-10-24'),
        p('已订货', 0, null),
        p('已取消', 0, '2026-10-24'),
        p('待订货', 0, '2026-10-25'),
      ],
      '2026-10-25',
    ),
    { total: 5, pending: 3, overdue: 1 },
  );
  assert.deepEqual(orderMetrics([]), { total: 0, pending: 0, overdue: 0 });
  assert.deepEqual(purchaseMetrics([]), { total: 0, pending: 0, overdue: 0 });
});
test('纸板平方米换算精确，厘米/毫米同规格识别；未知单位不猜测，成品混合单位不相加', () => {
  const raw = (id: number, patch: any = {}) => ({
    id,
    kind: 'raw',
    unit: '张',
    length: 1000,
    width: 500,
    height: null,
    dimensionUnit: 'mm',
    material: 'A配纸',
    flute: 'B',
    balanceUnits: 10000,
    ...patch,
  });
  const v = inventoryMetrics(
    [
      raw(1),
      raw(2, { length: 100, width: 50, dimensionUnit: 'cm', balanceUnits: 500 }),
      raw(3, { unit: '平方米', balanceUnits: 1250 }),
      raw(4, { dimensionUnit: null, balanceUnits: 2000 }),
      raw(5, { unit: '箱', balanceUnits: 3000 }),
      raw(6, { balanceUnits: 0 }),
    ],
    'raw',
  );
  assert.equal(v.areaSquareMetres, '6.5');
  assert.equal(v.areaConverted, 3);
  assert.equal(v.areaExcluded, 2);
  assert.equal(v.varieties, 4);
  assert.equal(v.lowStockConfigured, false);
  assert.equal(v.lowStockCount, null);
  assert.equal(
    inventoryMetrics([raw(1, { length: 0.1, width: 0.2, balanceUnits: 3 })], 'raw')
      .areaSquareMetres,
    '0.00000000006',
  );
  assert.equal(inventoryMetrics([raw(1, { balanceUnits: 0 })], 'raw').varieties, 0);
  const finished = inventoryMetrics(
    ['箱', '个', '张'].map((unit, i) =>
      raw(i, { kind: 'finished', productId: 1, unit, balanceUnits: (i + 2) * 1000 }),
    ),
    'finished',
  );
  assert.equal(finished.varieties, 3);
  assert.deepEqual(
    finished.quantities.map((g) => g.quantity),
    ['2', '3', '4'],
  );
  assert.deepEqual(inventoryMetrics([], 'raw').quantities, []);
  assert.equal(inventoryMetrics([], 'raw').areaSquareMetres, '0');
});
test('档案启用来自停用/归档状态，资料不足只提示；同名不同库存品汇总独立', () => {
  const complete = {
    ...productSchema.parse({
      name: '完整产品',
      length: 30,
      width: 20,
      height: 10,
      dimensionUnit: 'cm',
      material: '配纸',
      flute: 'B',
    }),
    archived: true,
  };
  const incomplete = productSchema.parse({ name: '仅有名称也可创建' });
  assert.equal(productIncomplete(incomplete), true);
  assert.deepEqual(productMetrics([complete, incomplete]), { total: 2, enabled: 1, incomplete: 1 });
  const items = [
    { id: 1, name: '同名产品', kind: 'finished', unit: '箱', quantity: '10', specification: 'A型' },
    { id: 2, name: '同名产品', kind: 'finished', unit: '个', quantity: '20', specification: 'B型' },
    { id: 3, name: '无区间流水', kind: 'raw', unit: '张', quantity: '5' },
  ];
  const groups = summarizeMovements(
    [
      { item_id: 1, delta_units: 1000 },
      { item_id: 1, delta_units: -250 },
      { item_id: 2, delta_units: 2000 },
    ],
    items,
  );
  assert.equal(groups.length, 3);
  assert.equal(groups[0].incoming, '1');
  assert.equal(groups[0].outgoing, '0.25');
  assert.equal(groups[0].currentQuantity, '10');
  assert.equal(groups[1].unit, '个');
  assert.equal(groups[2].incoming, '0');
  assert.equal(groups[2].currentQuantity, '5');
});
test('真实HTTP列表与统计同范围，部分到货/档案筛选/面积/区间汇总正确且只读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-practical-metrics-')),
    file = join(dir, 'erp.sqlite'),
    store = new Store(file),
    service = new OperationsService(store),
    actor = { id: 'metric-test', name: '虚构统计验收', permissions: ['business:edit'] };
  const date = today(),
    old = monthsBefore(date, 3),
    boundary = monthsBefore(date, 2),
    yesterday = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000)
      .toISOString()
      .slice(0, 10);
  const customer = store.saveCustomer(customerSchema.parse({ name: '统计客户' }));
  store.saveCustomer(customerSchema.parse({ name: '其他客户' }));
  const product = store.saveProduct(
    productSchema.parse({
      name: '完整纸箱',
      length: 30,
      width: 20,
      height: 10,
      dimensionUnit: 'cm',
      material: '配纸',
      flute: 'B',
    }),
  );
  store.saveProduct(productSchema.parse({ name: '待完善纸箱' }));
  for (const status of ['已确认', '待发货', '已发货', '已取消', '草稿'])
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: status === '待发货' ? date : old,
        deliveryDate: status === '待发货' ? date : yesterday,
        status,
        lines: [{ productId: product.id, quantity: 1, unitPriceCents: 100 }],
      }),
    );
  const supplier = service.saveSupplier({ name: '统计供应商' }, actor);
  service.saveSupplier({ name: '其他供应商' }, actor);
  const createPurchase = (quantity: string, expectedDate: string | null, status = '已订货') =>
    service.savePurchase(
      {
        supplierId: supplier.id,
        orderDate: old,
        expectedDate,
        status,
        lines: [
          {
            name: '纸板',
            quantity,
            unit: '张',
            unitPrice: '1.23',
            length: 1000,
            width: 500,
            dimensionUnit: 'mm',
            material: '配纸',
            flute: 'B',
          },
        ],
      },
      actor,
    );
  const a = createPurchase('10', yesterday),
    b = createPurchase('5', yesterday);
  createPurchase('6', null);
  createPurchase('3', yesterday, '已取消');
  for (const [p, qty] of [
    [a, '4'],
    [b, '5'],
  ] as const)
    service.receive(
      p.id,
      {
        expectedVersion: p.version,
        requestId: randomUUID(),
        reference: 'DN-' + p.id,
        date,
        items: [{ lineId: p.lines[0].id, quantity: qty }],
        acknowledged: true,
      },
      actor,
    );
  const finished = service.saveItem({ name: '历史成品', kind: 'finished', unit: '只' }, actor);
  service.move(
    finished.id,
    {
      expectedVersion: finished.version,
      requestId: randomUUID(),
      action: 'in',
      quantity: '30',
      date: old,
      notes: '历史入库',
      acknowledged: true,
    },
    actor,
  );
  const before = JSON.stringify(
    store.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((t) => [
        t.name,
        store.db.prepare('SELECT * FROM "' + t.name + '" ORDER BY rowid').all(),
      ]),
  );
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  const get = async (path: string) => {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    return r.json();
  };
  try {
    const orders = await get(
      '/orders?withMetrics=1&view=current&retainPending=1&start=' + boundary + '&end=' + date,
    );
    assert.equal(orders.totalRecords, 5);
    assert.equal(orders.rows.length, 3);
    assert.deepEqual(orders.metrics, { total: 3, pending: 2, overdue: 1 });
    const purchases = await get('/purchases?withMetrics=1');
    assert.deepEqual(purchases.metrics, { total: 4, pending: 2, overdue: 1 });
    const partial = await get('/purchases?withMetrics=1&status=' + encodeURIComponent('部分到货'));
    assert.equal(partial.totalRecords, 4);
    assert.deepEqual(partial.metrics, { total: 1, pending: 1, overdue: 1 });
    const products = await get('/products?withMetrics=1&incomplete=1');
    assert.equal(products.totalRecords, 2);
    assert.equal(products.rows.length, 1);
    assert.deepEqual(products.metrics, { total: 2, enabled: 2, incomplete: 1 });
    const customers = await get('/customers?withMetrics=1&q=' + encodeURIComponent('统计'));
    assert.equal(customers.totalRecords, 2);
    assert.equal(customers.rows.length, 1);
    assert.equal(customers.metrics, null);
    const supplierList = await get('/suppliers?withMetrics=1&history=with');
    assert.equal(supplierList.totalRecords, 2);
    assert.equal(supplierList.rows.length, 1);
    assert.equal(supplierList.metrics, null);
    const raw = await get('/warehouse/items?withMetrics=1&kind=raw');
    assert.equal(raw.metrics.raw.areaSquareMetres, '4.5');
    assert.equal(raw.metrics.raw.varieties, 1);
    const numericSearch = await get('/warehouse/items?withMetrics=1&kind=raw&q=99999');
    assert.equal(numericSearch.rows.length, 0);
    assert.equal(numericSearch.metrics.raw.varieties, 0);
    const flow = await get(
      '/warehouse/movements?withMetrics=1&kind=finished&start=' + boundary + '&end=' + date,
    );
    assert.equal(flow.rows.length, 0);
    assert.equal(flow.metrics[0].incoming, '0');
    assert.equal(flow.metrics[0].currentQuantity, '30');
    const all = await get('/warehouse/movements?withMetrics=1&kind=finished');
    assert.equal(all.metrics[0].incoming, '30');
    assert.equal(all.metrics[0].currentQuantity, '30');
    const q = await get('/warehouse/movements?withMetrics=1&q=' + encodeURIComponent('1000'));
    assert.ok(q.rows.length > 0);
    assert.ok(q.rows[0].itemSpecification.includes('1000'));
    assert.equal(
      JSON.stringify(
        store.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((t) => [
            t.name,
            store.db.prepare('SELECT * FROM "' + t.name + '" ORDER BY rowid').all(),
          ]),
      ),
      before,
    );
    const archived = changeLifecycle(
      store,
      'products',
      {
        action: 'archive',
        acknowledged: true,
        items: [{ id: product.id, version: product.version }],
      },
      actor,
    );
    assert.equal(archived.results[0].success, true);
    const disabled = await get('/products?withMetrics=1&archived=1');
    assert.equal(disabled.metrics.enabled, 0);
    assert.equal(disabled.rows.length, 1);
    assert.equal((await fetch(base + '/products?withMetrics=1&archived=all')).status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
