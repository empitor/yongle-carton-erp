// 助手工具：安排送货、安排生产的只读试算（delivery.plan、production.plan）。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { many, rows } from '../../core/index.js';
import { quantityString, type Order } from '../../../shared/core/index.js';
import { deliveryBlockers, pendingByOrderLine, planOrderDelivery, planStockDelivery, waitingCustomers } from '../../../shared/business/index.js';
import { planProductionForOrders, type StockItemView } from '../../../shared/business/index.js';
import { relatedBusiness } from '../../business/index.js';
import { fail, positive, requireActor, type ToolContext, type ToolReader } from './context.js';

/** 一次安排生产最多几张订单 */
const PRODUCTION_MAX_ORDERS = 50;
/** 给模型看的参数示例里列几张订单（编号 1、2、3） */
const EXAMPLE_ORDERS = 3;
const PICK_ONE = '传stockIds（成品库存）或orderIds（订单）其中一种';
// 多选安排送货、安排生产之前先算方案（和人工窗口同一份算法）
const deliveryPlanSchema = z
  .strictObject({
    stockIds: z.array(positive).min(1).max(100).optional(),
    orderIds: z.array(positive).min(1).max(100).optional(),
    owners: z.array(z.strictObject({ stockId: positive, customerId: positive })).max(100).optional(),
  })
  .refine((v) => !!v.stockIds !== !!v.orderIds, PICK_ONE);
const productionPlanSchema = z.strictObject({ orderIds: z.array(positive).min(1).max(PRODUCTION_MAX_ORDERS) });

export const planningTools = [
  {
    name: 'delivery.plan',
    risk: 'read',
    description: '算送货方案：安排送货前用（多选库存或订单时）。和“安排送货”窗口同一算法：stockIds 按交期把库存分给在等的订单，orderIds 把订单没发完的排满；按客户分组。contested 里几个客户等同一种货时先问用户，再用 owners 指定。只读；保存用 records.propose_save 的 items，一组一张送货单，组里的 address、contact、phone 照带上。',
    arguments: { stockIds: [1, 2], orderIds: '或改传订单id', owners: [{ stockId: 1, customerId: 3 }] },
    schema: deliveryPlanSchema,
  },
  {
    name: 'production.plan',
    risk: 'read',
    description: '算生产方案：安排生产前用，一次可以排几种产品，不要拆成几条。和“安排生产”窗口同一算法：同一产品合成一张任务，建议数量 = 合计待发 − 成品可用库存，不同单位不相加。只读；几组一次用 records.propose_save 的 items 建（生产任务），一张卡片，数量默认 suggested，用户说的优先；没有订单的备货不传 orderIds，数量问用户。',
    arguments: { orderIds: Array.from({ length: EXAMPLE_ORDERS }, (_, i) => i + 1) },
    schema: productionPlanSchema,
  },
];

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
/** 订了这几种产品的订单编号 */
function orderIdsOfProducts(ctx: ToolContext, productIds: number[]) {
  if (!productIds.length) return [];
  const sql = 'SELECT DISTINCT order_id FROM order_lines WHERE product_id IN (' + placeholders(productIds.length) + ')';
  return many(ctx.store.db, rows.order_lines.pick({ order_id: true }), sql, ...productIds).map((r) => r.order_id);
}
/** 这几种产品的成品库存品编号 */
function finishedOfProducts(ctx: ToolContext, productIds: number[]) {
  if (!productIds.length) return [];
  const sql = "SELECT id FROM stock_items WHERE kind='finished' AND product_id IN (" + placeholders(productIds.length) + ')';
  return many(ctx.store.db, rows.stock_items.pick({ id: true }), sql, ...productIds).map((r) => r.id);
}

/**
 * 按主键批量读：选了订单就只读这几张订单和它们产品的成品库存；选了成品库存就只读这几种库存
 * 和订了这些产品的订单（在等的订单只会是这些），不全量加载后再筛。stocks 是选中的成品库存（选订单时是空的）。
 */
function deliverySources(ctx: ToolContext, v: z.output<typeof deliveryPlanSchema>) {
  if (v.stockIds) {
    const stocks = ctx.flow.views.items(false, v.stockIds).filter((i) => i.kind === 'finished');
    const orders = ctx.store.ordersByIds(orderIdsOfProducts(ctx, [...new Set(stocks.map((s) => Number(s.productId)).filter(Boolean))]));
    return { stocks, items: stocks, orders };
  }
  // 结构上的检查保证二者有一个
  const orders = ctx.store.ordersByIds(v.orderIds ?? fail(PICK_ONE));
  const productIds = [...new Set(orders.flatMap((o) => o.lines.map((l) => Number(l.productId))))];
  const stocks: StockItemView[] = [];
  return { stocks, items: ctx.flow.views.items(false, finishedOfProducts(ctx, productIds)).filter((i) => i.kind === 'finished'), orders };
}

/** 选中的库存里可用的、没指定给谁、又有几个客户在等的：先问用户给谁 */
function contestedStocks(stocks: StockItemView[], orders: Order[], owners: Record<number, number>, customerName: (id: number) => string | undefined) {
  return stocks
    .filter((s) => Number(s.availableUnits) > 0 && owners[s.id] == null)
    .map((s) => ({ stockId: s.id, name: s.name, customers: waitingCustomers(s, orders).map((id) => ({ id, name: customerName(id) })) }))
    .filter((x) => x.customers.length > 1);
}

function planDelivery(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  requireActor(who);
  const v = deliveryPlanSchema.parse(raw ?? {});
  const { stocks, items, orders } = deliverySources(ctx, v);
  const customerIds = [...new Set(orders.map((o) => o.customerId).filter((id): id is number => id != null))];
  const customers = new Map(ctx.store.customers(true, customerIds).map((c) => [c.id, c]));
  const owners = Object.fromEntries((v.owners || []).map((o) => [o.stockId, o.customerId]));
  // 已经排在待送货单上的数量要从“还要排多少”里扣掉（可用库存已经扣过它），和人工“安排送货”窗口一样。
  // 只读待送货的送货单，按主键批量组装。
  const draftIds = many(ctx.store.db, rows.flow_documents.pick({ id: true }), "SELECT id FROM flow_documents WHERE kind='delivery' AND status='draft'").map((r) => r.id);
  const pending = pendingByOrderLine(ctx.flow.list('delivery', false, undefined, draftIds));
  const plan = v.stockIds
    ? { groups: planStockDelivery(stocks, orders, null, owners, pending), missing: [], skipped: [] }
    : planOrderDelivery(orders, items, pending);
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  return {
    groups: plan.groups.map((g) => ({
      customerId: g.customerId,
      customerName: customers.get(g.customerId)?.name,
      address: customers.get(g.customerId)?.address || '',
      contact: customers.get(g.customerId)?.contact || '',
      phone: customers.get(g.customerId)?.phone || '',
      lines: g.lines.map((l) => {
        const order = orderOf.get(l.orderId),
          line = order?.lines.find((x) => x.id === l.orderLineId);
        return { ...l, orderNumber: order?.number, productName: line?.productName, unit: line?.unit };
      }),
    })),
    contested: contestedStocks(stocks, orders, owners, (id) => customers.get(id)?.name),
    missing: plan.missing,
    // 订单在等却对不上的原因（规格不一致、订单待确认）
    blockers: (v.stockIds ? stocks : items).flatMap((s) => deliveryBlockers(s, orders)).map(({ orderVersion: _version, ...b }) => b),
    skipped: [
      ...plan.skipped,
      ...stocks.filter((s) => Number(s.availableUnits) <= 0).map((s) => ({ stockId: s.id, name: s.name, reason: '可用库存为0' })),
    ],
    url: v.stockIds ? '#warehouse?kind=finished' : '#orders',
  };
}

function planProduction(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  requireActor(who);
  const v = productionPlanSchema.parse(raw ?? {});
  const orders = ctx.store.ordersByIds(v.orderIds),
    related = orders.map((o) => relatedBusiness(ctx.store, 'orders', o.id));
  const plan = planProductionForOrders(orders, related, ctx.flow.views.items());
  return {
    groups: plan.groups.map((g) => ({
      productId: g.productId,
      name: g.name,
      unit: g.unit,
      orderIds: g.orderIds,
      orderNumbers: g.orderIds.map((id) => orders.find((o) => o.id === id)?.number),
      needQuantity: quantityString(g.needUnits),
      availableQuantity: quantityString(g.availableUnits),
      suggested: g.suggested,
    })),
    skipped: plan.skipped,
    url: '#orders',
  };
}

export const planningReaders: Record<string, ToolReader> = {
  'delivery.plan': planDelivery,
  'production.plan': planProduction,
};
