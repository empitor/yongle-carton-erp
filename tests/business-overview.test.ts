// 经营概览和订单的日期视图（server/overview/dashboard.ts、shared/core/date-ranges.ts）：按自然月算范围，
// 历史未完成的订单留在当前视图，概览的数字来自订单、采购、流水，查询不改数据；采购列表的组合查询用同一套数据。
// 工作台和今日队列见 workbench.test.ts。
import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { listen, testProblems } from './http-fixture.js';
import { today } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import { monthsBefore, presetRange, orderInView } from '../shared/core/date-ranges.js';
import { buildDashboard } from '../server/overview/dashboard.js';
import { displayAmount } from '../shared/core/display-amount.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { receiveLines } from './receive-fixture.js';
import { z } from 'zod';

const actor = pageActor({
  id: 'overview-test',
  name: '虚构验收',
  permissions: ['business:edit'],
  role: 'admin' as const,
});
/** 列表回答：每行的编号 */
const idList = z.array(z.looseObject({ id: z.number() }));
/** 首页回答里测试要看的几项（概览的订单、采购、库存、流水、动态） */
const count = z.number();
const dashboardAnswer = z.looseObject({
  amountCents: count,
  overview: z.looseObject({
    orders: z.looseObject({ total: count, pendingAll: count, history: count }),
    purchases: z.looseObject({ total: count, pendingAll: count, unknownPrices: count, amount: z.string(), outstanding: z.unknown() }),
    inventory: z.looseObject({
      finished: z.array(z.looseObject({ quantity: z.string() })),
      raw: z.array(z.looseObject({ unit: z.string(), quantity: z.string() })),
      zeroCount: count,
    }),
    products: z.looseObject({ total: count }),
    movements: z.array(z.looseObject({ action: z.string() })),
    activity: z.array(z.looseObject({ category: z.string(), date: z.string() })),
  }),
});
/** 今天、两个月前（视图边界）、三个月前 */
type Dates = { date: string; boundary: string; old: string };
type Records = ReturnType<typeof businessBase>;

/** 四张订单（各 10 只 × 1.39 元）：两个月前已发货、三个月前已发货、三个月前生产中、三个月前已取消 */
function seedOrders(records: Records, { date, boundary, old }: Dates) {
  const customer = records.customer({ name: '统计测试客户（虚构）' });
  const product = records.product({ name: '统计测试纸箱（虚构）' });
  const order = (orderDate: string, status: string) =>
    records.order(customer, [records.line(product, 10, { unitPriceExact: '1.3900', unitPriceCents: 139 })], { orderDate, deliveryDate: date, status });
  return {
    recent: order(boundary, '已发货'),
    historical: order(old, '已发货'),
    pending: order(old, '生产中'),
    cancelled: order(old, '已取消'),
  };
}

/**
 * 两家供应商的四张采购单（各 10.125 张，单价 1.2345）：甲今天一张（到货 4 张）、乙今天一张、甲三个月前一张、甲今天一张待订货没写单价；
 * 成品三个月前入库 30 只；另有一个零库存的原材料。
 */
function seedPurchases(records: Records, { date, old }: Dates) {
  const service = records.ops;
  const supplier = records.supplier({ name: '甲纸板供应商（虚构）' });
  const second = records.supplier({ name: '乙纸板供应商（虚构）' });
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
            length: 1000,
            width: 800,
            dimensionUnit: 'mm',
            quantity: '10.125',
            unit: '张',
            unitPrice,
            priceBasis: 'quantity',
          },
        ],
      },
      actor,
    );
  const a = purchase(supplier.id, date);
  purchase(second.id, date);
  purchase(supplier.id, old);
  purchase(supplier.id, date, '待订货', null);
  receiveLines(service.store, 
    a.id,
    {
      requestId: randomUUID(),
      reference: 'test-delivery',
      date,
      items: [{ lineId: a.lines[0].id, quantity: '4' }],
    },
    actor,
  );
  // 成品一定关联产品：另建一个只用来入库存的产品，不碰订单上的产品
  const stocked = records.product({ name: '成品（虚构）' });
  records.finished(stocked, { name: '成品（虚构）' }, { quantity: '30', date: old, notes: '测试历史入库' });
  // 一个没有库存的原材料档案（原材料只有“张”，数据库也只收“张”）：汇总里数量不变，零库存多一个
  records.raw({ name: '零库存（虚构）' });
  return { supplier, second, a };
}

async function fixture() {
  const records = businessBase(actor),
    { store } = records;
  const date = today(),
    dates = { date, boundary: monthsBefore(date, 2), old: monthsBefore(date, 3) };
  const orders = seedOrders(records, dates),
    purchases = seedPurchases(records, dates);
  const server = await listen(createApp(store, { problems: testProblems() }));
  const base = server.origin + '/api';
  return {
    store,
    actor,
    base,
    ...dates,
    ...orders,
    ...purchases,
    async close() {
      await server.close();
      store.close();
    },
  };
}

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
  for (const status of ['待确认', '已确认', '生产中', '待发货'])
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

test('HTTP订单日期分类保留历史未完成、归档可搜索、全部/自定义可查询且不写生命周期', async () => {
  const f = await fixture();
  try {
    const before = f.store.db.prepare('SELECT * FROM record_lifecycle').all();
    const get = async (q: string) => {
      const r = await fetch(f.base + q);
      assert.equal(r.status, 200);
      return idList.parse(await r.json());
    };
    const rows = await get(
      '/orders?view=current&retainPending=1&start=' + f.boundary + '&end=' + f.date,
    );
    assert.deepEqual(
      rows.map((o) => o.id).sort((a, b) => a - b),
      [f.recent.id, f.pending.id].sort((a, b) => a - b),
    );
    const history = await get('/orders?view=history&q=' + f.historical.number);
    assert.deepEqual(
      history.map((o) => o.id),
      [f.historical.id],
    );
    const pending = await get('/orders?view=pending');
    assert.deepEqual(
      pending.map((o) => o.id),
      [f.pending.id],
    );
    const strict = await get('/orders?view=current&start=' + f.boundary + '&end=' + f.date);
    assert.equal(strict.length, 1);
    assert.equal((await get('/orders')).length, 4);
    assert.equal((await fetch(f.base + '/orders?start=' + f.date + '&end=' + f.old)).status, 400);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM record_lifecycle').all(), before);
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
      (await get('/orders?view=history')).map((o) => o.id),
      [f.historical.id],
    );
    assert.deepEqual(
      (await get('/orders?archived=1')).map((o) => o.id),
      [f.cancelled.id],
    );
    assert.equal(sales(f.store).orders(true).length, 4, '回收站软删除与日期归档均保留业务记录');
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
    const list = async (path: string) => idList.parse(await (await fetch(f.base + path)).json());
    const rows = await list('/purchases?' + query);
    assert.deepEqual(
      rows.map((r) => r.id),
      [f.a.id],
    );
    query.set('supplierId', String(f.second.id));
    assert.equal((await list('/purchases?' + query)).length, 0);
    assert.equal((await list('/purchases')).length, 4);
    assert.equal((await list('/purchases?pending=1')).length, 4);
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
    const result = dashboardAnswer.parse(await (
      await fetch(f.base + '/dashboard?start=' + f.boundary + '&end=' + f.date)
    ).json());
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
    assert.equal(v.inventory.raw.find((g) => g.unit === '张')?.quantity, '4');
    assert.deepEqual(v.inventory.raw.map((g) => g.unit), ['张'], '原材料只有“张”一个单位');
    assert.equal(v.inventory.zeroCount, 1);
    assert.equal(v.products.total, sales(f.store).products().length);
    assert.equal(v.movements.length, 1);
    assert.equal(v.movements[0].action, 'purchase');
    assert.ok(v.activity.some((a) => a.category === '采购单'));
    assert.ok(v.activity.every((a) => a.date >= f.boundary));
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

