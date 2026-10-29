import type { Store } from '../db.js';
import { buildWorkbench } from './workbench.js';
import { statuses, today, type Dashboard, type Order } from '../../shared/domain.js';
import { monthsBefore, closedOrder } from '../../shared/date-ranges.js';
import { quantityString, sumMoney } from '../../shared/operations.js';
import { OperationsRepository } from '../operations/repository.js';
import type { UnitBalance } from '../../shared/overview.js';
import { orderMetrics, productMetrics, pendingPurchase } from '../../shared/business-metrics.js';

export function buildDashboard(
  store: Store,
  rows: Order[],
  range: { start?: string; end?: string },
  date = today(),
): Dashboard {
  const allOrders = store.orders(),
    valid = rows.filter((o) => o.status !== '草稿' && o.status !== '已取消'),
    costed = valid.filter((o) => o.costCents !== null);
  const sum = (items: Order[], key: 'totalCents' | 'costCents') =>
    items.reduce((n, o) => n + (o[key] || 0), 0);
  const repo = new OperationsRepository(store),
    allPurchases = repo.purchases(),
    items = repo.items();
  const inRange = (value: string) =>
    (!range.start || value >= range.start) && (!range.end || value <= range.end);
  const purchases = allPurchases.filter((p) => inRange(p.orderDate));
  const balances = (list: any[], getQuantity: (v: any) => number): UnitBalance[] => {
    const groups = new Map<string, { unit: string; quantity: number; itemCount: number }>();
    for (const item of list) {
      const group = groups.get(item.unit) || { unit: item.unit, quantity: 0, itemCount: 0 };
      group.quantity += getQuantity(item);
      group.itemCount++;
      groups.set(item.unit, group);
    }
    return [...groups.values()]
      .sort((a, b) => a.unit.localeCompare(b.unit, 'zh-CN'))
      .map((g) => ({ unit: g.unit, quantity: quantityString(g.quantity), itemCount: g.itemCount }));
  };
  const movements = repo.movements({ start: range.start, end: range.end }).slice(0, 8);
  const recentOrders = [...rows]
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.id - a.id)
    .slice(0, 6);
  const recentPurchases = [...purchases]
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.id - a.id)
    .slice(0, 5);
  const activity = [
    ...recentOrders.map((o) => ({
      id: 'order-' + o.id,
      date: o.orderDate,
      title: o.number,
      detail: o.customerName + ' · ' + o.status + ' · ' + o.shippingProgress,
      target: '#orders?order=' + o.id,
      category: '客户订单',
      recordedAt: o.createdAt,
    })),
    ...recentPurchases.map((p) => ({
      id: 'purchase-' + p.id,
      date: p.orderDate,
      title: p.number,
      detail: p.supplierName + ' · ' + p.businessStatus + ' · ' + p.arrivalProgress,
      target: '#purchases?q=' + encodeURIComponent(p.number),
      category: '采购订货',
      recordedAt: p.createdAt,
    })),
    ...movements.map((m) => ({
      id: 'move-' + m.id,
      date: String(m.date),
      title: m.itemName,
      detail: m.direction + m.delta + ' ' + m.unit + ' · ' + m.actor_name,
      target: '#warehouse?kind=' + m.kind + '&flow=1',
      category: '库存变动',
      recordedAt: String(m.created_at),
    })),
  ]
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.recordedAt.localeCompare(a.recordedAt) ||
        b.id.localeCompare(a.id),
    )
    .slice(0, 12)
    .map(({ recordedAt, ...event }) => event);
  const products = store.products();
  return {
    count: valid.length,
    amountCents: sum(valid, 'totalCents'),
    shippedCents: sum(
      valid.filter((o) => o.status === '已发货'),
      'totalCents',
    ),
    estimatedCostCents: sum(costed, 'costCents'),
    estimatedProfitCents: sum(costed, 'totalCents') - sum(costed, 'costCents'),
    costedCount: costed.length,
    uncostedCount: valid.length - costed.length,
    overdueCount: valid.filter((o) => o.status !== '已发货' && o.deliveryDate < date).length,
    byStatus: statuses.map((status) => ({
      status,
      count: rows.filter((o) => o.status === status).length,
    })),
    recentOrders,
    overview: {
      workbench: buildWorkbench(store, date),
      range: { start: range.start || null, end: range.end || null },
      orders: {
        total: rows.length,
        pendingInRange: orderMetrics(rows, date).pending,
        pendingAll: orderMetrics(allOrders, date).pending,
        overdueAll: orderMetrics(allOrders, date).overdue,
        history: allOrders.filter(
          (o) => closedOrder(o.status) && o.orderDate < monthsBefore(date, 2),
        ).length,
      },
      purchases: {
        total: purchases.length,
        pending: purchases.filter(pendingPurchase).length,
        pendingAll: allPurchases.filter(pendingPurchase).length,
        unknownPrices: purchases.filter((p) => p.status !== '已取消' && p.totalAmount === null)
          .length,
        amount:
          sumMoney(
            purchases
              .filter((p) => p.status !== '已取消' && p.totalAmount !== null)
              .map((p) => p.totalAmount),
          ) || '0',
        receivedAmount: sumMoney(purchases.map((p) => p.receivedAmount)),
        outstanding: balances(
          allPurchases
            .filter(pendingPurchase)
            .flatMap((p) => p.lines)
            .filter((l) => l.remainingUnits > 0),
          (l) => l.remainingUnits,
        ),
        recent: recentPurchases,
      },
      inventory: {
        raw: balances(
          items.filter((i) => i.kind === 'raw'),
          (i) => i.balanceUnits,
        ),
        finished: balances(
          items.filter((i) => i.kind === 'finished'),
          (i) => i.balanceUnits,
        ),
        rawCount: items.filter((i) => i.kind === 'raw').length,
        finishedCount: items.filter((i) => i.kind === 'finished').length,
        zeroCount: items.filter((i) => i.balanceUnits === 0).length,
      },
      products: {
        total: products.length,
        incomplete: productMetrics(products).incomplete,
      },
      movements,
      activity,
    },
  };
}
