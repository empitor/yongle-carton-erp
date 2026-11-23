import { orderDisplayStatus, orderInView, type displayOrderStatuses, type Order, type OrderView } from '../core/index.js';

/*
 * 页面订单列表和经营概况经 server/orders/record-lists.ts 筛选；助手查订单（records.search、records.summarize）也用这里的判断。
 * 都调这一份。状态只认页面上看到的叫法（displayOrderStatuses，“部分发货”由发货进度派生），不认别的说法。
 */

/** 订单状态的筛选值：页面上看到的叫法 */
type OrderStatusFilter = (typeof displayOrderStatuses)[number];
/** 订单列表的范围：全部 / 待处理 / 历史，下单日期起止，历史里是否留着没办完的 */
type OrderRange = { view?: OrderView; start?: string; end?: string; retainPending?: boolean };
/** 订单的筛选条件 */
type OrderFilter = OrderRange & { customerId?: number; productId?: number; status?: OrderStatusFilter; q?: string };

/** 订单的显示状态是不是这个（没给状态就都算） */
export const orderStatusMatches = (order: Pick<Order, 'status' | 'shippingProgress'>, status: string | undefined) =>
  !status || orderDisplayStatus(order) === status;

/** 订单在不在这个范围里（按订单自己的视图规则：已结束的才进历史，待处理不含已结束的） */
export const orderInRange = (order: Pick<Order, 'orderDate' | 'status'>, range: OrderRange) => orderInView(order, range);

/** 按单号、客户名、明细里的品名找 */
const orderText = (order: Order) => [order.number, order.customerName, ...order.lines.map((l) => l.productName)].join(' ').toLowerCase();

/** 订单合不合筛选条件：客户、产品、范围、状态、关键字 */
export function orderMatches(order: Order, f: OrderFilter) {
  return (
    (!f.customerId || order.customerId === f.customerId) &&
    (!f.productId || order.lines.some((l) => l.productId === f.productId)) &&
    orderInRange(order, f) &&
    orderStatusMatches(order, f.status) &&
    (!f.q || orderText(order).includes(f.q.toLowerCase()))
  );
}
