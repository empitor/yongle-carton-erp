import { sales } from '../../sales/index.js';
import { trackOrders } from '../../orders/index.js';
// 助手工具：安排送货、安排生产的只读试算（delivery.plan、production.plan）。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { pageHref, quantityString } from '../../../shared/core/index.js';
import { finishedIdsOfProducts, orderIdsOfProducts } from '../../operations/index.js';
import { deliveryPlan, pendingByOrderLine, planProductionForOrders } from '../../../shared/business/index.js';
import { relatedBusiness } from '../../overview/index.js';
import { fail, positive, requireActor, type ToolContext } from './context.js';
import { readTool } from './define.js';

/** 一次安排生产最多几张订单 */
const PRODUCTION_MAX_ORDERS = 50;
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
  readTool({
    name: 'delivery.plan',
    description: '算送货方案：安排送货前用（多选库存或订单时）。stockIds 按交期分配库存，orderIds 排未发完的订单。按客户分组，预选默认厂区并列出可选厂区和收货信息。contested 里没 owner 的先问用户给谁，再用 owners 指定。只读；保存用 records.propose_save 的 items，每张带 siteId。同客户多厂区时按实际收货厂区拆分明细，每个厂区一张。',
    schema: deliveryPlanSchema,
  }, planDelivery),
  readTool({
    name: 'production.plan',
    description: '算生产方案：安排生产前用，一次可以排几种产品，不要拆成几条。和“安排生产”窗口同一算法：同一产品合成一张任务，建议数量 = 合计待发 − 成品可用库存，不同单位不相加。只读；几组一次用 records.propose_save 的 items 建（生产任务），一张卡片，数量默认 suggested，用户说的优先；没有订单的备货不传 orderIds，数量问用户。',
    schema: productionPlanSchema,
  }, planProduction),
];

/**
 * 按主键批量读：选了订单就只读这几张订单和它们产品的成品库存；选了成品库存就只读这几种库存
 * 和订了这些产品的订单（在等的订单只会是这些），不全量加载后再筛。编号由采购库存的轻量读函数挑出来。
 */
function deliverySources(ctx: ToolContext, v: z.output<typeof deliveryPlanSchema>) {
  if (v.stockIds) {
    const items = ctx.flow.views.items(false, v.stockIds).filter((i) => i.kind === 'finished');
    const productIds = [...new Set(items.map((s) => Number(s.productId)).filter(Boolean))];
    const orders = trackOrders(ctx.store, sales(ctx.store).ordersByIds(orderIdsOfProducts(ctx.store, productIds)));
    return { items, orders };
  }
  // 结构上的检查保证二者有一个
  const orders = trackOrders(ctx.store, sales(ctx.store).ordersByIds(v.orderIds ?? fail(PICK_ONE)));
  const productIds = [...new Set(orders.flatMap((o) => o.lines.map((l) => Number(l.productId))))];
  return { items: ctx.flow.views.items(false, finishedIdsOfProducts(ctx.store, productIds)).filter((i) => i.kind === 'finished'), orders };
}

/** 按编号取库存品、订单、客户和待送货单，交给和人工“安排送货”窗口同一份的 deliveryPlan 算，再补上单号、名称给模型看 */
function planDelivery(ctx: ToolContext, v: z.output<typeof deliveryPlanSchema>, who: Actor | null | undefined) {
  requireActor(who);
  const { items, orders } = deliverySources(ctx, v);
  const customerIds = [...new Set(orders.map((o) => o.customerId).filter((id): id is number => id != null))];
  const customers = sales(ctx.store).customers(true, customerIds);
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const owners = Object.fromEntries((v.owners || []).map((o) => [o.stockId, o.customerId]));
  // 已经排在待送货单上的数量要从“还要排多少”里扣掉（可用库存已经扣过它）。只读待送货的送货单，按主键批量组装。
  const pending = pendingByOrderLine(ctx.flow.list('delivery', false, undefined, ctx.flow.draftIds('delivery')));
  const plan = deliveryPlan({ items, orders, customers, pending }, { stockIds: v.stockIds, orderIds: v.orderIds, owners });
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  return {
    groups: plan.groups.map(({ lines, ...g }) => ({
      ...g,
      customerName: nameOf.get(g.customerId),
      lines: lines.map((l) => {
        const order = orderOf.get(l.orderId),
          line = order?.lines.find((x) => x.id === l.orderLineId);
        return { ...l, orderNumber: order?.number, productName: line?.productName, unit: line?.unit };
      }),
    })),
    // 已经用 owners 指定了的也列着（owner 是指定的客户），和窗口一样能改
    contested: plan.contested.map(({ stock, customers: ids }) => ({
      stockId: stock.id,
      name: stock.name,
      owner: owners[stock.id],
      customers: ids.map((id) => ({ id, name: nameOf.get(id) })),
    })),
    missing: plan.missing,
    // 订单在等却对不上的原因（规格不一致、订单待确认）
    blockers: plan.blockers.map(({ orderVersion: _version, ...b }) => b),
    skipped: [...plan.skipped, ...plan.idle.map(({ stock, reason }) => ({ stockId: stock.id, name: stock.name, reason }))],
    url: v.stockIds ? pageHref('warehouse', { kind: 'finished' }) : pageHref('orders'),
  };
}

function planProduction(ctx: ToolContext, v: z.output<typeof productionPlanSchema>, who: Actor | null | undefined) {
  requireActor(who);
  const orders = trackOrders(ctx.store, sales(ctx.store).ordersByIds(v.orderIds)),
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
    url: pageHref('orders'),
  };
}
