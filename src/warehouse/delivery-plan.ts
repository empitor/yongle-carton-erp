import { flowInput, overOrderLines, type deliveryPlan } from '../../shared/business/index';
import { today } from '../../shared/core/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import type { GroupInput, PlanLine } from './DeliveryPlanGroup';

/**
 * 安排送货窗口（DeliveryPlanDialog.tsx）的窗口状态：人删掉、改过的行，每张送货单的输入，交之前的检查和
 * 交给服务端的内容。排法、谁在争、对不上和送不了的原因在共用的 deliveryPlan（shared/business/flow/delivery-plan.ts），
 * 助手 delivery.plan 用的是同一份。只算数据，不引 React、不发请求。
 */

/** 排送货要的：库存品、订单、客户，和每条订单明细已经排在待送货单上的数量 */
export type PlanData = Pick<CatalogLists, 'items' | 'orders' | 'customers'> & { pending: Map<number, number> };
/** 排出来的送货单（一个客户一张，带预填的收货信息） */
type Plan = Pick<ReturnType<typeof deliveryPlan>, 'groups'>;
type PlanGroup = Plan['groups'][number];
/** 窗口里的一行送货：排出来的一行加上它的键（客户、订单明细、库存品） */
type KeyedLine = PlanLine & { key: string };
type ShownGroup = Omit<PlanGroup, 'lines'> & { lines: KeyedLine[] };

const lineKey = (customerId: number, l: PlanLine) => customerId + '|' + l.orderLineId + '|' + l.stockId;

/** 窗口里显示的送货单：去掉人删掉的行，数量用人改过的 */
export const shownGroups = (plan: Plan, removed: string[], edits: Record<string, string>): ShownGroup[] =>
  plan.groups
    .map((g) => ({
      ...g,
      lines: g.lines
        .map((l) => ({ ...l, key: lineKey(g.customerId, l) }))
        .filter((l) => !removed.includes(l.key))
        .map((l) => ({ ...l, quantity: edits[l.key] ?? l.quantity })),
    }))
    .filter((g) => g.lines.length);

/** 窗口里要查的：客户名、每张送货单的输入（没改过的按排出来的收货信息和今天预填）、一行的订单和产品、超订单的行 */
export function planLookups(data: PlanData | null, inputs: Record<number, Partial<GroupInput>>) {
  const customer = (id: number) => data?.customers.find((c) => c.id === id);
  const orderLine = (l: PlanLine) => {
    const order = data?.orders.find((o) => o.id === l.orderId);
    return { order, line: order?.lines.find((x) => x.id === l.orderLineId) };
  };
  return {
    customerName: (id: number) => customer(id)?.name || '客户',
    inputOf: (g: ShownGroup): GroupInput => ({
      plannedDate: today(),
      address: g.address,
      contact: g.contact,
      phone: g.phone,
      reason: '',
      ...inputs[g.customerId],
    }),
    lineInfo: (l: PlanLine) => {
      const { order, line } = orderLine(l);
      return { order: order?.number || '订单', product: line?.productName || '', unit: line?.unit || '', due: order?.deliveryDate };
    },
    overOf: (lines: KeyedLine[]) => (data ? overOrderLines(lines, data.orders, data.pending).map((l) => l.key) : []),
  };
}
type Lookups = ReturnType<typeof planLookups>;

/** 交之前查：每张还没建的送货单要有计划日，超订单的要写原因；有问题返回那句话，没问题是空串 */
export function planProblem(groups: ShownGroup[], created: Record<number, string>, look: Lookups) {
  for (const g of groups) {
    if (created[g.customerId]) continue;
    const v = look.inputOf(g);
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
