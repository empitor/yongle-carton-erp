// 经营概况的送货金额、到货金额和财务月度台账的理论收入、理论支出同一个口径、同一处算（虚构数据、内存库）
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildDashboard } from '../server/business/dashboard.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { PurchaseReturns } from '../server/flow/returns.js';
import { maker, physical, deliveryDoc } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';
import { shipOnDocDate } from './ship-date.js';

test('同一批单据（部分送货、上个月的送货、撤销的送货、更正过的到货、退货）：经营概况的送货金额、到货金额等于财务同月的理论收入、理论支出', async () => {
  const t = await flowFinance();
  try {
    const { f } = t;
    // 送货：订单 100 只送了两回（部分送货），再送一张后撤销；9 月还有一张（不在 10 月里）
    t.deliver('30');
    t.deliver('25');
    t.reverse(t.deliver('5').id);
    const old = f.order(10, { orderDate: '2026-09-01', taxRate: '0', taxMode: '未税' });
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

test('本月接单：财务月度台账和经营概况同一个口径，待确认、已取消的订单都不算', async () => {
  const t = await flowFinance();
  try {
    const { f } = t;
    f.order(30, { orderDate: '2026-10-05', status: '待确认' });
    f.order(40, { orderDate: '2026-10-06', status: '已取消' });
    const month = new FinanceMonthly(f.store).get(maker, { period: '2026-10' });
    const october = f.store.orders().filter((o) => o.orderDate.startsWith('2026-10'));
    const dashboard = buildDashboard(f.store, october, { start: '2026-10-01', end: '2026-10-31' }, '2026-10-31', { workbench: false });
    assert.equal(month.ordered, dashboard.amountCents);
    assert.equal(month.ordered, 10000, '只算已确认的那张：100 只 × 1 元');
  } finally {
    t.f.store.close();
  }
});
