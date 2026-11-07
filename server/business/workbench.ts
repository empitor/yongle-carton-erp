import type { Store } from '../db.js';
import { MarkService } from '../marks/service.js';
import { FlowService } from '../flow/service.js';
import { WarehouseDaily } from '../flow/daily.js';
import { OperationsRepository } from '../operations/repository.js';
import { quantityUnits, sumMoney } from '../../shared/operations.js';
import { orderDisplayStatus } from '../../shared/domain.js';

/** 工作台只读取原服务的有效记录；计划、实物及不同单位分别统计。 */
export function buildWorkbench(store: Store, date: string) {
  const flow = new FlowService(store),
    daily = new WarehouseDaily(store),
    repo = new OperationsRepository(store);
  const tasks = flow.list('task'),
    purchases = repo.purchases();
  const activeTasks = tasks.filter(
    (t) => ['draft', 'confirmed'].includes(t.status) && t.progress < 100,
  );
  const arrivalRecords = daily.records('arrival'),
    deliveryRecords = daily.records('delivery'),
    arrivals = daily.get({ kind: 'arrival', date }, arrivalRecords),
    deliveries = daily.get({ kind: 'delivery', date }, deliveryRecords);
  return {
    date,
    toOrder: purchases.filter((p) => p.businessStatus === '待订货').length,
    pendingArrivals: arrivalRecords.filter((r) => r.pending && !r.cancelled).length,
    arrivalsToday: arrivals.summary!.completed,
    stockedToday: repo
      .movements({ start: date, end: date })
      .filter(
        (m) =>
          m.kind === 'raw' &&
          m.direction === '+' &&
          ['purchase', 'flow_arrival'].includes(String(m.source_kind)),
      ).length,
    activeTasks: activeTasks.length,
    tasksToday: tasks.filter(
      (t) =>
        (t.plannedDate || t.date) === date &&
        ['draft', 'confirmed'].includes(t.status) &&
        t.progress < 100,
    ).length,
    productionToday: flow
      .list('production')
      .filter((p) => p.status === 'confirmed' && p.date === date).length,
    deliveriesToday: deliveries.summary!.completed,
    pendingDeliveries: deliveryRecords.filter((r) => r.pending && !r.cancelled).length,
  };
}

const lineSummary = (names: string[]) =>
  (names[0] || '') + (names.length > 1 ? ' 等' + names.length + '项' : '');
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/** 今日页：把各模块的真实记录整理成待办队列，只读。 */
export function buildToday(store: Store, date: string) {
  const flow = new FlowService(store),
    daily = new WarehouseDaily(store),
    repo = new OperationsRepository(store);
  const orders = store.orders(),
    tasks = flow.list('task'),
    purchases = repo.purchases(),
    deliveryRecords = daily.records('delivery', date),
    arrivalPlans = flow.arrivalPlans({ date }, true);
  const view = (o: (typeof orders)[number]) => ({
    id: o.id,
    number: o.number,
    customerName: o.customerName,
    deliveryDate: o.deliveryDate,
    status: orderDisplayStatus(o),
    shippingProgress: o.shippingProgress,
    materialProgress: o.materialProgress,
    summary: lineSummary(o.lines.map((l) => l.productName)),
  });
  const activeTask = (t: any) => ['draft', 'confirmed'].includes(t.status);
  const active = orders.filter((o) => ['已确认', '生产中', '待发货'].includes(o.status)),
    overdue = active.filter((o) => o.deliveryDate < date),
    overdueIds = new Set(overdue.map((o) => o.id));
  const finished = repo.items().filter((i) => i.kind === 'finished');
  const stockOf = (l: { productId: number; unit: string }) =>
    finished
      .filter((i) => i.productId === l.productId && i.unit === l.unit)
      .reduce((n, i) => n + Math.max(0, Number(i.availableUnits) || 0), 0);
  const stillOpen = (l: { remainingQuantity?: number | null }) =>
    l.remainingQuantity === null || (l.remainingQuantity ?? 0) > 0;
  // 分批做的订单只要有货就能先发一批，不用等全部做完。
  const canShip = (o: (typeof orders)[number]) =>
    o.lines.some((l) => stillOpen(l) && stockOf(l as any) > 0);
  /**
   * 这一行要不要提醒排产。订单状态已经按“做够没有”算好了：还没做够、
   * 又没有正在做的同单位任务，就要接着排。单位不同的任务不算这张单的生产。
   */
  const unplanned = (o: (typeof orders)[number], l: (typeof orders)[number]['lines'][number]) => {
    if (!stillOpen(l)) return false;
    const own = tasks.filter(
      (t) =>
        activeTask(t) &&
        t.productId === l.productId &&
        t.unit === l.unit &&
        t.orderIds.includes(o.id),
    );
    const working = own.some(
      (t) => t.status === 'draft' || quantityUnits(t.completed || '0') < quantityUnits(t.quantity),
    );
    if (working) return false;
    if (o.status === '待发货') {
      // 做够了的不用再排；从库存发了一批、没有任务的，要看库存够不够剩下的。
      if (own.length || o.shippingProgress !== '部分发货' || l.remainingQuantity == null) return false;
      return Math.round(l.remainingQuantity * 1000) > stockOf(l as any);
    }
    return true;
  };
  const unscheduled = active.filter((o) => o.lines.some((l) => unplanned(o, l)));
  const byDate = (a: string, b: string) => a.localeCompare(b);
  const purchaseView = (p: any) => ({
    id: p.id,
    number: p.number,
    supplierName: p.supplierName,
    expectedDate: p.expectedDate,
    summary: lineSummary(p.lines.map((l: any) => l.name)),
  });
  const monthStart = date.slice(0, 7) + '-01';
  return {
    date,
    summary: {
      monthOrderCents: orders
        .filter((o) => o.orderDate >= monthStart && !['草稿', '已取消'].includes(o.status))
        .reduce((n, o) => n + o.totalCents, 0),
      // 历史送货可能没有价格快照，这里只累计有快照的部分，不猜测金额。
      monthShippedAmount:
        sumMoney(
          deliveryRecords
            .filter((d) => d.status === 'confirmed' && d.date >= monthStart)
            .flatMap((d) => d.lines.map((l: any) => l.amountExact ?? null))
            .filter((v) => v !== null),
        ) || '0',
    },
    overdue: overdue
      .map((o) => ({ ...view(o), lateDays: daysBetween(o.deliveryDate, date) }))
      .sort((a, b) => b.lateDays - a.lateDays),
    unscheduled: unscheduled
      .filter((o) => !overdueIds.has(o.id))
      .map(view)
      .sort((a, b) => byDate(a.deliveryDate, b.deliveryDate)),
    ready: active
      .filter((o) => (o.status === '待发货' || canShip(o)) && !overdueIds.has(o.id))
      .map(view)
      .sort((a, b) => byDate(a.deliveryDate, b.deliveryDate)),
    toOrder: purchases.filter((p) => p.businessStatus === '待订货').map(purchaseView),
    arrivalsDue: purchases
      .filter(
        (p) =>
          p.businessStatus === '已订货' &&
          p.expectedDate &&
          p.expectedDate <= date &&
          p.lines.some((l: any) => l.remainingUnits > 0),
      )
      .map(purchaseView)
      .sort((a, b) => byDate(a.expectedDate, b.expectedDate)),
    draftDeliveries: deliveryRecords
      .filter((d) => d.pending && !d.cancelled)
      .map((d) => ({
        id: d.id,
        number: d.number,
        customerName: d.customerName,
        plannedDate: d.plannedDate || d.date,
      })),
    schedule: {
      arrivals: arrivalPlans
        .map((r) => ({
          id: 'flow-' + r.id,
          label: (r.supplierName || '') + ' ' + lineSummary(r.lines.map((l: any) => l.item?.name)),
        })),
      tasks: tasks
        .filter(
          (t) => (t.plannedDate || t.date) === date && activeTask(t) && t.progress < 100,
        )
        .map((t) => ({
          id: t.id,
          label:
            (store.product(t.productId, true)?.name || t.number) + ' ' + t.quantity + ' ' + t.unit,
        })),
      deliveries: deliveryRecords
        .filter((d) => !d.cancelled && (d.plannedDate === date || d.actualDate === date))
        .map((d) => ({
          id: d.id,
          label: d.customerName + ' ' + lineSummary(d.lines.map((l: any) => l.productName)),
        })),
    },
    zeroStock: repo
      .items()
      .filter((i) => i.kind === 'raw' && i.balanceUnits === 0)
      .map((i) => ({ id: i.id, name: i.name, onOrder: i.onOrder })),
  };
}

export function relatedBusiness(store: Store, entity: 'orders' | 'purchases', id: number) {
  const flow = new FlowService(store),
    repo = new OperationsRepository(store);
  if (entity === 'purchases') {
    const purchase = repo.purchases(true, id)[0];
    if (!purchase) return null;
    const arrivals = new WarehouseDaily(store)
      .records('arrival')
      .filter((r) =>
        r.lines.some(
          (l: any) =>
            l.purchaseId === id ||
            purchase.lines.some((pl: any) => pl.id === l.purchaseLineId || pl.id === l.lineId),
        ),
      );
    const order = purchase.customerOrderId ? store.order(purchase.customerOrderId, true) : undefined;
    return {
      arrivals,
      stocks: repo.items(true, purchase.lines.flatMap((l: any) => l.stockItemId ? [l.stockItemId] : [])),
      orders: order ? [order] : [],
    };
  }
  const order = store.order(id, true);
  if (!order) return null;
  const tasks = flow.list('task', true).filter((t) => t.orderIds.includes(id));
  const productions = flow
    .list('production', true)
    .filter((p) => tasks.some((t) => t.id === p.taskId));
  const purchaseIds = store.db.prepare('SELECT id FROM purchases WHERE customer_order_id=?')
    .all(id).map((row) => Number(row.id));
  return {
    marks: new MarkService(store).listForProducts(order.lines.map((l) => l.productId)),
    tasks,
    productions,
    deliveries: flow
      .list('delivery', true)
      .filter((d) => d.lines.some((l: any) => l.orderId === id)),
    purchases: repo.purchases(true, purchaseIds),
    stocks: repo
      .items()
      .filter((s) => s.kind === 'finished' && order.lines.some((l) => l.productId === s.productId)),
    production: tasks
      .filter((t) => !t.archived && ['draft', 'confirmed'].includes(t.status))
      .map((t) => ({
        id: t.id,
        productId: t.productId,
        unit: t.unit,
        planned: t.quantity,
        completed: t.completed,
        progress: t.progress,
        number: t.number,
      })),
  };
}
