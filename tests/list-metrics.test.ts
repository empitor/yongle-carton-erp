// 列表上方的统计（shared/business/business-metrics.ts 和各列表接口的 withMetrics）：逾期、未到齐、面积、档案、区间汇总，和列表同一范围。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/index.js';
import { createApp } from '../server/app.js';
import { listen, testProblems } from './http-fixture.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import {
  orderMetrics,
  purchaseMetrics,
  inventoryMetrics,
  productMetrics,
  productIncomplete,
  summarizeMovements,
} from '../shared/business/business-metrics.js';
import { productSchema, today } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import { monthsBefore } from '../shared/core/date-ranges.js';
import { receiveLines } from './receive-fixture.js';
import { z } from 'zod';
import { readAs } from './read-result.js';

/** 库存统计收的一个库存品 */
type InventoryRow = Parameters<typeof inventoryMetrics>[0][number];

test('交付逾期和采购未收齐按真实状态/日期/收货量计算，空日期和取消不判逾期', () => {
  assert.deepEqual(
    orderMetrics(
      [
        { status: '已确认', deliveryDate: '2026-10-24' },
        { status: '生产中', deliveryDate: null },
        { status: '待发货', deliveryDate: '2026-10-25' },
        { status: '已发货', deliveryDate: '2026-01-01' },
        { status: '已取消', deliveryDate: '2026-01-01' },
        { status: '待确认', deliveryDate: '2026-01-01' },
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
test('纸板平方米换算精确，厘米/毫米同规格识别；尺寸单位不明的不算面积；成品按“只”合计', () => {
  const raw = (id: number, patch: Partial<InventoryRow> = {}): InventoryRow => ({
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
      raw(4, { dimensionUnit: null, balanceUnits: 2000 }),
      raw(6, { balanceUnits: 0 }),
    ],
    'raw',
  );
  assert.equal(v.areaSquareMetres, '5.25');
  assert.equal(v.areaConverted, 2);
  assert.equal(v.areaExcluded, 1);
  assert.equal(v.varieties, 2);
  assert.equal(v.lowStockConfigured, false);
  assert.equal(v.lowStockCount, null);
  assert.equal(
    inventoryMetrics([raw(1, { length: 0.1, width: 0.2, balanceUnits: 3 })], 'raw')
      .areaSquareMetres,
    '0.00000000006',
  );
  assert.equal(inventoryMetrics([raw(1, { balanceUnits: 0 })], 'raw').varieties, 0);
  const finished = inventoryMetrics(
    [0, 1, 2].map((i) => raw(i, { kind: 'finished', productId: i + 1, unit: '只', length: 1000 + i, balanceUnits: (i + 2) * 1000 })),
    'finished',
  );
  assert.equal(finished.varieties, 3);
  assert.deepEqual(finished.quantities, [{ unit: '只', quantity: '9' }]);
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
    { id: 1, name: '同名产品', kind: 'finished', unit: '只', quantity: '10', specification: 'A型' },
    { id: 2, name: '同名产品', kind: 'finished', unit: '只', quantity: '20', specification: 'B型' },
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
  assert.equal(groups[1].currentQuantity, '20', '同名的两个库存品各算各的');
  assert.equal(groups[2].incoming, '0');
  assert.equal(groups[2].currentQuantity, '5');
});
const actor = pageActor({ id: 'metric-test', name: '虚构统计验收', permissions: ['business:edit'] });

/**
 * 统计接口的虚构数据：统计客户的五张订单（已确认、待发货、已发货、已取消、待确认，只有待发货是今天下单、今天交货），
 * 完整纸箱、待完善纸箱两个产品；采购和库存见 seedStock。
 */
function metricsWorld() {
  const records = businessBase(actor),
    { store } = records;
  const date = today(),
    old = monthsBefore(date, 3),
    boundary = monthsBefore(date, 2),
    yesterday = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000)
      .toISOString()
      .slice(0, 10);
  const customer = records.customer({ name: '统计客户' });
  records.customer({ name: '其他客户' });
  const product = records.product({
    name: '完整纸箱',
    length: 30,
    width: 20,
    height: 10,
    dimensionUnit: 'cm',
    material: '配纸',
    flute: 'B',
  });
  const pending = records.product({ name: '待完善纸箱' });
  for (const status of ['已确认', '待发货', '已发货', '已取消', '待确认'])
    records.order(customer, [{ productId: product.id, quantity: 1, unitPriceCents: 100 }], {
      orderDate: status === '待发货' ? date : old,
      deliveryDate: status === '待发货' ? date : yesterday,
      status,
    });
  seedStock(records, { old, yesterday, date, pending });
  return { store, date, boundary, product };
}

/**
 * 统计供应商的四张采购单（10 张到 4、5 张到齐、6 张没写到货日期、3 张已取消，纸板 1000×500mm），另一家供应商没有采购；
 * 挂在待完善纸箱上的历史成品三个月前入库 30 只。
 */
function seedStock(records: ReturnType<typeof businessBase>, d: { old: string; yesterday: string; date: string; pending: { id: number } }) {
  const { old, yesterday, date, pending } = d;
  const service = records.ops;
  const supplier = records.supplier({ name: '统计供应商' });
  records.supplier({ name: '其他供应商' });
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
            priceBasis: 'quantity',
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
    receiveLines(service.store, 
      p.id,
      {
        requestId: randomUUID(),
        reference: 'DN-' + p.id,
        date,
        items: [{ lineId: p.lines[0].id, quantity: qty }],
      },
      actor,
    );
  // 成品一定关联产品：挂在没有订单的“待完善纸箱”上，产品统计不变
  records.finished(pending, { name: '历史成品' }, { quantity: '30', date: old, notes: '历史入库' });
}

/** 全部表的全部行，看读接口有没有写库 */
const tableDump = (store: Store) =>
  JSON.stringify(
    store.db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((t) => [t.name, store.db.prepare('SELECT * FROM "' + String(t.name) + '" ORDER BY rowid').all()]),
  );

/** 在 store 上起接口；get 读 200 的回答 */
async function served(store: Store) {
  const server = await listen(createApp(store, { problems: testProblems() }));
  const get = async (path: string) => {
    const r = await fetch(server.origin + '/api' + path);
    assert.equal(r.status, 200, path);
    const body: unknown = await r.json();
    return body;
  };
  return { server, get, base: server.origin + '/api' };
}

/** 列表回答里的筛出行、全部条数和统计（统计照原样比） */
const listShape = { totalRecords: z.number(), rows: z.array(z.unknown()), metrics: z.unknown() };

test('真实HTTP列表与统计同范围，部分到货/档案筛选/面积/区间汇总正确且只读', async () => {
  const { store, date, boundary } = metricsWorld();
  const before = tableDump(store);
  const { server, get } = await served(store);
  const list = async (path: string) => readAs(await get(path), listShape);
  const rawMetrics = { raw: z.object({ areaSquareMetres: z.string(), varieties: z.number() }) };
  const movementMetrics = z.array(z.object({ incoming: z.string(), currentQuantity: z.string() }));
  try {
    const orders = await list('/orders?withMetrics=1&view=current&retainPending=1&start=' + boundary + '&end=' + date);
    assert.equal(orders.totalRecords, 5);
    assert.equal(orders.rows.length, 3);
    assert.deepEqual(orders.metrics, { total: 3, pending: 2, overdue: 1 });
    const purchases = readAs(await get('/purchases?withMetrics=1'), { metrics: z.unknown() });
    assert.deepEqual(purchases.metrics, { total: 4, pending: 2, overdue: 1 });
    const partial = await list('/purchases?withMetrics=1&status=' + encodeURIComponent('部分到货'));
    assert.equal(partial.totalRecords, 4);
    assert.deepEqual(partial.metrics, { total: 1, pending: 1, overdue: 1 });
    const products = await list('/products?withMetrics=1&incomplete=1');
    assert.equal(products.totalRecords, 2);
    assert.equal(products.rows.length, 1);
    assert.deepEqual(products.metrics, { total: 2, enabled: 2, incomplete: 1 });
    const customers = await list('/customers?withMetrics=1&q=' + encodeURIComponent('统计'));
    assert.equal(customers.totalRecords, 2);
    assert.equal(customers.rows.length, 1);
    assert.equal(customers.metrics, null);
    const supplierList = await list('/suppliers?withMetrics=1&history=with');
    assert.equal(supplierList.totalRecords, 2);
    assert.equal(supplierList.rows.length, 1);
    assert.equal(supplierList.metrics, null);
    const raw = readAs(await get('/warehouse/items?withMetrics=1&kind=raw'), { metrics: z.object(rawMetrics) });
    assert.equal(raw.metrics.raw.areaSquareMetres, '4.5');
    assert.equal(raw.metrics.raw.varieties, 1);
    const numericSearch = readAs(await get('/warehouse/items?withMetrics=1&kind=raw&q=99999'), { rows: z.array(z.unknown()), metrics: z.object(rawMetrics) });
    assert.equal(numericSearch.rows.length, 0);
    assert.equal(numericSearch.metrics.raw.varieties, 0);
    const flow = readAs(await get('/warehouse/movements?withMetrics=1&kind=finished&start=' + boundary + '&end=' + date), { rows: z.array(z.unknown()), metrics: movementMetrics });
    assert.equal(flow.rows.length, 0);
    assert.equal(flow.metrics[0].incoming, '0');
    assert.equal(flow.metrics[0].currentQuantity, '30');
    const all = readAs(await get('/warehouse/movements?withMetrics=1&kind=finished'), { metrics: movementMetrics });
    assert.equal(all.metrics[0].incoming, '30');
    assert.equal(all.metrics[0].currentQuantity, '30');
    const q = readAs(await get('/warehouse/movements?withMetrics=1&q=' + encodeURIComponent('1000')), { rows: z.array(z.object({ itemSpecification: z.string() })) });
    assert.ok(q.rows.length > 0);
    assert.ok(q.rows[0].itemSpecification.includes('1000'));
    assert.equal(tableDump(store), before);
  } finally {
    await server.close();
    store.close();
  }
});

test('归档的产品在统计里按停用算；没开登录看已归档的要先登录', async () => {
  const { store, product } = metricsWorld();
  const { server, get, base } = await served(store);
  try {
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
    const disabled = readAs(await get('/products?withMetrics=1&archived=1'), { rows: z.array(z.unknown()), metrics: z.object({ enabled: z.number() }) });
    assert.equal(disabled.metrics.enabled, 0);
    assert.equal(disabled.rows.length, 1);
    // 没开登录就认不出账号：看已归档的和全站别的要超级管理员模式的事一样，说请先登录（server/core/http/permissions.ts）
    assert.equal((await fetch(base + '/products?withMetrics=1&archived=all')).status, 401);
  } finally {
    await server.close();
    store.close();
  }
});
