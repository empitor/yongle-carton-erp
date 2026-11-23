import { quantityString, safeUnits } from '../core/index.js';
import { activeDoc } from './physical-flow.js';
import { DRAFT_ORDER_HINT, pendingByOrderLine, type OrderFacts, type OrderLineFacts } from './warehouse-delivery.js';

export type ProductionPlanGroup = {
  key: string;
  productId: number;
  name: string;
  /** 成品单位只有“只” */
  unit?: string;
  orderIds: number[];
  needUnits: number;
  availableUnits: number;
  /** 建议本次生产 = 合计待发 − 库存可用 */
  suggested: string;
};

/** 算成品库存可用要看的库存品字段：可用量是千分整数 */
type PlanStock = { kind: string; archived?: unknown; productId?: number | null; availableUnits?: unknown };
/** 排产要看的订单字段（订单明细的字段见 warehouse-delivery.ts 的 OrderLineFacts） */
type PlanOrder = Pick<OrderFacts, 'id' | 'number' | 'status' | 'archived'> & { lines?: readonly OrderLineFacts[] };
/** 关联的生产任务：完工、计划数量是数量文本 */
type PlanTask = { status?: unknown; archived?: unknown; productId?: number | null; completed?: unknown; quantity: unknown };
/** 订单的关联业务（生产任务、送货单）；读不到时为空 */
type PlanRelated = {
  tasks?: readonly PlanTask[];
  deliveries?: Parameters<typeof pendingByOrderLine>[0];
} | null | undefined;
type Skipped = { orderId: number | null; orderNumber: string; reason: string };
/** 一张订单里一个产品（同一单位）还要生产的数量（千分整数） */
type OwnProduct = { productId: number; name: string; unit?: string; remaining: number };

/** 产品的成品库存可用（按“只”算）。 */
export function finishedAvailable(items: readonly PlanStock[], productId: number) {
  return items
    .filter((s) => s.kind === 'finished' && !s.archived && s.productId === productId)
    .reduce((n, s) => n + Math.max(0, Number(s.availableUnits) || 0), 0);
}

/** 订单能不能排产：只有已确认、生产中的能排；别的返回不排的原因 */
function skipReason(order: PlanOrder) {
  if (order.archived) return '已归档';
  if (['已确认', '生产中'].includes(order.status)) return null;
  return order.status === '待确认' ? DRAFT_ORDER_HINT : order.status;
}

/**
 * 这张订单按产品（同一单位）合计还要生产的数量：没发的减去已经排在待送货单上的
 * （待送货单由库存发出，不用再生产，可用库存也已扣掉它们）。unshipped：还有没发的。
 */
function ownProducts(order: PlanOrder, pending: ReadonlyMap<number, number>) {
  let unshipped = false;
  const own = new Map<string, OwnProduct>();
  for (const l of order.lines || []) {
    const unit = l.unit,
      key = String(l.productId) + '|' + String(unit),
      g = own.get(key) || { productId: l.productId, name: l.productName, unit, remaining: 0 };
    const left = Math.max(0, safeUnits(l.remainingQuantity));
    if (left > 0) unshipped = true;
    g.remaining += Math.max(0, left - (pending.get(Number(l.id)) || 0));
    own.set(key, g);
  }
  return { own, unshipped };
}

/**
 * 多选订单“安排生产”：同一产品合成一张生产任务（关联这几张订单），
 * 数量 = 这几张订单还没发的合计 − 成品库存可用（库存只算一次，不能每张订单各扣一遍）。
 * 订单这个产品已有任务在做（没做完）的不再排；库存够发的不排。
 * 订单明细、生产任务和成品库存的单位都只有“只”（数据库约束），按产品分组、按产品对任务。
 * 人工窗口和助手 production.plan 用同一份算法。related 和 orders 一一对应（关联的生产任务），items 是库存品。
 */
export function planProductionForOrders(orders: readonly PlanOrder[], related: readonly PlanRelated[], items: readonly PlanStock[]) {
  const groups = new Map<string, ProductionPlanGroup>(),
    skipped: Skipped[] = [];
  /** 把一张订单的各产品并进生产分组；这个产品已有任务在做的记进不排。返回有没有并进去的 */
  const addOrder = (order: PlanOrder, own: Map<string, OwnProduct>, tasks: readonly PlanTask[]) => {
    let added = false;
    for (const [key, g] of own) {
      if (g.remaining <= 0) continue;
      const working = tasks.some((t) => t.productId === g.productId && safeUnits(t.completed) < safeUnits(t.quantity));
      if (working) {
        skipped.push({ orderId: order.id, orderNumber: order.number, reason: g.name + ' 已有生产任务在做' });
        continue;
      }
      added = true;
      const group: ProductionPlanGroup = groups.get(key) || {
        key,
        productId: g.productId,
        name: g.name,
        unit: g.unit,
        orderIds: [],
        needUnits: 0,
        availableUnits: finishedAvailable(items, g.productId),
        suggested: '0',
      };
      group.orderIds.push(order.id);
      group.needUnits += g.remaining;
      groups.set(key, group);
    }
    return added;
  };
  orders.forEach((order, i) => {
    const reason = skipReason(order);
    if (reason !== null) {
      skipped.push({ orderId: order.id, orderNumber: order.number, reason });
      return;
    }
    const tasks = (related[i]?.tasks || []).filter(activeDoc);
    const { own, unshipped } = ownProducts(order, pendingByOrderLine(related[i]?.deliveries || [], order.id));
    if (!addOrder(order, own, tasks) && !skipped.some((s) => s.orderId === order.id))
      skipped.push({ orderId: order.id, orderNumber: order.number, reason: unshipped ? '剩下的都已排进待送货单' : '已全部发货' });
  });
  return { groups: suggestedGroups(groups.values(), skipped), skipped };
}

/** 各产品还缺的才排：建议数量 = 待发 − 可用；库存够发的记进不排 */
function suggestedGroups(groups: Iterable<ProductionPlanGroup>, skipped: Skipped[]) {
  const result: ProductionPlanGroup[] = [];
  for (const g of groups) {
    const shortage = g.needUnits - g.availableUnits;
    if (shortage > 0) result.push({ ...g, suggested: quantityString(shortage) });
    else
      skipped.push({
        orderId: null,
        orderNumber: g.name,
        reason: '库存够发（待发 ' + quantityString(g.needUnits) + '，可用 ' + quantityString(g.availableUnits) + ' ' + String(g.unit) + '）',
      });
  }
  return result;
}
