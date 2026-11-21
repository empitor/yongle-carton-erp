import { z } from 'zod';
import { count, many, type Store } from '../core/index.js';
import { FlowService } from '../flow/index.js';
import { WarehouseDaily } from '../flow/index.js';
import { periodOrders } from './period-records.js';
import { OperationsRepository, OrderBatchService, purchaseOrderLinks } from '../operations/index.js';
import { dueSegments, sumMoney, type FlowDocView } from '../../shared/business/index.js';
import { DAY_MS, UNITS_PER_QUANTITY, deliverableOrder, effectiveOrder, orderDisplayStatus, quantityString } from '../../shared/core/index.js';
import { orderNextSteps, type NextStep } from '../../shared/business/index.js';
import { pendingByOrderLine, specificationMismatch } from '../../shared/business/index.js';

/**
 * 助手的今日概览（buildDashboard 带 workbench 时的 overview.workbench，首页不带）：今天的到货、入库、生产、送货各有几笔。
 * 只读取原服务的有效记录；计划、实物及不同单位分别统计。
 * 到货、送货只读台账表头（日期和状态），当天的计数按表头算，不组装明细。
 */
export function buildWorkbench(store: Store, date: string) {
  const flow = new FlowService(store),
    daily = new WarehouseDaily(store),
    repo = new OperationsRepository(store);
  const tasks = flow.list('task');
  const activeTasks = tasks.filter(
    (t) => t.status === 'confirmed' && t.progress < 100,
  );
  const arrivalRecords = daily.heads('arrival'),
    deliveryRecords = daily.heads('delivery');
  return {
    date,
    toOrder: count(
      store.db,
      "SELECT COUNT(*) n FROM purchases WHERE status='待订货' AND id NOT IN (SELECT record_id FROM record_lifecycle WHERE entity='purchases')",
    ),
    pendingArrivals: arrivalRecords.filter((r) => r.pending && !r.cancelled).length,
    arrivalsToday: daily.daySummary(arrivalRecords, date).completed,
    // 当天原材料的采购入库流水（数量为 0 的也按“+”方向计）。
    stockedToday: repo.movementCount({ start: date, end: date, kind: 'raw' }, {
      inbound: true,
      sourceKinds: ['purchase', 'flow_arrival'],
    }),
    activeTasks: activeTasks.length,
    tasksToday: tasks.filter(
      (t) =>
        (t.plannedDate || t.date) === date &&
        t.status === 'confirmed' &&
        t.progress < 100,
    ).length,
    productionToday: count(
      store.db,
      "SELECT COUNT(*) n FROM flow_documents WHERE kind='production' AND status='confirmed' AND date=? AND id NOT IN (SELECT record_id FROM record_lifecycle WHERE entity='flow_production')",
      date,
    ),
    deliveriesToday: daily.daySummary(deliveryRecords, date).completed,
    pendingDeliveries: deliveryRecords.filter((r) => r.pending && !r.cancelled).length,
  };
}

/** 明细摘要：第一项的名字，多项时加“等几项”（送货明细的品名可能没有） */
const lineSummary = (names: readonly (string | undefined)[]) =>
  (names[0] || '') + (names.length > 1 ? ' 等' + names.length + '项' : '');
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
/** 这个月的第一天（日期是 YYYY-MM-DD） */
const monthStart = (date: string) => date.slice(0, 'YYYY-MM'.length) + '-01';

type Order = ReturnType<Store['orders']>[number];
type StockItem = ReturnType<OperationsRepository['items']>[number];
type Purchase = ReturnType<OperationsRepository['purchases']>[number];
type Task = FlowDocView<'task'>;
/** 台账里的送货单（WarehouseDaily.records('delivery')）这里要用的几项：明细的品名、金额可能没有 */
type DeliveryRecord = {
  id: number;
  status: string;
  date: string;
  plannedDate: string;
  actualDate: string | null;
  cancelled: boolean;
  customerName: string;
  lines: readonly { productName?: string; amountExact?: string | null }[];
};

const purchaseOrderLink = z.object({ purchase_id: z.number(), order_id: z.number() });
/** 每张订单挂着的采购单（今日页判断还要不要订料）。只认 purchases 里有的（没归档的）。 */
function purchasesByOrder(store: Store, purchases: Purchase[]) {
  const purchasesById = new Map(purchases.map((p) => [p.id, p]));
  const purchaseLinks = new Map<number, Purchase[]>();
  for (const link of many(store.db, purchaseOrderLink, 'SELECT DISTINCT purchase_id,order_id FROM (' + purchaseOrderLinks + ')')) {
    const purchase = purchasesById.get(link.purchase_id);
    if (!purchase) continue;
    const list = purchaseLinks.get(link.order_id) || [];
    list.push(purchase);
    purchaseLinks.set(link.order_id, list);
  }
  return purchaseLinks;
}

/** 一张订单分到的成品库存：库存品带规格，orderNextSteps 才认得出规格对不上 */
const allottedStock = (s: StockItem, availableUnits: number) => ({
  productId: s.productId,
  unit: s.unit,
  availableUnits,
  specification: s.specification,
  length: s.length,
  width: s.width,
  height: s.height,
  dimensionUnit: s.dimensionUnit,
});
type Stock = { byProduct: Map<number, StockItem[]>; left: Map<number, number>; pendingByLine: Map<number, number> };
/** 给一张订单分库存：每行按还没发、也没排进待送货单的数量，从这种产品、同单位、规格对得上的库存品里依次拿 */
function allotOrder(o: Order, { byProduct, left, pendingByLine }: Stock) {
  const give = new Map<StockItem, number>();
  for (const l of o.lines) {
    const stocks = (byProduct.get(l.productId) || []).filter((i) => i.unit === l.unit);
    let need = Math.max(
      0,
      Math.round(Number(l.remainingQuantity ?? l.quantity) * UNITS_PER_QUANTITY) - (pendingByLine.get(l.id) || 0),
    );
    for (const s of stocks) {
      give.set(s, give.get(s) || 0);
      if (!need || specificationMismatch(s, l)) continue;
      const g = Math.min(need, left.get(s.id) || 0);
      left.set(s.id, (left.get(s.id) || 0) - g);
      give.set(s, (give.get(s) || 0) + g);
      need -= g;
    }
  }
  return [...give].map(([s, units]) => allottedStock(s, units));
}

/**
 * 几张单抢同一批成品时，按交期先后把可用库存分给各张单，再算下一步：交期早的先发，晚的那张要接着排产。
 * 订单详情只看自己这一张，库存不够几张单一起发时，以这里为准。
 * 按库存品分（带规格）：订单明细的规格和成品现在的对不上（specificationMismatch，送货窗口、服务端出库、
 * 订单详情的下一步同一个判断）的，不从这个库存品分货；分到的那一项照样带上规格，orderNextSteps 才认得出
 * 对不上，不算“有库存可发”，并给出和订单详情一样的黄色提示。
 * 返回每张订单分到的库存（按订单编号）。
 */
function allotFinishedStock(active: Order[], finished: StockItem[], pendingDeliveries: FlowDocView<'delivery'>[]) {
  const stock: Stock = {
    byProduct: new Map(),
    left: new Map(),
    // 已经排进待送货单的数量：可用库存已经扣掉了它，分库存时不能再要一遍（和 orderNextSteps 同一口径）
    pendingByLine: pendingByOrderLine(pendingDeliveries),
  };
  for (const i of finished) {
    stock.left.set(i.id, Math.max(0, i.availableUnits));
    if (i.productId == null) continue;
    stock.byProduct.set(i.productId, [...(stock.byProduct.get(i.productId) || []), i]);
  }
  const allotted = new Map<number, ReturnType<typeof allotOrder>>();
  for (const o of [...active].sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.id - b.id))
    allotted.set(o.id, allotOrder(o, stock));
  return allotted;
}

/** 今日把一张订单放进哪一组、该办哪一步（规则见 buildToday 里的说明）。overdue：交期已过。 */
function todayGroup(o: Order, steps: NextStep[], overdue: boolean): { group: 'ship' | 'schedule' | 'complete'; step: NextStep } | null {
  const find = (...kinds: NextStep['kind'][]) => steps.find((x) => kinds.includes(x.kind));
  const ship = find('delivery'),
    // 订单详情里订料排在安排生产前面（先订纸板），这里按同样的先后取
    plan = find('purchase', 'schedule'),
    work = find('complete');
  if (ship && (o.status === '待发货' || o.shippingProgress === '部分发货')) return { group: 'ship', step: ship };
  if (plan) return { group: 'schedule', step: plan };
  if (work && overdue) return { group: 'complete', step: work };
  if (ship) return { group: 'ship', step: ship };
  return null;
}

/** 今日页列订单的样子 */
const orderRow = (o: Order) => ({
  id: o.id,
  number: o.number,
  customerName: o.customerName,
  deliveryDate: o.deliveryDate,
  status: orderDisplayStatus(o),
  shippingProgress: o.shippingProgress,
  materialProgress: o.materialProgress,
  summary: lineSummary(o.lines.map((l) => l.productName)),
});
const byDeliveryDate = (a: { deliveryDate: string }, b: { deliveryDate: string }) =>
  a.deliveryDate.localeCompare(b.deliveryDate);

type OrderFacts = { store: Store; flow: FlowService; active: Order[]; tasks: Task[]; purchases: Purchase[]; finished: StockItem[] };
/**
 * 每张进行中的订单的下一步，和订单详情用同一套规则（orderNextSteps）；成品库存先按交期分好（allotFinishedStock）。
 * 已经有待送货单的不在订单行里重复，送货单另外列。
 */
function orderFacts({ store, flow, active, tasks, purchases, finished }: OrderFacts) {
  const pendingDeliveries = flow.list('delivery', false, undefined, flow.draftIds('delivery'));
  const purchaseLinks = purchasesByOrder(store, purchases);
  const allotted = allotFinishedStock(active, finished, pendingDeliveries);
  return active.map((o) => {
    const { steps, mismatches = [] } = orderNextSteps(o, {
      tasks: tasks.filter((t) => t.orderIds.includes(o.id)),
      stocks: allotted.get(o.id) || [],
      deliveries: pendingDeliveries.filter((d) => d.lines.some((l) => l.orderId === o.id)),
      purchases: purchaseLinks.get(o.id) || [],
    });
    return { order: o, steps, mismatches, kinds: steps.map((x) => x.kind) };
  });
}
type OrderFact = ReturnType<typeof orderFacts>[number];

/**
 * 订单的几份清单。今日按下一步分组，每张单只进一组：有货该发、又是待发货或已发一部分的先发；
 * 要排产或订料的进待排产；逾期还在做的进待完工；其余有货能发的进可送货。
 */
function orderQueues(facts: OrderFact[], overdue: Order[], date: string) {
  const overdueIds = new Set(overdue.map((o) => o.id)),
    notOverdue = (f: OrderFact) => !overdueIds.has(f.order.id);
  const todo = facts.flatMap(({ order, steps, mismatches }) => {
    const placed = todayGroup(order, steps, overdueIds.has(order.id));
    return placed ? [{ order, mismatches, ...placed }] : [];
  });
  return {
    overdue: overdue
      .map((o) => ({ ...orderRow(o), lateDays: daysBetween(o.deliveryDate, date) }))
      .sort((a, b) => b.lateDays - a.lateDays),
    /** 今日的订单待办：每张单的分组和该办的那一步（标题、按钮名），界面直接照着显示 */
    todo: todo.map(({ order, group, step, mismatches }) => ({
      ...orderRow(order),
      lateDays: overdueIds.has(order.id) ? daysBetween(order.deliveryDate, date) : 0,
      group,
      // 有明细规格和产品现在的对不上时，和订单详情“下一步”的黄色提示同一句（核对好之前送不了货）
      mismatches,
      // 界面按这一步直接打开窗口（带着按分配算出的缺口），不再自己重算
      step: { kind: step.kind, title: step.title, label: step.label, params: step.params || {} },
    })),
    // 下面两份是事实清单（不管今日把这张单放进哪一组）：还要排产或订料的、分到了库存能先发一批的
    unscheduled: facts
      .filter((f) => f.kinds.some((k) => k === 'schedule' || k === 'purchase') && notOverdue(f))
      .map((f) => orderRow(f.order))
      .sort(byDeliveryDate),
    ready: facts
      .filter((f) => f.kinds.includes('delivery') && notOverdue(f))
      .map((f) => orderRow(f.order))
      .sort(byDeliveryDate),
    // 有明细规格和产品现在的对不上、送不了货的订单（不管进没进上面的分组），提示和订单详情同一句
    specMismatch: facts
      .filter((f) => f.mismatches.length)
      .map((f) => ({ ...orderRow(f.order), mismatches: f.mismatches }))
      .sort(byDeliveryDate),
  };
}

const purchaseRow = (p: Purchase) => ({
  id: p.id,
  number: p.number,
  supplierName: p.supplierName,
  expectedDate: p.expectedDate,
  summary: lineSummary(p.lines.map((l) => l.name)),
});
/** 采购的两份清单：待订货的；已订货、预计今天或更早到、还没到齐的（按预计到货日） */
function purchaseQueues(purchases: Purchase[], date: string) {
  return {
    toOrder: purchases.filter((p) => p.businessStatus === '待订货').map(purchaseRow),
    arrivalsDue: purchases
      .flatMap((p) =>
        p.businessStatus === '已订货' &&
        p.expectedDate &&
        p.expectedDate <= date &&
        p.lines.some((l) => l.remainingUnits > 0)
          ? [{ ...purchaseRow(p), expectedDate: p.expectedDate }]
          : [],
      )
      .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)),
  };
}

/** 这个月的订单金额、已出库金额（含已归档的）；历史送货可能没有价格快照，只累计有快照的部分，不猜测金额。 */
function monthSummary(orders: Order[], deliveryRecords: DeliveryRecord[], date: string) {
  const from = monthStart(date);
  return {
    monthOrderCents: orders
      .filter((o) => o.orderDate >= from && effectiveOrder(o))
      .reduce((n, o) => n + o.totalCents, 0),
    monthShippedAmount:
      sumMoney(
        deliveryRecords
          .filter((d) => d.status === 'confirmed' && d.date >= from)
          .flatMap((d) => d.lines.map((l) => l.amountExact ?? null))
          .filter((v) => v !== null),
      ) || '0',
  };
}

type Schedule = { store: Store; dueArrivals: ReturnType<typeof dueSegments>; tasks: Task[]; deliveryRecords: DeliveryRecord[]; date: string };
/** 今天的日程：要到的到货安排、计划在今天的生产任务、今天要送或今天送出的送货单 */
function daySchedule({ store, dueArrivals, tasks, deliveryRecords, date }: Schedule) {
  return {
    arrivals: dueArrivals.map((s, index) => ({
      id: 'batch-' + s.batchId + '-' + index,
      batchId: s.batchId,
      overdue: s.overdue,
      dueDate: s.dueDate,
      label:
        (s.overdue ? '逾期 ' : '') +
        s.supplierName + ' ' + s.name + ' 还差 ' + quantityString(s.remainingUnits) + ' ' + s.unit +
        (s.overdue ? '（' + s.dueDate + ' 前该到）' : ''),
    })),
    tasks: tasks
      .filter((t) => (t.plannedDate || t.date) === date && t.status === 'confirmed' && t.progress < 100)
      .map((t) => ({
        id: t.id,
        label: (store.product(t.productId, true)?.name || t.number) + ' ' + t.quantity + ' ' + t.unit,
      })),
    deliveries: deliveryRecords
      .filter((d) => !d.cancelled && (d.plannedDate === date || d.actualDate === date))
      .map((d) => ({
        id: d.id,
        label: d.customerName + ' ' + lineSummary(d.lines.map((l) => l.productName)),
      })),
  };
}

/**
 * 今日页：把各模块的真实记录整理成待办队列，只读。本月接单、本月发货算上已归档的订单和送货单
 * （归档只是把办完的收起来）；待办和今天的日程不带已归档的。
 */
export function buildToday(store: Store, date: string) {
  const flow = new FlowService(store),
    daily = new WarehouseDaily(store),
    repo = new OperationsRepository(store);
  // 本月接单算上这个月里已归档的订单（只按日期圈出来读），待办用没归档的
  const orders = periodOrders(store, { start: monthStart(date) }),
    tasks = flow.list('task'),
    purchases = repo.purchases(),
    items = repo.items(),
    allDeliveries = daily.records('delivery', date, { includeArchived: true }),
    deliveryRecords = allDeliveries.filter((d) => !d.archived),
    // 今天要到的按订货单的到货安排：截止日是今天、还没到齐的段，逾期没到齐的排在前面
    dueArrivals = dueSegments(new OrderBatchService(store).open(), date);
  const active = orders.current.filter(deliverableOrder),
    finished = items.filter((i) => i.kind === 'finished');
  const facts = orderFacts({ store, flow, active, tasks, purchases, finished });
  return {
    date,
    summary: monthSummary([...orders.current, ...orders.archived], allDeliveries, date),
    ...orderQueues(facts, active.filter((o) => o.deliveryDate < date), date),
    ...purchaseQueues(purchases, date),
    draftDeliveries: deliveryRecords
      .filter((d) => d.pending && !d.cancelled)
      .map((d) => ({
        id: d.id,
        number: d.number,
        customerName: d.customerName,
        plannedDate: d.plannedDate || d.date,
      })),
    schedule: daySchedule({ store, dueArrivals, tasks, deliveryRecords, date }),
    zeroStock: items
      .filter((i) => i.kind === 'raw' && i.balanceUnits === 0)
      .map((i) => ({ id: i.id, name: i.name, onOrder: i.onOrder })),
  };
}
