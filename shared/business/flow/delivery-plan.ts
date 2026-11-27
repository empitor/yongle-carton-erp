import { defaultCustomerSite, deliverableOrder, safeUnits, type Customer, type CustomerSite } from '../../core/index.js';
import { deliveryBlockers, planOrderDelivery, planStockDelivery, waitingCustomers, type OrderFacts } from './warehouse-delivery.js';

/**
 * 安排送货的方案：页面“安排送货”窗口和助手 delivery.plan 都只用这一份。按怎么选的（可发货勾好的、选了成品、
 * 选了订单或客户）按客户排出初始送货单（预选默认厂区），再说清几个客户在等同一种货的、
 * 订单在等却对不上的、这次送不了的和原因。排法本身在 warehouse-delivery.ts。
 */

/** 排送货用到的库存品：成品、可用量（扣掉待送货单占的，千分整数），列表行带“已归档” */
type PlanStock = Parameters<typeof planStockDelivery>[0][number] & { kind: string; archived?: unknown };
/** 预填收货信息用的客户档案 */
type PlanCustomer = Pick<Customer, 'id' | 'sites'>;
type PlanLine = ReturnType<typeof planStockDelivery>[number]['lines'][number];
/** 可发货里勾好的：给哪个客户、哪几行多少 */
export type PlanPreset = { customerId: number; lines: Omit<PlanLine, 'notes'>[] };
/** 排送货要的：库存品、订单、客户，和每条订单明细已经排在待送货单上的数量（pendingByOrderLine） */
type PlanData<S extends PlanStock, O extends OrderFacts> = {
  items: S[];
  orders: O[];
  customers: PlanCustomer[];
  pending: Map<number, number>;
};
/**
 * 怎么排：preset 照搬可发货勾好的；stockIds 按成品排（owners 指定了客户的只给他）；
 * orderIds 按这几张订单排；都没给时按 customerId 带出这个客户还能送的订单。
 */
type PlanChoice = {
  preset?: PlanPreset;
  stockIds?: number[];
  orderIds?: number[];
  customerId?: number | null;
  owners?: Record<number, number>;
};

/** 订单还能送的：已确认、没发完、没归档 */
export const openOrder = (o: Pick<OrderFacts, 'archived' | 'status'>) => !o.archived && deliverableOrder(o);
/** 成品有可用量（扣掉待送货单占的） */
const free = (s: PlanStock) => s.availableUnits > 0;
/** 按订单排时能用的成品库存品：没归档的成品 */
const finishedOf = <S extends PlanStock>(items: S[]) => items.filter((i) => i.kind === 'finished' && !i.archived);

/** 按订单或客户排时，这次排哪几张订单 */
function pickedOrders<O extends OrderFacts>(orders: O[], c: PlanChoice) {
  if (c.preset || c.stockIds) return [];
  if (c.orderIds) {
    const ids = new Set(c.orderIds);
    return orders.filter((o) => ids.has(o.id));
  }
  return orders.filter((o) => o.customerId === c.customerId && openOrder(o));
}
/** 排出来的送货单，和这次排不了的订单（skipped）、缺货的明细（missing） */
function arrange<S extends PlanStock, O extends OrderFacts>(data: PlanData<S, O>, c: PlanChoice, stocks: S[], orders: O[]) {
  if (c.preset)
    return { groups: [{ customerId: c.preset.customerId, lines: c.preset.lines.map((l) => ({ ...l, notes: '' })) }], missing: [], skipped: [] };
  if (c.stockIds) return { groups: planStockDelivery(stocks, data.orders, null, c.owners, data.pending), missing: [], skipped: [] };
  return planOrderDelivery(orders, finishedOf(data.items), data.pending);
}
/** 订单在等却对不上的（规格不一致、订单待确认）：选了成品的看所有订单，选了订单的看这几张订单的产品 */
function blockersOf<S extends PlanStock, O extends OrderFacts>(data: PlanData<S, O>, c: PlanChoice, stocks: S[], orders: O[]) {
  if (c.stockIds) return stocks.flatMap((s) => deliveryBlockers(s, data.orders));
  const products = new Set(orders.flatMap((o) => o.lines.map((l) => l.productId)));
  return finishedOf(data.items)
    .filter((i) => i.productId != null && products.has(i.productId))
    .flatMap((i) => deliveryBlockers(i, orders));
}
/** 选的成品里送不了的，各说原因；订单在等、但规格对不上的，原因在“对不上”里说，这里不重复 */
function idleReason(stock: PlanStock, orders: OrderFacts[]) {
  if (!free(stock)) return '可用库存为 0（没货，或已被待送货的送货单占用）';
  return !waitingCustomers(stock, orders).length && !deliveryBlockers(stock, orders).length ? '没有客户订单在等' : '';
}

/**
 * 算安排送货的方案。groups：按客户带出默认厂区和可选厂区；contested：几个客户在等的成品
 * （已用 owners 指定了的也列着，好让人改）；blockers：订单在等却对不上的；idle：选的成品里送不了的和原因；
 * skipped、missing：选的订单里不能送的、缺货的明细。
 */
export function deliveryPlan<S extends PlanStock, O extends OrderFacts>(data: PlanData<S, O>, choice: PlanChoice) {
  const stocks = choice.stockIds ? data.items.filter((i) => choice.stockIds?.includes(i.id) && i.kind === 'finished') : [];
  const orders = pickedOrders(data.orders, choice);
  const plan = arrange(data, choice, stocks, orders);
  const customers = new Map(data.customers.map((c) => [c.id, c]));
  return {
    groups: plan.groups.map((g) => {
      const sites = customers.get(g.customerId)?.sites ?? [];
      return { ...g, sites, ...deliverySiteSnapshot(defaultCustomerSite(sites)) };
    }),
    missing: plan.missing,
    skipped: plan.skipped,
    blockers: blockersOf(data, choice, stocks, orders),
    contested: stocks
      .filter(free)
      .map((s) => ({ stock: s, customers: waitingCustomers(s, data.orders) }))
      .filter((x) => x.customers.length > 1),
    idle: stocks.map((s) => ({ stock: s, reason: idleReason(s, data.orders) })).filter((x) => x.reason),
  };
}

/** 录入时预览、服务端保存时写入的收货信息。 */
export function deliverySiteSnapshot(site: CustomerSite | undefined) {
  return {
    siteId: site?.id ?? null,
    siteName: site?.name ?? '',
    address: site?.address ?? '',
    contact: site?.contact ?? '',
    phone: site?.phone ?? '',
  };
}

/** 超过订单还没发的数量（扣掉已经排在别的待送货单上的）的行：要写原因。数量可以是人在窗口里改过的 */
export function overOrderLines<L extends Pick<PlanLine, 'orderId' | 'orderLineId' | 'quantity'>>(
  lines: L[],
  orders: OrderFacts[],
  pending: Map<number, number>,
) {
  const byId = new Map(orders.map((o) => [o.id, o]));
  return lines.filter((l) => {
    const line = byId.get(l.orderId)?.lines.find((x) => x.id === l.orderLineId);
    const left = (line ? safeUnits(line.remainingQuantity) : 0) - (pending.get(l.orderLineId) || 0);
    return safeUnits(l.quantity) > left;
  });
}
