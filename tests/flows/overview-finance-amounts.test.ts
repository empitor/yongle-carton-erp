// 经营概况的送货金额、到货金额和财务月度台账的理论收入、理论支出同一个口径、同一处算（虚构数据、内存库）
import { sales } from '../../server/sales/index.js';
import { trackOrders } from '../../server/orders/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildDashboard } from '../../server/overview/dashboard.js';
import { FinanceMonthly } from '../../server/finance/reports/monthly.js';
import { PurchaseReturns } from '../../server/flow/index.js';
import { maker, physical, deliveryDoc } from '../finance/finance-fixture.js';
import { flowFinance } from '../finance/finance-flow-fixture.js';
import { shipOnDocDate } from '../support/ship-date.js';
import { clerk, orderOf } from '../support/flow-fixture.js';
import { archiveDoc } from '../support/receive-fixture.js';
import { buildToday } from '../../server/overview/workbench.js';
import { orderDashboard } from '../../server/overview/dashboard.js';
import { changeLifecycle } from '../../server/lifecycle/index.js';
import { readSnapshot } from '../../server/finance/events/source-snapshot.js';
import { quantityUnits } from '../../shared/core/index.js';

test('同一批单据（部分送货、上个月的送货、撤销的送货、更正过的到货、退货）：经营概况的送货金额、到货金额等于财务同月的理论收入、理论支出', async () => {
  const t = await flowFinance();
  try {
    const { f } = t;
    // 送货：订单 100 只送了两回（部分送货），再送一张后撤销；9 月还有一张（不在 10 月里）
    t.deliver('30');
    t.deliver('25');
    t.reverse(t.deliver('5').id);
    const old = f.order(10, { orderDate: '2026-09-01', taxRate: 0, taxMode: '未税' });
    const september = f.draft('delivery', {
      date: '2026-09-28',
      customerId: f.customer.id,
      lines: [{ orderId: old.id, orderLineId: old.lines[0].id, stockId: f.finished.id, quantity: '7' }],
    });
    f.confirmId(september.id, shipOnDocDate(f.flow, september.id));
    // 到货：一张更正过数量（原单被替代），一张退了 3 张（退货不改到货单的金额）
    const corrected = t.receive('6000', '虚构供应商单号-甲');
    t.correctArrival(corrected.id, '5000');
    const returned = t.receive('2000', '虚构供应商单号-乙');
    new PurchaseReturns(f.store).create(maker, {
      arrivalId: returned.id,
      date: '2026-10-28',
      reason: '虚构质量问题',
      requestId: randomUUID(),
      lines: [{ lineIndex: 0, quantity: '3' }],
    });
    // 一张没写数量单位的送货单：算不出金额，两边都不计入合计，经营概况另计一张
    physical(f.store, 900, 'delivery', '2026-10-20', deliveryDoc('3', { line: { unit: '' } }));
    t.sync();
    const month = new FinanceMonthly(f.store).get(maker, { period: '2026-10' });
    const dashboard = buildDashboard(f.store, [], { start: '2026-10-01', end: '2026-10-31' }, '2026-10-31', { workbench: false });
    assert.deepEqual(
      [dashboard.deliveredCents, dashboard.overview.purchases.arrivedCents],
      [month.theoreticalIncome, month.theoreticalExpense],
    );
    assert.deepEqual([month.theoreticalIncome, month.theoreticalExpense], [5500, 700000], '55 只 × 1 元；7000 张 × 1 元');
    assert.deepEqual([dashboard.deliveryUncomputed, dashboard.overview.purchases.arrivalUncomputed], [1, 0], '缺数量单位的那张计入算不出金额的张数');
  } finally {
    t.f.store.close();
  }
});

test('到货明细没写计价方式：照常核对入库，计价方式留空、不按平方米算钱；经营概况和财务都按缺价格等人补', async () => {
  const t = await flowFinance();
  try {
    const { f } = t;
    const size = { length: 1000, width: 800, dimensionUnit: 'mm' };
    const board = f.ops.saveItem({ name: '虚构定尺纸板', kind: 'raw', unit: '张', ...size }, clerk);
    const arrival = f.confirm('arrival', {
      supplierId: f.supplier.id,
      reference: '虚构送货单-没写计价方式',
      lines: [
        { stockId: board.id, item: { name: board.name, unit: '张', ...size }, quantity: '10', unitPrice: '2', differenceReason: '虚构无采购单' },
      ],
    });
    assert.equal(arrival.status, 'confirmed', '缺计价方式不拦到货');
    assert.deepEqual([arrival.lines[0].priceBasis, arrival.lines[0].amount], [null, null], '没写就是没写，不默认按平方米');
    assert.equal(f.ops.items(true, board.id)[0].balanceUnits, quantityUnits('10'), '照常入库');
    const dashboard = buildDashboard(f.store, [], { start: '2026-10-01', end: '2026-10-31' }, '2026-10-31', { workbench: false });
    assert.deepEqual([dashboard.overview.purchases.arrivedCents, dashboard.overview.purchases.arrivalUncomputed], [0, 1]);
    t.sync();
    const e = t.current(arrival.id);
    assert.deepEqual([e.status, readSnapshot(e).missing], ['info_pending', ['price']], '财务按缺价格等人补');
  } finally {
    t.f.store.close();
  }
});

test('本月接单：财务月度台账和经营概况同一个口径，待确认、已取消的订单都不算', async () => {
  const t = await flowFinance();
  try {
    const { f } = t;
    f.order(30, { orderDate: '2026-10-05', status: '待确认' });
    f.order(40, { orderDate: '2026-10-06', status: '已取消' });
    const month = new FinanceMonthly(f.store).get(maker, { period: '2026-10' });
    const october = trackOrders(f.store, sales(f.store).orders()).filter((o) => o.orderDate.startsWith('2026-10'));
    const dashboard = buildDashboard(f.store, october, { start: '2026-10-01', end: '2026-10-31' }, '2026-10-31', { workbench: false });
    assert.equal(month.ordered, dashboard.amountCents);
    assert.equal(month.ordered, 10000, '只算已确认的那张：100 只 × 1 元');
  } finally {
    t.f.store.close();
  }
});

test('月度统计算上已归档的：发完货归档的订单、送货单和取消后归档的采购单照算，今日页、经营概况和财务的接单同一个数；列表不带已归档的', async () => {
  const t = await flowFinance();
  try {
    const { f, order } = t;
    const delivery = t.deliver('100');
    const cancelled = f.ops.savePurchase(
      { supplierId: f.supplier.id, orderDate: '2026-10-02', status: '已取消', lines: [{ stockItemId: f.raw.id, name: f.raw.name, unit: '张', quantity: '5', priceBasis: 'quantity' }] },
      clerk,
    );
    const shippedBefore = buildToday(f.store, '2026-10-31').summary.monthShippedAmount;
    archiveDoc(f.flow, delivery.id, false, clerk, f.flow.get(delivery.id).version);
    const archive = (entity: 'orders' | 'purchases', id: number, version: number) =>
      assert.ok(changeLifecycle(f.store, entity, { action: 'archive', items: [{ id, version }] }, clerk).results[0].success, entity);
    archive('orders', order.id, orderOf(f.store, order.id).version);
    archive('purchases', cancelled.id, cancelled.version);
    // 已归档的待确认、已取消订单照样不算接单
    for (const status of ['待确认', '已取消']) {
      const extra = f.order(30, { orderDate: '2026-10-05', status });
      archive('orders', extra.id, extra.version);
    }
    const today = buildToday(f.store, '2026-10-31');
    assert.deepEqual([today.summary.monthOrderCents, today.summary.monthShippedAmount], [10000, shippedBefore]);
    const overview = orderDashboard(f.store, { start: '2026-10-01', end: '2026-10-31' });
    assert.deepEqual([overview.count, overview.amountCents], [1, 10000], '有效订单只有发完货的那张');
    assert.deepEqual([overview.overview.orders.total, overview.overview.orders.archived], [3, 3], '订单总数含已归档 3 张');
    const archivedByStatus = Object.fromEntries(overview.byStatus.map((s) => [s.status, [s.count, s.archived]]));
    assert.deepEqual([archivedByStatus['已发货'], archivedByStatus['待确认'], archivedByStatus['已取消']], [[1, 1], [1, 1], [1, 1]]);
    assert.deepEqual([overview.overview.purchases.total, overview.overview.purchases.archived], [2, 1], '期间采购单含取消后归档的那张');
    assert.equal(new FinanceMonthly(f.store).get(maker, { period: '2026-10' }).ordered, overview.amountCents);
    assert.deepEqual([overview.recentOrders.length, overview.overview.purchases.recent.map((p) => p.id).includes(cancelled.id)], [0, false]);
  } finally {
    t.f.store.close();
  }
});
