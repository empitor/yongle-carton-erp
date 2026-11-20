import { closedOrder, deliverableOrder, effectiveOrder, quantityString, quantityUnits, safeUnits } from '../core/index.js';
import { NO_DUE_DATE } from './schedule.js';
import { lineSpecification, normalizeDimensionUnit, sameSpecification, specificationDifference, type Order } from '../core/index.js';

/** 比规格要用的库存品资料：规格说明（跟着产品）、长宽高和尺寸单位 */
type SizedStock = {
  specification?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: unknown;
};
/** 订单明细写的规格；只重复了产品名称的不算规格（lineSpecification） */
type SpecLine = { specification?: string | null; productName?: string | null };
/** 比对送货用到的成品库存品 */
type DeliveryStock = SizedStock & { id: number; productId?: number | null };
/** 排送货用到的成品库存品：带可用量（扣掉待送货单占的，千分整数），库存品视图里一定有 */
type PlannedStock = DeliveryStock & { availableUnits: number };
/**
 * 排送货、排产、订单“下一步”要看的订单明细，字段取自订单视图（shared/core 的 Order）：编号、产品、数量（整数“只”）、
 * 还没发的、单位、规格。order-next-step.ts、production-plan.ts 也用它，订单视图改了字段这里一起报错。
 */
export type OrderLineFacts = Pick<Order['lines'][number], 'id' | 'productId' | 'productName' | 'quantity' | 'remainingQuantity' | 'unit'> & {
  specification?: string | null;
};
/** 同上，要看的订单字段；列表行另带“已归档”，没写交期的是空 */
export type OrderFacts<L extends OrderLineFacts = OrderLineFacts> = Pick<Order, 'id' | 'number' | 'customerId' | 'materialProgress'> & {
  status: string;
  archived?: unknown;
  deliveryDate?: string | null;
  version?: number;
  lines: L[];
};
/** 待送货单（送货单视图，别的单据也可以传进来，只数待送货的送货单） */
type PendingDelivery = {
  status?: string;
  archived?: unknown;
  lines?: readonly { orderId?: number | string | null; orderLineId?: number | string | null; quantity?: unknown }[];
};
/** 排出来的一行送货：哪条订单明细、从哪个成品库存品出、多少 */
type PlanLine = { orderId: number; orderLineId: number; stockId: number; quantity: string; notes: string };
/** 一个客户一张送货单 */
type PlanGroup = { customerId: number; lines: PlanLine[] };

/** 订单还待确认时不能送、不能排产，提示的话 */
export const DRAFT_ORDER_HINT = '订单还待确认，先确认订单';

/**
 * 订单明细写的规格和产品现在的规格（就是成品库存的规格说明，跟着产品）对不上：对不上的不混着发，要人核对订单明细。
 * 只在产品写了尺寸单位、长和宽都填了时才比（高可以空：隔板、垫片这类只有长宽）。缺长、缺宽或没写单位时
 * 尺寸说不准，说不上和订单写的不一样（订单只写型号、产品资料还不全是常有的事），不比、不拦。
 * 订单明细的规格只是重复了产品名称时也不比（lineSpecification）。服务端出库和页面排送货都用它。
 */
export function specificationMismatch(stock: SizedStock, line: SpecLine) {
  const spec = lineSpecification(line);
  const sized =
    !!normalizeDimensionUnit(stock.dimensionUnit) &&
    [stock.length, stock.width].every((n) => typeof n === 'number' && n > 0);
  return !!stock.specification && !!spec && sized && !sameSpecification(stock.specification, spec);
}

/** 对不上时给人看的话：哪一项不一样（同一种写法并排），以及要核对订单明细。送货窗口和服务端出库被拦时用同一句 */
export function specificationMismatchText(stock: { specification?: string | null }, line: SpecLine) {
  return '规格和产品现在的不一样，' + specificationDifference(lineSpecification(line), stock.specification || '') + '，请核对这张订单的明细';
}

/** 订单能不能送货：没归档、不是待确认或已取消；超发时已发货的也能送 */
const canDeliverTo = (o: OrderFacts, allowOverdelivery: boolean) =>
  !o.archived && (allowOverdelivery ? effectiveOrder(o) : deliverableOrder(o));

export function deliveryCandidates<L extends OrderLineFacts>(
  stock: DeliveryStock,
  customerId: number | null,
  orders: OrderFacts<L>[],
  allowOverdelivery = false,
) {
  return orders
    .filter((o) => o.customerId === customerId && canDeliverTo(o, allowOverdelivery))
    .flatMap((o) =>
      o.lines
        .filter(
          (l) =>
            l.productId === stock.productId &&
            (allowOverdelivery || Number(l.remainingQuantity ?? l.quantity) > 0) &&
            !specificationMismatch(stock, l),
        )
        .map((line) => ({ orderId: o.id, orderLineId: line.id, orderNumber: o.number, ...line })),
    );
}
export function selectedStockUnits(lines: readonly { stockId?: number | null; quantity?: unknown }[], stockId: number) {
  let total = 0;
  for (const line of lines.filter((l) => l.stockId === stockId)) {
    try {
      total += quantityUnits(String(line.quantity));
    } catch {
      return null;
    }
  }
  return total;
}
/** 订单明细还没发的数量（后端给的可能是数字或数量文本），换成千分整数。 */
const remainingOf = (line: Pick<OrderLineFacts, 'remainingQuantity' | 'quantity'>) =>
  safeUnits(line.remainingQuantity ?? line.quantity);
/**
 * 每条订单明细已经排在待送货单上的数量（千分整数）。可用库存已经扣掉了待送货单占的货，
 * 算“还要排多少”时要从订单剩余里减掉这部分，不能再要一遍。orderId 给定时只算这张订单的明细。
 */
export function pendingByOrderLine(deliveries: readonly (PendingDelivery | null | undefined)[], orderId?: number) {
  const pending = new Map<number, number>();
  for (const d of deliveries)
    if (d && d.status === 'draft' && !d.archived)
      for (const l of d.lines || []) {
        if (!l.orderLineId || (orderId != null && Number(l.orderId) !== Number(orderId))) continue;
        pending.set(Number(l.orderLineId), (pending.get(Number(l.orderLineId)) || 0) + safeUnits(l.quantity));
      }
  return pending;
}
/** 订单明细还要排送货的数量：没发的减去已在待送货单上的。 */
const openOf = (line: Pick<OrderLineFacts, 'id' | 'remainingQuantity' | 'quantity'>, pending: Map<number, number>) =>
  Math.max(0, remainingOf(line) - (pending.get(line.id) || 0));
/** 成品库存品现在能拿来排送货的数量（千分整数） */
const freeUnits = (stock: PlannedStock) => Math.max(0, stock.availableUnits);
/** 把一行送货记到这个客户的送货单上 */
function addPlanLine(groups: Map<number, PlanGroup>, customerId: number, line: PlanLine) {
  const group = groups.get(customerId) ?? { customerId, lines: [] };
  group.lines.push(line);
  groups.set(customerId, group);
}
/**
 * 选了几个成品库存安排送货：每个成品用可用库存，按交期从早到晚分到等着它的订单明细；
 * 按客户分组，一个客户一张送货单。customerId 给定时只排这个客户的订单；
 * owners 里指定了客户的成品只排给那个客户（几个客户在等同一种货时由人来选）。
 */
export function planStockDelivery(
  stocks: PlannedStock[],
  orders: OrderFacts[],
  customerId?: number | null,
  owners: Record<number, number> = {},
  pending: Map<number, number> = new Map(),
) {
  const customers =
    customerId != null ? [customerId] : [...new Set(orders.map((o) => o.customerId))].filter((c) => c != null);
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const due = (orderId: number) => byOrder.get(orderId)?.deliveryDate || NO_DUE_DATE;
  const groups = new Map<number, PlanGroup>();
  // 同一条订单明细被前面的成品排满了，后面的不再重复排
  const used = new Map<number, number>();
  for (const stock of stocks) {
    let left = freeUnits(stock);
    const candidates = (owners[stock.id] != null ? [owners[stock.id]] : customers)
      .flatMap((c) => deliveryCandidates(stock, c, orders).map((x) => ({ ...x, customerId: c })))
      .sort((a, b) => due(a.orderId).localeCompare(due(b.orderId)) || a.orderId - b.orderId || a.orderLineId - b.orderLineId);
    for (const c of candidates) {
      if (left <= 0) break;
      const q = Math.min(left, openOf(c, pending) - (used.get(c.orderLineId) || 0));
      if (q <= 0) continue;
      used.set(c.orderLineId, (used.get(c.orderLineId) || 0) + q);
      left -= q;
      addPlanLine(groups, c.customerId, { orderId: c.orderId, orderLineId: c.orderLineId, stockId: stock.id, quantity: quantityString(q), notes: '' });
    }
  }
  return [...groups.values()];
}
/** 这个成品有哪几个客户的订单在等（排送货时不止一个客户就先让人选客户）。 */
export function waitingCustomers(stock: DeliveryStock, orders: OrderFacts[]) {
  return [...new Set(orders.map((o) => o.customerId))].filter(
    (c) => c != null && deliveryCandidates(stock, c, orders).length > 0,
  );
}
/** 这张订单为什么不能送：已归档、待确认、已取消、已发完；能送的是 null */
function skipReason(order: OrderFacts) {
  if (order.archived) return '已归档';
  if (order.status === '待确认') return DRAFT_ORDER_HINT;
  return closedOrder(order) ? order.status : null;
}
/** 按订单排送货时的进度：每个成品还剩多少、排好的送货单 */
type OrderPlan = { left: Map<number, number>; groups: Map<number, PlanGroup> };
/** 一条订单明细从它那个产品的成品里排上多少（千分整数）：成品没货、这条明细不能送（规格对不上等）的排 0 */
function arrangeLine(plan: OrderPlan, order: OrderFacts, line: OrderLineFacts, need: number, stock: DeliveryStock) {
  const free = plan.left.get(stock.id) || 0;
  if (free <= 0 || !deliveryCandidates(stock, order.customerId, [order]).some((c) => c.orderLineId === line.id)) return 0;
  const q = Math.min(free, need);
  plan.left.set(stock.id, free - q);
  addPlanLine(plan.groups, order.customerId, { orderId: order.id, orderLineId: line.id, stockId: stock.id, quantity: quantityString(q), notes: '' });
  return q;
}
/**
 * 按产品取成品库存品：一个产品只有一个成品库存品（数据库约束），不用在库存品列表里逐个 find；没关联产品的不算。
 * 同一个产品万一出现两条，取先出现的那条（和 find 一样）。排送货、排产和页面上按产品找成品都用它。
 */
export function stockByProduct<T extends { productId?: number | null }>(stocks: readonly T[]) {
  const map = new Map<number, T>();
  for (const stock of stocks)
    if (stock.productId != null && !map.has(stock.productId)) map.set(stock.productId, stock);
  return map;
}
/**
 * 选了几张订单合并送货：按交期从早到晚，每条还没发完的明细用对应成品的可用库存排满；
 * 按客户分组，一个客户一张送货单。没有库存的明细放进 missing，不硬排。
 * 一个产品只有一个成品库存（数据库约束），每条明细按产品直接取它那个成品。
 */
export function planOrderDelivery(orders: OrderFacts[], stocks: PlannedStock[], pending: Map<number, number> = new Map()) {
  const plan: OrderPlan = { left: new Map(stocks.map((s) => [s.id, freeUnits(s)])), groups: new Map() };
  const stockOf = stockByProduct(stocks);
  const missing: { orderId: number; orderNumber: string; productName: string; quantity: string; unit?: string | null }[] = [];
  // 待确认、已取消、已发完、已归档的订单不能送，单独说明原因
  const skipped: { orderId: number; orderNumber: string; reason: string }[] = [];
  const sorted = [...orders].sort(
    (a, b) => String(a.deliveryDate || NO_DUE_DATE).localeCompare(String(b.deliveryDate || NO_DUE_DATE)) || a.id - b.id,
  );
  for (const order of sorted) {
    const reason = skipReason(order);
    if (reason) {
      skipped.push({ orderId: order.id, orderNumber: order.number, reason });
      continue;
    }
    for (const line of order.lines) {
      let need = openOf(line, pending);
      if (need <= 0) continue;
      const stock = line.productId == null ? undefined : stockOf.get(line.productId);
      if (stock) need -= arrangeLine(plan, order, line, need, stock);
      // 规格对不上被拦下的不算“没有库存”：原因在上面的“对不上”里说（deliveryBlockers），这里不重复、不说错
      if (need > 0 && !(stock && specificationMismatch(stock, line)))
        missing.push({ orderId: order.id, orderNumber: order.number, productName: line.productName, quantity: quantityString(need), unit: line.unit });
    }
  }
  return { groups: [...plan.groups.values()], missing, skipped };
}
/** 订单在等、却排不了送货的一条原因 */
type DeliveryBlocker = {
  kind: 'draft' | 'spec';
  text: string;
  orderId: number;
  orderNumber: string;
  orderVersion?: number;
  customerId: number;
  orderLineId: number;
  productName: string;
  stockId: number;
};
/** 这条明细为什么等着这个成品却排不了：订单待确认、规格对不上；没问题的是 null */
function blockReason(stock: DeliveryStock, order: OrderFacts, line: OrderLineFacts) {
  if (order.status === '待确认') return { kind: 'draft' as const, text: DRAFT_ORDER_HINT };
  return specificationMismatch(stock, line) ? { kind: 'spec' as const, text: specificationMismatchText(stock, line) } : null;
}
/**
 * 这个成品为什么和在等它的订单对不上：同一产品、还没发完的订单明细里，规格不同、订单还待确认。
 * 订单明细和成品库存的单位都只有“只”（数据库约束），不会因为单位对不上。
 * 送货窗口和助手 delivery.plan 用它说清原因。
 */
export function deliveryBlockers(stock: DeliveryStock, orders: OrderFacts[], customerId?: number | null) {
  const out: DeliveryBlocker[] = [];
  for (const o of orders) {
    if (customerId != null && o.customerId !== customerId) continue;
    if (o.archived || closedOrder(o)) continue;
    for (const l of o.lines) {
      if (l.productId !== stock.productId || remainingOf(l) <= 0) continue;
      const reason = blockReason(stock, o, l);
      if (reason)
        out.push({
          ...reason,
          orderId: o.id,
          orderNumber: o.number,
          orderVersion: o.version,
          customerId: o.customerId,
          orderLineId: l.id,
          productName: l.productName,
          stockId: stock.id,
        });
    }
  }
  return out;
}
