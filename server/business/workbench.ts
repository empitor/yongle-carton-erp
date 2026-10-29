import type { Store } from '../db.js';
import { FlowService } from '../flow/service.js';
import { WarehouseDaily } from '../flow/daily.js';
import { OperationsRepository } from '../operations/repository.js';

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
  const arrivals = daily.get({ kind: 'arrival', date }),
    deliveries = daily.get({ kind: 'delivery', date });
  return {
    date,
    toOrder: purchases.filter((p) => p.businessStatus === '待订货').length,
    pendingArrivals: daily.records('arrival').filter((r) => r.pending && !r.cancelled).length,
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
    pendingDeliveries: daily.records('delivery').filter((r) => r.pending && !r.cancelled).length,
  };
}

export function relatedBusiness(store: Store, entity: 'orders' | 'purchases', id: number) {
  const flow = new FlowService(store),
    repo = new OperationsRepository(store);
  if (entity === 'purchases') {
    const purchase = repo.purchases(true).find((p) => p.id === id);
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
    return {
      arrivals,
      stocks: repo
        .items(true)
        .filter((s) => purchase.lines.some((l: any) => l.stockItemId === s.id)),
      orders: purchase.customerOrderId
        ? store.orders(true).filter((o) => o.id === purchase.customerOrderId)
        : [],
    };
  }
  const order = store.orders(true).find((o) => o.id === id);
  if (!order) return null;
  const tasks = flow.list('task', true).filter((t) => t.orderIds.includes(id));
  const productions = flow
    .list('production', true)
    .filter((p) => tasks.some((t) => t.id === p.taskId));
  return {
    tasks,
    productions,
    deliveries: flow
      .list('delivery', true)
      .filter((d) => d.lines.some((l: any) => l.orderId === id)),
    purchases: repo.purchases(true).filter((p) => p.customerOrderId === id),
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
