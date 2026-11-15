import { many, parseStoredJson, rows as tables, type Store } from '../core/index.js';
import { flowDocumentSchema, purchaseState } from '../../shared/business/index.js';
import { buildWorkbench } from './workbench.js';
import { displayOrderStatuses, orderDisplayStatus, today, type Order } from '../../shared/core/index.js';
import type { Dashboard } from '../../shared/business/index.js';
import { monthsBefore, closedOrder } from '../../shared/core/index.js';
import { documentValueCents, sumMoney } from '../../shared/business/index.js';
import { quantityString } from '../../shared/core/index.js';
import { OperationsRepository } from '../operations/index.js';
import type { UnitBalance } from '../../shared/business/index.js';
import { orderMetrics, productMetrics, pendingPurchase } from '../../shared/business/index.js';

/** 采购单、库存品、库存流水的视图（采购库存模块给的样子） */
type PurchaseView = ReturnType<OperationsRepository['purchases']>[number];
type StockItemView = ReturnType<OperationsRepository['items']>[number];
type MovementView = ReturnType<OperationsRepository['movements']>[number];
type Overview = Dashboard['overview'];
type DateRange = { start?: string; end?: string };

/** 首页“最近”几栏各列几条：订单、采购单、库存流水，合起来的动态最多几条 */
const RECENT_ORDERS = 6;
const RECENT_PURCHASES = 5;
const RECENT_MOVEMENTS = 8;
const ACTIVITY_LIMIT = 12;
/** 订单按“已结束且下单早于几个月前”算历史 */
const HISTORY_MONTHS = 2;

const documentRow = tables.flow_documents.pick({ id: true, number: true, document: true });

/**
 * 区间内有效送货单、到货单的金额，按单据日期：只算已确认的（撤销的、被更正替代的不算），按单据上的单价、不另加税；
 * 和财务月度台账的理论收入、理论支出同一处算（documentValueCents）。算不出金额的（缺单价、数量或尺寸）不计入合计，只计张数。
 */
function documentAmounts(store: Store, kind: 'delivery' | 'arrival', range: DateRange) {
  const found = many(
    store.db,
    documentRow,
    `SELECT id,number,document FROM flow_documents WHERE kind=? AND status='confirmed'
      AND (? IS NULL OR date>=?) AND (? IS NULL OR date<=?)`,
    kind,
    range.start || null,
    range.start || null,
    range.end || null,
    range.end || null,
  );
  let cents = 0,
    uncomputed = 0;
  for (const row of found) {
    const where = `flow_documents.document（单据 ${row.id}，单号 ${row.number}）`;
    const value = documentValueCents(kind, parseStoredJson(flowDocumentSchema(kind), row.document, where).lines);
    if ('cents' in value) cents += value.cents;
    else uncomputed++;
  }
  return { cents, uncomputed };
}

/** 按单位合计数量（同一单位的几样货加在一起，记有几样） */
function unitBalances<T extends { unit: string }>(list: readonly T[], quantity: (item: T) => number): UnitBalance[] {
  const groups = new Map<string, { unit: string; quantity: number; itemCount: number }>();
  for (const item of list) {
    const group = groups.get(item.unit) || { unit: item.unit, quantity: 0, itemCount: 0 };
    group.quantity += quantity(item);
    group.itemCount++;
    groups.set(item.unit, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.unit.localeCompare(b.unit, 'zh-CN'))
    .map((g) => ({ unit: g.unit, quantity: quantityString(g.quantity), itemCount: g.itemCount }));
}

/** 下单日期新的在前，同一天编号大的在前，取前几条 */
function newestFirst<T extends { orderDate: string; id: number }>(list: readonly T[], limit: number) {
  return [...list].sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.id - a.id).slice(0, limit);
}

/** 最近动态：最近的订单、采购单、库存流水合在一起，日期新的在前 */
function recentActivity(orders: Order[], purchases: PurchaseView[], movements: MovementView[]): Overview['activity'] {
  return [
    ...orders.map((o) => ({
      id: 'order-' + o.id,
      date: o.orderDate,
      title: o.number,
      // 部分发货已经在状态里，不再重复发货进度。
      detail: [o.customerName, orderDisplayStatus(o), orderDisplayStatus(o) === '部分发货' ? '' : o.shippingProgress]
        .filter(Boolean)
        .join(' · '),
      target: '#orders?order=' + o.id,
      category: '订单',
      recordedAt: o.createdAt,
    })),
    ...purchases.map((p) => ({
      id: 'purchase-' + p.id,
      date: p.orderDate,
      title: p.number,
      detail: p.supplierName + ' · ' + purchaseState(p),
      target: '#purchases?record=' + p.id,
      category: '采购单',
      recordedAt: p.createdAt,
    })),
    ...movements.map((m) => ({
      id: 'move-' + m.id,
      date: String(m.date),
      title: m.itemName,
      detail: m.direction + m.delta + ' ' + m.unit + ' · ' + m.actor_name,
      target: '#warehouse?kind=' + m.kind + '&flow=1',
      category: '库存流水',
      recordedAt: String(m.created_at),
    })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id))
    .slice(0, ACTIVITY_LIMIT)
    .map(({ recordedAt: _recordedAt, ...event }) => event);
}

/** 订单概况：区间里的、全部的待办和逾期，以及算作历史的 */
function orderOverview(inRange: Order[], all: Order[], date: string): Overview['orders'] {
  return {
    total: inRange.length,
    pendingInRange: orderMetrics(inRange, date).pending,
    pendingAll: orderMetrics(all, date).pending,
    overdueAll: orderMetrics(all, date).overdue,
    history: all.filter((o) => closedOrder(o.status) && o.orderDate < monthsBefore(date, HISTORY_MONTHS)).length,
  };
}

/** 采购概况：区间里的张数、金额、到货金额，全部没到齐的还差多少 */
function purchaseOverview(
  purchases: { all: PurchaseView[]; inRange: PurchaseView[]; recent: PurchaseView[] },
  arrivals: { cents: number; uncomputed: number },
): Overview['purchases'] {
  const { all, inRange, recent } = purchases;
  const priced = inRange.filter((p) => p.status !== '已取消' && p.totalAmount !== null);
  return {
    total: inRange.length,
    pending: inRange.filter(pendingPurchase).length,
    pendingAll: all.filter(pendingPurchase).length,
    unknownPrices: inRange.filter((p) => p.status !== '已取消' && p.totalAmount === null).length,
    amount: sumMoney(priced.map((p) => p.totalAmount)) || '0',
    arrivedCents: arrivals.cents,
    arrivalUncomputed: arrivals.uncomputed,
    outstanding: unitBalances(
      all
        .filter(pendingPurchase)
        .flatMap((p) => p.lines)
        .filter((l) => l.remainingUnits > 0),
      (l) => l.remainingUnits,
    ),
    recent,
  };
}

/** 库存概况：原材料、成品按单位的结存，各有几样，结存是零的几样 */
function inventoryOverview(items: StockItemView[]): Overview['inventory'] {
  const raw = items.filter((i) => i.kind === 'raw'),
    finished = items.filter((i) => i.kind === 'finished');
  return {
    raw: unitBalances(raw, (i) => i.balanceUnits),
    finished: unitBalances(finished, (i) => i.balanceUnits),
    rawCount: raw.length,
    finishedCount: finished.length,
    zeroCount: items.filter((i) => i.balanceUnits === 0).length,
  };
}

/** 区间里有效的订单（不算待确认、已取消）的数量、金额、估算成本和利润、按状态的张数 */
function orderFigures(rows: Order[], date: string) {
  const valid = rows.filter((o) => o.status !== '待确认' && o.status !== '已取消'),
    costed = valid.filter((o) => o.costCents !== null);
  const sum = (items: Order[], key: 'totalCents' | 'costCents') => items.reduce((n, o) => n + (o[key] || 0), 0);
  return {
    count: valid.length,
    amountCents: sum(valid, 'totalCents'),
    estimatedCostCents: sum(costed, 'costCents'),
    estimatedProfitCents: sum(costed, 'totalCents') - sum(costed, 'costCents'),
    costedCount: costed.length,
    uncostedCount: valid.length - costed.length,
    overdueCount: valid.filter((o) => o.status !== '已发货' && o.deliveryDate < date).length,
    byStatus: displayOrderStatuses.map((status) => ({
      status,
      count: rows.filter((o) => orderDisplayStatus(o) === status).length,
    })),
  };
}

/**
 * 首页数据。工作台汇总首页页面不显示、AI 概览要用：不需要时传 options.workbench=false 跳过计算，
 * 不传时照旧计算。调用方已读过全部订单时用 options.allOrders 传入，不再读一遍。
 */
export function buildDashboard(
  store: Store,
  rows: Order[],
  range: DateRange,
  date = today(),
  options: { allOrders?: Order[]; workbench?: boolean } = {},
): Dashboard {
  const allOrders = options.allOrders ?? store.orders();
  const repo = new OperationsRepository(store),
    allPurchases = repo.purchases();
  const inRange = (value: string) => (!range.start || value >= range.start) && (!range.end || value <= range.end);
  const purchases = allPurchases.filter((p) => inRange(p.orderDate));
  const deliveries = documentAmounts(store, 'delivery', range);
  const movements = repo.movements({ start: range.start, end: range.end }, { limit: RECENT_MOVEMENTS });
  const recentOrders = newestFirst(rows, RECENT_ORDERS),
    recentPurchases = newestFirst(purchases, RECENT_PURCHASES);
  const products = store.products();
  return {
    ...orderFigures(rows, date),
    deliveredCents: deliveries.cents,
    deliveryUncomputed: deliveries.uncomputed,
    recentOrders,
    overview: {
      ...(options.workbench === false ? {} : { workbench: buildWorkbench(store, date) }),
      range: { start: range.start || null, end: range.end || null },
      orders: orderOverview(rows, allOrders, date),
      purchases: purchaseOverview(
        { all: allPurchases, inRange: purchases, recent: recentPurchases },
        documentAmounts(store, 'arrival', range),
      ),
      inventory: inventoryOverview(repo.items()),
      products: { total: products.length, incomplete: productMetrics(products).incomplete },
      movements,
      activity: recentActivity(recentOrders, recentPurchases, movements),
    },
  };
}
