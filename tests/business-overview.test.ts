import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { OperationsService } from '../server/operations/service.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/domain.js';
import { monthsBefore, presetRange, orderInView } from '../shared/date-ranges.js';
import { buildDashboard } from '../server/business/dashboard.js';
import { displayAmount } from '../shared/display-amount.js';
import { changeLifecycle } from '../server/business/management.js';

test('自然月回退跨年、月末、闰年及包含边界，不按60天近似', () => {
  assert.equal(displayAmount('1157.5000000'), '1,157.50');
  assert.equal(displayAmount('0.1543125'), '0.1543125');
  assert.equal(monthsBefore('2026-10-25', 2), '2026-08-25');
  assert.equal(monthsBefore('2026-01-31', 2), '2025-11-30');
  assert.equal(monthsBefore('2024-03-31', 1), '2024-02-29');
  assert.equal(monthsBefore('2025-03-31', 1), '2025-02-28');
  assert.deepEqual(presetRange('3', '2026-05-31'), { start: '2026-02-28', end: '2026-05-31' });
  assert.deepEqual(presetRange('all'), { start: '', end: '' });
  const range = {
    view: 'current' as const,
    start: '2026-08-25',
    end: '2026-10-25',
    retainPending: true,
  };
  assert.equal(
    orderInView({ orderDate: '2026-08-25', status: '已发货' }, range, '2026-10-25'),
    true,
  );
  assert.equal(
    orderInView({ orderDate: '2026-08-24', status: '已发货' }, range, '2026-10-25'),
    false,
  );
  for (const status of ['草稿', '已确认', '生产中', '待发货'])
    assert.equal(orderInView({ orderDate: '2025-01-01', status }, range, '2026-10-25'), true);
  assert.equal(
    orderInView(
      { orderDate: '2026-08-24', status: '生产中' },
      { ...range, retainPending: false },
      '2026-10-25',
    ),
    false,
  );
  assert.equal(
    orderInView({ orderDate: '2026-08-24', status: '已取消' }, { view: 'history' }, '2026-10-25'),
    true,
  );
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-overview-')),
    file = join(dir, 'erp.sqlite'),
    store = new Store(file);
  const service = new OperationsService(store),
    actor = {
      id: 'overview-test',
      name: '虚构验收',
      permissions: ['business:edit'],
      role: 'admin' as const,
    };
  const customer = store.saveCustomer(customerSchema.parse({ name: '统计测试客户（虚构）' }));
  const product = store.saveProduct(productSchema.parse({ name: '统计测试纸箱（虚构）' }));
  const date = today(),
    boundary = monthsBefore(date, 2),
    old = monthsBefore(date, 3);
  const order = (orderDate: string, status: string) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate,
        deliveryDate: date,
        status,
        lines: [
          {
            productId: product.id,
            quantity: 10,
            unitPriceExact: '1.3900',
            unitPriceCents: 139,
            unit: '只',
          },
        ],
      }),
    );
  const recent = order(boundary, '已发货'),
    historical = order(old, '已发货'),
    pending = order(old, '生产中'),
    cancelled = order(old, '已取消');
  const supplier = service.saveSupplier({ name: '甲纸板供应商（虚构）' }, actor);
  const second = service.saveSupplier({ name: '乙纸板供应商（虚构）' }, actor);
  const purchase = (
    supplierId: number,
    orderDate: string,
    status = '已订货',
    unitPrice: string | null = '1.2345',
  ) =>
    service.savePurchase(
      {
        supplierId,
        orderDate,
        status,
        lines: [
          {
            name: '瓦楞纸板',
            specification: '测试独立规格',
            quantity: '10.125',
            unit: '张',
            unitPrice,
          },
        ],
      },
      actor,
    );
  const a = purchase(supplier.id, date),
    b = purchase(second.id, date),
    oldPurchase = purchase(supplier.id, old),
    unpriced = purchase(supplier.id, date, '待订货', null);
  service.receive(
    a.id,
    {
      expectedVersion: a.version,
      requestId: randomUUID(),
      reference: 'test-delivery',
      date,
      items: [{ lineId: a.lines[0].id, quantity: '4' }],
      acknowledged: true,
    },
    actor,
  );
  const finished = service.saveItem({ name: '成品（虚构）', kind: 'finished', unit: '只' }, actor);
  service.move(
    finished.id,
    {
      expectedVersion: finished.version,
      requestId: randomUUID(),
      action: 'in',
      quantity: '30',
      date: old,
      notes: '测试历史入库',
      acknowledged: true,
    },
    actor,
  );
  service.saveItem({ name: '零库存（虚构）', kind: 'raw', unit: '平方米' }, actor);
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  return {
    store,
    service,
    actor,
    file,
    base,
    date,
    boundary,
    old,
    recent,
    historical,
    pending,
    cancelled,
    supplier,
    second,
    a,
    b,
    oldPurchase,
    unpriced,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('HTTP订单日期分类保留历史未完成、归档可搜索、全部/自定义可查询且不写生命周期', async () => {
  const f = await fixture();
  try {
    const before = f.store.db.prepare('SELECT * FROM record_lifecycle').all();
    const get = async (q: string) => {
      const r = await fetch(f.base + q);
      assert.equal(r.status, 200);
      return r.json();
    };
    const rows = await get(
      '/orders?view=current&retainPending=1&start=' + f.boundary + '&end=' + f.date,
    );
    assert.deepEqual(
      rows.map((o: any) => o.id).sort((a: number, b: number) => a - b),
      [f.recent.id, f.pending.id].sort((a, b) => a - b),
    );
    const history = await get('/orders?view=history&q=' + f.historical.number);
    assert.deepEqual(
      history.map((o: any) => o.id),
      [f.historical.id],
    );
    const pending = await get('/orders?view=pending');
    assert.deepEqual(
      pending.map((o: any) => o.id),
      [f.pending.id],
    );
    const strict = await get('/orders?view=current&start=' + f.boundary + '&end=' + f.date);
    assert.equal(strict.length, 1);
    assert.equal((await get('/orders')).length, 4);
    assert.equal((await fetch(f.base + '/orders?start=' + f.date + '&end=' + f.old)).status, 400);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM record_lifecycle').all(), before);
    const copy = new Store(f.file);
    assert.equal(copy.orders().length, 4);
    copy.close();
    assert.equal(
      orderInView(f.recent, { view: 'history' }, monthsBefore(f.date, -1)),
      true,
      '时间推移自动分类，无需修改记录',
    );
    const removed = changeLifecycle(
      f.store,
      'orders',
      {
        action: 'archive',
        acknowledged: true,
        items: [{ id: f.cancelled.id, version: f.cancelled.version }],
      },
      f.actor,
    );
    assert.equal(removed.results[0].success, true);
    assert.deepEqual(
      (await get('/orders?view=history')).map((o: any) => o.id),
      [f.historical.id],
    );
    assert.deepEqual(
      (await get('/orders?archived=1')).map((o: any) => o.id),
      [f.cancelled.id],
    );
    assert.equal(f.store.orders(true).length, 4, '回收站软删除与日期归档均保留业务记录');
  } finally {
    await f.close();
  }
});
test('供应商名称、ID、采购日期、到货状态组合查询，筛选清空恢复全部，非法日期拒绝', async () => {
  const f = await fixture();
  try {
    const query = new URLSearchParams({
      supplierId: String(f.supplier.id),
      supplierName: '甲纸板',
      start: f.boundary,
      end: f.date,
      status: '部分到货',
      q: '独立规格',
    });
    const rows = await (await fetch(f.base + '/purchases?' + query)).json();
    assert.deepEqual(
      rows.map((r: any) => r.id),
      [f.a.id],
    );
    query.set('supplierId', String(f.second.id));
    assert.equal((await (await fetch(f.base + '/purchases?' + query)).json()).length, 0);
    assert.equal((await (await fetch(f.base + '/purchases')).json()).length, 4);
    assert.equal((await (await fetch(f.base + '/purchases?pending=1')).json()).length, 4);
    assert.equal(
      (await fetch(f.base + '/purchases?start=' + f.date + '&end=' + f.old)).status,
      400,
    );
    assert.equal((await fetch(f.base + '/purchases?start=2026-02-30')).status, 400);
  } finally {
    await f.close();
  }
});
test('经营概览来自订单/采购/流水：实时库存不截日期，不混合单位、金额精确、页面查询不改数据', async () => {
  const f = await fixture();
  try {
    const before = f.store.db.prepare('SELECT SUM(delta_units) n FROM stock_movements').get();
    const result = await (
      await fetch(f.base + '/dashboard?start=' + f.boundary + '&end=' + f.date)
    ).json();
    const v = result.overview;
    assert.equal(v.orders.total, 1);
    assert.equal(v.orders.pendingAll, 1);
    assert.equal(v.orders.history, 2);
    assert.equal(result.amountCents, 1390);
    assert.equal(v.purchases.total, 3);
    assert.equal(v.purchases.pendingAll, 4);
    assert.equal(v.purchases.unknownPrices, 1);
    assert.equal(v.purchases.amount, '24.9986250');
    assert.deepEqual(v.purchases.outstanding, [{ unit: '张', quantity: '36.5', itemCount: 4 }]);
    assert.equal(v.inventory.finished[0].quantity, '30');
    assert.equal(v.inventory.raw.find((g: any) => g.unit === '张').quantity, '4');
    assert.equal(v.inventory.raw.find((g: any) => g.unit === '平方米').quantity, '0');
    assert.equal(v.inventory.zeroCount, 1);
    assert.equal(v.products.total, f.store.products().length);
    assert.equal(v.movements.length, 1);
    assert.equal(v.movements[0].action, 'purchase');
    assert.ok(v.activity.some((a: any) => a.category === '采购订货'));
    assert.ok(v.activity.every((a: any) => a.date >= f.boundary));
    assert.deepEqual(
      f.store.db.prepare('SELECT SUM(delta_units) n FROM stock_movements').get(),
      before,
    );
    const empty = buildDashboard(f.store, [], { start: '2099-01-01', end: '2099-01-02' });
    assert.equal(empty.overview.purchases.total, 0);
    assert.equal(empty.overview.inventory.finished[0].quantity, '30');
    assert.equal(empty.overview.orders.pendingAll, 1);
  } finally {
    await f.close();
  }
});
