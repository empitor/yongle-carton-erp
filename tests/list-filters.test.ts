// 列表的筛选和分页（server/core/paging.ts、server/business/record-lists.ts、server/operations/party-links.ts）：
// 流水的日期范围、接口组合筛选、分页统计，产品和库存按客户、供应商筛，页面和助手同一套。内存库、虚构数据。
import { pageActor, actor as assistantActor } from './actor-fixture.js';
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { customerList, orderDashboard, orderList, productList } from '../server/business/record-lists.js';
import { manualWrite } from '../server/business/service.js';
import { businessFixture } from './flow-fixture.js';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/core/db.js';
import { createApp } from '../server/app.js';
import { listen } from './http-fixture.js';
import { OperationsService } from '../server/operations/service.js';
import { today, customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { monthsBefore } from '../shared/core/date-ranges.js';
import { initialMovementRange, movementFilterSchema } from '../shared/business/movement-filters.js';
import { operationalSearchText } from '../shared/business/business-metrics.js';
import { Pagination, TableRegion } from '../src/ui/ListLayout.js';
import WarehouseNavigation from '../src/warehouse/WarehouseNavigation.js';
import { pageRows } from '../server/core/paging.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { productIdsOfCustomer, stockIdsOfParty } from '../server/operations/party-links.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { receiveLines } from './receive-fixture.js';
import type { StockItemView } from '../shared/business/index.js';
import { readAs } from './read-result.js';

const actor = pageActor({ id: 'ui', name: '虚构操作员', permissions: ['business:edit'] });

/**
 * 产品按客户、库存按客户/供应商筛选：产品和库存品本身不挂往来单位，
 * 靠订单明细、采购单关联出来；页面接口和助手查询是同一套。全部虚构数据。
 */
function fixture() {
  const store = new Store(':memory:'),
    ops = new OperationsService(store);
  const a = store.saveCustomer(customerSchema.parse({ name: '虚构甲客户' })),
    b = store.saveCustomer(customerSchema.parse({ name: '虚构乙客户' }));
  const boxA = store.saveProduct(productSchema.parse({ name: '虚构甲箱' })),
    boxB = store.saveProduct(productSchema.parse({ name: '虚构乙箱' })),
    idle = store.saveProduct(productSchema.parse({ name: '虚构没人订的箱' }));
  const order = (customerId: number, product: { id: number; name: string }) =>
    store.saveOrder(
      orderSchema.parse({
        customerId,
        orderDate: '2026-11-10',
        deliveryDate: '2026-11-20',
        status: '已确认',
        notes: '',
        costs: null,
        lines: [{ productId: product.id, productName: product.name, quantity: 100, unitPriceCents: 100, notes: '', unit: '只' }],
      }),
    );
  order(a.id, boxA);
  order(b.id, boxB);
  const finishedA = ops.saveItem({ name: boxA.name, kind: 'finished', unit: '只', productId: boxA.id }, assistantActor),
    finishedB = ops.saveItem({ name: boxB.name, kind: 'finished', unit: '只', productId: boxB.id }, assistantActor);
  const s1 = ops.saveSupplier({ name: '虚构一号纸板厂' }, assistantActor),
    s2 = ops.saveSupplier({ name: '虚构二号纸板厂' }, assistantActor);
  const board1 = ops.saveItem({ name: '虚构纸板一', kind: 'raw', unit: '张' }, assistantActor),
    board2 = ops.saveItem({ name: '虚构纸板二', kind: 'raw', unit: '张' }, assistantActor);
  const purchase = (supplierId: number, item: StockItemView) =>
    ops.savePurchase(
      {
        supplierId,
        status: '已订货',
        orderDate: '2026-11-01',
        lines: [{ ...item, stockItemId: item.id, quantity: '100', unitPrice: '1', priceBasis: 'quantity' }],
      },
      assistantActor,
    );
  purchase(s1.id, board1);
  purchase(s2.id, board2);
  return { store, a, b, boxA, boxB, idle, finishedA, finishedB, s1, s2, board1, board2 };
}

test('流水默认两自然月，支持月末/闰年、全部日期和自定义，旧流水不是自动归档', () => {
  assert.deepEqual(initialMovementRange(new URLSearchParams(), '2026-10-25'), {
    preset: '2',
    start: '2026-08-25',
    end: '2026-10-25',
  });
  assert.equal(
    initialMovementRange(new URLSearchParams('range=1'), '2024-03-31').start,
    '2024-02-29',
  );
  assert.equal(
    initialMovementRange(new URLSearchParams('range=3'), '2026-01-31').start,
    '2025-10-31',
  );
  assert.deepEqual(initialMovementRange(new URLSearchParams('range=all'), '2026-10-25'), {
    preset: 'all',
    start: '',
    end: '',
  });
  assert.deepEqual(
    initialMovementRange(new URLSearchParams('range=custom&start=2026-07-01&end=2026-07-31')),
    { preset: 'custom', start: '2026-07-01', end: '2026-07-31' },
  );
  assert.equal(movementFilterSchema.safeParse({ start: '2026-02-30' }).success, false);
  assert.equal(
    movementFilterSchema.safeParse({ start: '2026-03-01', end: '2026-02-01' }).success,
    false,
  );
});

test('仓库每次只选中一个视图，分页边界正确', () => {
  // 库存页只剩“原材料 / 成品”一个分段；到货、送货、流水走侧栏，不再放五张大卡片
  for (const view of ['raw', 'finished'] as const) {
    const html = renderToStaticMarkup(h(WarehouseNavigation, { view, onChange: () => {} }));
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
    assert.ok(html.includes('原材料') && html.includes('成品'));
    assert.ok(!html.includes('出入库流水'));
  }
  const first = renderToStaticMarkup(
    h(Pagination, { page: 1, total: 26, pageSize: 25, onChange: () => {} }),
  );
  assert.match(first, /aria-label="上一页" disabled/);
  assert.ok(!first.includes('aria-label="下一页" disabled'));
  const last = renderToStaticMarkup(
    h(Pagination, { page: 2, total: 26, pageSize: 25, onChange: () => {} }),
  );
  assert.match(last, /aria-label="下一页" disabled/);
  assert.ok(
    renderToStaticMarkup(h(TableRegion, { children: '完整字段' })).includes('tabindex="0"'),
  );
});

/**
 * 流水接口的虚构数据：原材料、成品各有三个月前的历史入库、两个月前那天（边界）的出库和今天的流水，
 * 今天还有一笔按采购单到货 3 张和 26 笔原材料入库（一共 32 笔流水）。
 */
function movementHistory() {
  const store = new Store(':memory:'),
    service = new OperationsService(store),
    actor = pageActor({ id: 'flow-test', name: '虚构仓库验收', permissions: ['business:edit'] });
  const date = today(),
    start = monthsBefore(date, 2),
    old = monthsBefore(date, 3);
  const raw = service.saveItem({ name: '测试原材料纸板', kind: 'raw', unit: '张' }, actor),
    // 成品一定关联产品
    boxed = store.saveProduct(productSchema.parse({ name: '测试成品纸箱' })),
    finished = service.saveItem({ name: '测试成品纸箱', kind: 'finished', unit: '只', productId: boxed.id }, actor);
  const move = (id: number, action: string, quantity: string, date: string, notes: string) => {
    const item = new OperationsRepository(store).items().find((r) => r.id === id);
    assert.ok(item);
    return service.move(
      id,
      {
        expectedVersion: item.version,
        requestId: randomUUID(),
        action,
        quantity,
        date,
        notes,
        acknowledged: true,
      },
      actor,
    );
  };
  move(raw.id, 'in', '50', old, '历史原材料入库');
  move(raw.id, 'out', '5', start, '边界原材料出库');
  move(raw.id, 'adjust', '40', date, '人工盘点');
  move(finished.id, 'in', '100', old, '历史成品入库');
  move(finished.id, 'out', '10', date, '成品出库');
  const supplier = service.saveSupplier({ name: '流水测试供应商' }, actor),
    p = service.savePurchase(
      {
        supplierId: supplier.id,
        orderDate: date,
        status: '已订货',
        lines: [
          { name: raw.name, stockItemId: raw.id, quantity: '3', unit: '张', unitPrice: '1.2345', priceBasis: 'quantity' },
        ],
      },
      actor,
    );
  receiveLines(service.store, 
    p.id,
    {
      requestId: randomUUID(),
      reference: 'UI-DELIVERY',
      date,
      items: [{ lineId: p.lines[0].id, quantity: '3' }],
    },
    actor,
  );
  for (let i = 0; i < 26; i++) move(raw.id, 'in', '1', date, '测试批次' + i);
  return { store, actor, date, start, old, raw, p };
}

/** 库里会被写的几张表和库存品的样子：查询前后要一模一样 */
const tablesOf = (store: Store) => ({
  movements: store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all(),
  audit: store.db.prepare('SELECT * FROM business_audit ORDER BY rowid').all(),
  life: store.db.prepare('SELECT * FROM record_lifecycle ORDER BY rowid').all(),
  items: new OperationsRepository(store).items(),
});

test('流水接口组合筛选、日期边界、历史查询；查询不改余额、审计和归档标记', async () => {
  const { store, actor, date, start, old, raw, p } = movementHistory();
  const before = tablesOf(store);
  const server = await listen(createApp(store));
  const base = server.origin + '/api/warehouse/movements';
  const get = async (q = '') => {
    const r = await fetch(base + q);
    assert.equal(r.status, 200);
    return z.array(z.object({ delta: z.string() })).parse(await r.json());
  };
  try {
    assert.equal((await get('?start=' + start + '&end=' + date)).length, 30);
    assert.equal((await get()).length, 32);
    assert.equal(
      (
        await get(
          '?kind=raw&action=out&start=' +
            start +
            '&end=' +
            start +
            '&q=' +
            encodeURIComponent('边界'),
        )
      ).length,
      1,
    );
    assert.equal((await get('?kind=finished&action=out&start=' + start)).length, 1);
    const received = await get('?kind=raw&action=purchase&q=' + p.number);
    assert.equal(received.length, 1);
    assert.equal(received[0].delta, '3');
    assert.equal((await get('?action=adjust&q=' + encodeURIComponent(actor.name))).length, 1);
    assert.equal((await get('?start=' + old + '&end=' + old)).length, 2);
    assert.equal((await get('?kind=finished&action=purchase')).length, 0);
    for (const q of [
      '?action=delete',
      '?kind=unknown',
      '?start=2026-02-30',
      '?start=' + date + '&end=' + old,
    ])
      assert.equal((await fetch(base + q)).status, 400);
    assert.deepEqual(tablesOf(store), before);
    assert.equal(new OperationsRepository(store).items().find((r) => r.id === raw.id)?.quantity, '69');
  } finally {
    await server.close();
    store.close();
  }
});

test('列表分页：不带页码保持全量，页码超出落到最后一页，排序跨页稳定', () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ id, number: 'N' + id, deliveryDate: '2026-11-0' + (6 - id) }));
  assert.deepEqual(pageRows(rows, {}), { rows, filteredRecords: 5 });
  const second = pageRows(rows, { page: '2', pageSize: '2', sort: 'recent' });
  assert.deepEqual(second.rows.map((r) => r.id), [3, 2]);
  assert.equal(second.filteredRecords, 5);
  assert.equal(second.page, 2);
  const beyond = pageRows(rows, { page: '99', pageSize: '2', sort: 'oldest' });
  assert.equal(beyond.page, 3);
  assert.deepEqual(beyond.rows.map((r) => r.id), [5]);
  assert.deepEqual(pageRows(rows, { page: '1', pageSize: '2', sort: 'due' }).rows.map((r) => r.id), [5, 4]);
  assert.equal(pageRows([], { page: '3' }).page, 1);
  assert.throws(() => pageRows(rows, { page: '1', pageSize: '1000' }));
  assert.throws(() => pageRows(rows, { page: '1', sort: '任意' }));
});

test('HTTP 分页：统计按完整筛选结果，不带页码的调用方仍拿到全量，采购可按主键读取', async () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构箱' })),
    supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
    // 成品一定关联产品：另建一个，不碰订单上的产品
    stocked = store.saveProduct(productSchema.parse({ name: '虚构成品' })),
    stock = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: stocked.id }, actor);
  const orders = [1, 2, 3].map((n) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-0' + n,
        deliveryDate: '2026-12-0' + n,
        status: '已确认',
        notes: '',
        costs: null,
        lines: [
          { productId: product.id, productName: product.name, specification: '', quantity: 10, unit: '只', unitPriceCents: 100 },
        ],
      }),
    ),
  );
  const purchases = [1, 2, 3].map(() =>
    ops.savePurchase(
      { supplierId: supplier.id, orderDate: '2026-10-01', status: '已订货', notes: '', lines: [{ name: '虚构纸板', length: 1000, width: 800, dimensionUnit: 'mm', unit: '张', quantity: '5', priceBasis: 'quantity' }] },
      actor,
    ),
  );
  for (let n = 0, version = stock.version; n < 3; n++, version++)
    ops.move(
      stock.id,
      { action: 'in', quantity: '1', date: '2026-10-01', notes: '虚构', acknowledged: true, requestId: randomUUID(), expectedVersion: version },
      actor,
    );
  const server = await listen(createApp(store));
  const get = async (path: string) => {
    const r = await fetch(server.origin + '/api' + path);
    const body: unknown = await r.json();
    return { status: r.status, body };
  };
  // 回答里要看的几项：一页的编号、筛出的条数、统计
  const idRows = { rows: z.array(z.object({ id: z.number() })), filteredRecords: z.number() },
    total = z.object({ total: z.number() }),
    list = z.array(z.unknown());
  try {
    const paged = readAs((await get('/orders?withMetrics=1&page=2&pageSize=2&sort=recent')).body, { ...idRows, totalRecords: z.number(), page: z.number(), metrics: total });
    assert.deepEqual(paged.rows.map((o) => o.id), [orders[0].id]);
    assert.equal(paged.filteredRecords, 3);
    assert.equal(paged.totalRecords, 3);
    assert.equal(paged.page, 2);
    assert.equal(paged.metrics.total, 3);
    assert.equal(list.parse((await get('/orders')).body).length, 3);
    assert.equal(readAs((await get('/orders?withMetrics=1')).body, idRows).rows.length, 3);
    const paid = readAs((await get('/purchases?withMetrics=1&page=1&pageSize=1&sort=oldest')).body, { ...idRows, metrics: total, suppliers: z.unknown() });
    assert.deepEqual(paid.rows.map((p) => p.id), [purchases[0].id]);
    assert.equal(paid.filteredRecords, 3);
    assert.equal(paid.metrics.total, 3);
    assert.deepEqual(paid.suppliers, [{ id: supplier.id, name: '虚构供应商' }]);
    assert.equal(readAs((await get('/purchases/' + purchases[1].id)).body, { id: z.number() }).id, purchases[1].id);
    assert.equal((await get('/purchases/999999')).status, 404);
    const moves = readAs((await get('/warehouse/movements?withMetrics=1&page=1&pageSize=2')).body, { rows: list, filteredRecords: z.number(), metrics: list });
    assert.equal(moves.rows.length, 2);
    assert.equal(moves.filteredRecords, 3);
    assert.equal(moves.metrics.length >= 1, true);
    assert.equal(list.parse((await get('/warehouse/movements')).body).length, 3);
    assert.equal((await get('/orders?withMetrics=1&page=1&pageSize=9999')).status, 400);
  } finally {
    await server.close();
    store.close();
  }
});

test('客户订过的产品、从供应商采购过的原材料、客户产品的成品库存', (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  assert.deepEqual([...productIdsOfCustomer(f.store, f.a.id)], [f.boxA.id]);
  assert.deepEqual([...(stockIdsOfParty(f.store, { customerId: f.b.id }) ?? [])], [f.finishedB.id]);
  assert.deepEqual([...(stockIdsOfParty(f.store, { supplierId: f.s1.id }) ?? [])], [f.board1.id]);
  assert.equal(stockIdsOfParty(f.store, {}), null, '没有筛选条件时不过滤');
});

test('产品、库存列表接口按客户和供应商筛', async () => {
  const f = fixture();
  const server = await listen(createApp(f.store));
  const base = server.origin + '/api';
  const names = async (path: string) => {
    const body: unknown = await (await fetch(base + path)).json();
    return readAs(body, { rows: z.array(z.object({ name: z.string() })) }).rows.map((r) => r.name);
  };
  try {
    assert.deepEqual(await names('/products?withMetrics=1&customerId=' + f.a.id), ['虚构甲箱']);
    assert.equal((await names('/products?withMetrics=1')).length, 3, '不选客户时全部产品，包括没人订过的');
    assert.deepEqual(await names('/warehouse/items?withMetrics=1&kind=finished&customerId=' + f.b.id), ['虚构乙箱']);
    assert.deepEqual(await names('/warehouse/items?withMetrics=1&kind=raw&supplierId=' + f.s2.id), ['虚构纸板二']);
    assert.equal((await names('/warehouse/items?withMetrics=1&kind=raw')).length, 2);
  } finally {
    await server.close();
    f.store.close();
  }
});

test('助手按客户查产品、按供应商或客户查库存，和页面结果一样', (t) => {
  const f = fixture(),
    tools = new AssistantTools(f.store);
  t.after(() => f.store.close());
  const ids = (module: string, filters: Record<string, number>) =>
    readAs(tools.read('records.search', { module, filters }, assistantActor), {
      results: z.array(z.object({ record: z.object({ id: z.number() }) })),
    }).results.map((r) => r.record.id);
  assert.deepEqual(ids('products', { customerId: f.a.id }), [f.boxA.id]);
  assert.deepEqual(ids('raw_inventory', { supplierId: f.s1.id }), [f.board1.id]);
  assert.deepEqual(ids('finished_inventory', { customerId: f.a.id }), [f.finishedA.id]);
});

test('客户、产品、订单列表和手工保存：直接调业务汇总的服务，不经接口；手工保存版本不对整笔不落库', () => {
  const f = businessFixture();
  try {
    const list = orderList(f.store, { withMetrics: '1', status: '已确认' }, false);
    assert.ok(!Array.isArray(list), '带 withMetrics 是分页结果');
    assert.deepEqual(list.rows.map((o) => o.id), [f.order.id]);
    assert.deepEqual([list.totalRecords, list.metrics.total], [1, 1]);
    const shipped = orderList(f.store, { status: '已发货' }, false);
    assert.ok(Array.isArray(shipped) && shipped.length === 0, '不带 withMetrics 直接返回数组');
    assert.throws(() => orderList(f.store, { start: '2026-12-01', end: '2026-01-01' }, false), /开始日期不能晚于结束日期/);
    const products = productList(f.store, { withMetrics: '1', customerId: String(f.customer.id) }, false);
    assert.ok(!Array.isArray(products));
    assert.deepEqual(products.rows.map((p) => p.id), [f.product.id], '按客户筛：这个客户下过单的产品');
    const customers = customerList(f.store, { q: '不存在的名字' }, false);
    assert.ok(Array.isArray(customers) && customers.length === 0);
    assert.equal(orderDashboard(f.store, { start: '2026-10-01', end: '2026-10-31' }).count, 1);
    // 手工保存：在一个保存点里办，办完写审计；版本不对整笔不落库
    const saved = manualWrite(f.store, { entity: 'customers', action: 'update', id: f.customer.id, input: { ...f.customer, notes: '直接调' } }, f.actor);
    assert.equal(saved.notes, '直接调');
    assert.ok(f.store.db.prepare("SELECT 1 FROM business_audit WHERE entity='customers' AND record_id=?").get(f.customer.id));
    assert.throws(() => manualWrite(f.store, { entity: 'customers', action: 'update', id: f.customer.id, input: { ...f.customer, notes: '旧版本' } }, f.actor));
    assert.equal(f.store.customer(f.customer.id)?.notes, '直接调');
  } finally {
    f.store.close();
  }
});

test('客户搜索：名称、联系人、电话、地址、备注都能搜到，“名称 联系人”跨栏整句也能搜到，客户页接口和命令面板用同一份文字', () => {
  const f = businessFixture();
  try {
    const fields = { name: '虚构搜索客户', contact: '虚构联系人', phone: '0574-0000', address: '虚构路一号', notes: '虚构备注词' };
    const saved = manualWrite(f.store, { entity: 'customers', action: 'update', id: f.customer.id, input: { ...f.customer, ...fields } }, f.actor);
    // 客户没有的栏目（单号、规格等）不占位置，字段之间只隔一个空格
    for (const word of [...Object.values(fields), fields.name + ' ' + fields.contact]) {
      const found = customerList(f.store, { withMetrics: '1', q: word }, false);
      assert.ok(!Array.isArray(found));
      assert.deepEqual(found.rows.map((c) => c.id), [f.customer.id], word);
      assert.ok(operationalSearchText(saved).includes(word.toLowerCase()), word);
    }
  } finally {
    f.store.close();
  }
});
