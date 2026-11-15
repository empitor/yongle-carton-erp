import { deliveryBlockers, flowInput, planOrderDelivery, planStockDelivery, waitingCustomers } from '../../shared/business/index';
import { safeUnits, today } from '../../shared/core/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import type { GroupInput, PlanLine } from './DeliveryPlanGroup';

/**
 * 安排送货窗口（DeliveryPlanDialog.tsx）的计算：按怎么打开的排出送货单、对不上的和送不了的原因、
 * 窗口里每张送货单的输入和超订单的行、交之前的检查和交给服务端的内容。只算数据，不引 React、不发请求。
 */

/** 排送货要的：库存品、订单、客户，和每条订单明细已经排在待送货单上的数量 */
export type PlanData = Pick<CatalogLists, 'items' | 'orders' | 'customers'> & { pending: Map<number, number> };
type Stock = PlanData['items'][number];
type OrderRow = PlanData['orders'][number];
/** 排出来的送货单（按客户分），和这次排不了的订单、明细 */
type DeliveryPlan = ReturnType<typeof planOrderDelivery>;
/** 窗口里的一行送货：排出来的一行加上它的键（客户、订单明细、库存品） */
type KeyedLine = PlanLine & { key: string };
type ShownGroup = { customerId: number; lines: KeyedLine[] };
/** 可发货里勾好的：给哪个客户、哪几行多少 */
export type PlanPreset = { customerId: number; lines: Omit<PlanLine, 'notes'>[] };

/** 订单还能送的：已确认、没发完、没归档 */
export const openOrder = (o: Pick<OrderRow, 'archived' | 'status'>) =>
  !o.archived && !['待确认', '已取消', '已发货'].includes(o.status);
/** 成品有可用量（扣掉待送货单占的） */
const free = (s: Stock) => Number(s.availableUnits ?? s.balanceUnits ?? 0) > 0;
const lineKey = (customerId: number, l: PlanLine) => customerId + '|' + l.orderLineId + '|' + l.stockId;

/** 按怎么打开的排：可发货勾好的照搬；选了成品的按成品排（owners 指定了客户的只给他）；选了订单或客户的按订单排 */
export function planOf(
  data: PlanData,
  o: { preset?: PlanPreset; stockIds?: number[]; stocks: Stock[]; owners: Record<number, number>; pickedOrders: OrderRow[] },
): DeliveryPlan {
  if (o.preset)
    return { groups: [{ customerId: o.preset.customerId, lines: o.preset.lines.map((l) => ({ ...l, notes: '' })) }], missing: [], skipped: [] };
  if (o.stockIds) return { groups: planStockDelivery(o.stocks, data.orders, null, o.owners, data.pending), missing: [], skipped: [] };
  return planOrderDelivery(o.pickedOrders, data.items.filter((i) => i.kind === 'finished' && !i.archived), data.pending);
}
/** 订单在等却对不上的（没写单位、规格不一致……） */
export function blockersOf(data: PlanData, stockIds: number[] | undefined, stocks: Stock[], pickedOrders: OrderRow[]) {
  if (stockIds) return stocks.flatMap((s) => deliveryBlockers(s, data.orders));
  const products = new Set(pickedOrders.flatMap((o) => o.lines.map((l) => l.productId)));
  return data.items
    .filter((i) => i.kind === 'finished' && !i.archived && i.productId !== null && products.has(i.productId))
    .flatMap((i) => deliveryBlockers(i, pickedOrders));
}
/** 几个客户在等的成品：先选给谁 */
export const contestedOf = (stocks: Stock[], orders: OrderRow[]) =>
  stocks
    .filter(free)
    .map((s) => ({ stock: s, customers: waitingCustomers(s, orders) }))
    .filter((x) => x.customers.length > 1);
/** 选的成品里送不了的，各说原因 */
export const idleOf = (stocks: Stock[], orders: OrderRow[]) =>
  stocks
    .map((s) => ({
      stock: s,
      reason: !free(s)
        ? '可用库存为 0（没货，或已被待送货的送货单占用）'
        : // 订单在等、但规格对不上的，原因在上面的“对不上”里说
          !waitingCustomers(s, orders).length && !deliveryBlockers(s, orders).length
          ? '没有客户订单在等'
          : '',
    }))
    .filter((x) => x.reason);
/** 窗口里显示的送货单：去掉人删掉的行，数量用人改过的 */
export const shownGroups = (plan: DeliveryPlan | null, removed: string[], edits: Record<string, string>): ShownGroup[] =>
  (plan?.groups || [])
    .map((g) => ({
      ...g,
      lines: g.lines
        .map((l) => ({ ...l, key: lineKey(g.customerId, l) }))
        .filter((l) => !removed.includes(l.key))
        .map((l) => ({ ...l, quantity: edits[l.key] ?? l.quantity })),
    }))
    .filter((g) => g.lines.length);

/** 窗口里要查的：客户名、每张送货单的输入（没改过的按客户档案和今天预填）、一行的订单和产品、超订单的行 */
export function planLookups(data: PlanData | null, inputs: Record<number, Partial<GroupInput>>) {
  const customer = (id: number) => data?.customers.find((c) => c.id === id);
  const orderLine = (l: PlanLine) => {
    const order = data?.orders.find((o) => o.id === l.orderId);
    return { order, line: order?.lines.find((x) => x.id === l.orderLineId) };
  };
  return {
    customerName: (id: number) => customer(id)?.name || '客户',
    inputOf: (customerId: number): GroupInput => {
      const c = customer(customerId);
      return { plannedDate: today(), address: c?.address || '', contact: c?.contact || '', phone: c?.phone || '', reason: '', ...inputs[customerId] };
    },
    lineInfo: (l: PlanLine) => {
      const { order, line } = orderLine(l);
      return { order: order?.number || '订单', product: line?.productName || '', unit: line?.unit || '', due: order?.deliveryDate };
    },
    // 超过订单还没发的数量（扣掉已经排在别的待送货单上的）：要写原因
    overOf: (lines: KeyedLine[]) =>
      lines
        .filter((l) => {
          const { line } = orderLine(l);
          const left = safeUnits(line?.remainingQuantity ?? line?.quantity ?? '0') - (data?.pending.get(l.orderLineId) || 0);
          return safeUnits(l.quantity) > left;
        })
        .map((l) => l.key),
  };
}
type Lookups = ReturnType<typeof planLookups>;

/** 交之前查：每张还没建的送货单要有计划日，超订单的要写原因；有问题返回那句话，没问题是空串 */
export function planProblem(groups: ShownGroup[], created: Record<number, string>, look: Lookups) {
  for (const g of groups) {
    if (created[g.customerId]) continue;
    const v = look.inputOf(g.customerId);
    if (!v.plannedDate) return '请填写送给 ' + look.customerName(g.customerId) + ' 的计划送货日期。';
    if (look.overOf(g.lines).length && !v.reason.trim())
      return '送给 ' + look.customerName(g.customerId) + ' 的有几行超过订单数量，请写明超订单的原因。';
  }
  return '';
}
/** 一张送货单交给服务端的内容（不含请求号） */
export function deliveryBody(g: ShownGroup, v: GroupInput, over: boolean) {
  return flowInput('delivery', {
    date: today(),
    plannedDate: v.plannedDate,
    plannedTime: null,
    actualTime: null,
    notes: '',
    customerId: g.customerId,
    address: v.address,
    contact: v.contact,
    phone: v.phone,
    allowOverdelivery: over,
    overdeliveryReason: over ? v.reason.trim() : '',
    lines: g.lines.map(({ key: _, ...l }) => l),
  });
}
/** 这次一张都排不出来时说的那句：订单在等、但规格或单位对不上的，原因在上面的黄框里，这里不再说成“没有订单在等”“没有库存” */
export const emptyText = (blocked: boolean, byStock: boolean) =>
  blocked
    ? '这次没有能直接安排的：在等的订单和成品对不上，原因见上面，核对订单明细后再安排。'
    : byStock
      ? '选的成品没有客户订单在等，或可用库存为零。'
      : '选的订单没有可送的库存：先登记完工，或等成品到齐。';
