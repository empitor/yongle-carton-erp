import { sales } from '../../sales/index.js';
import type { Actor } from '../../core/index.js';
import { canEnterSuperMode, requireSuperModeFor } from '../../core/index.js';
import { effectiveOrder, orderTaxSnapshot, quantityUnits, quantityString, type Order } from '../../../shared/core/index.js';
import { lineMoney, specificationMismatch, specificationMismatchText, type FlowDocument } from '../../../shared/business/index.js';
import { fail, type DeliveryLine, type LineCheck, type StockItemRow } from '../documents/base.js';
import { shippedUnits } from '../documents/shipped.js';
/*
 * 送货单的校验（validate.ts 的 validateFlow 按种类分派过来）：客户、订单明细、成品和订单的产品、规格、超订单发货。
 */

type Delivery = FlowDocument<'delivery'>;
type OrderLine = Order['lines'][number];

/** 这一行发的订单和订单明细：同一客户、正常已确认的订单（本机管理员不卡订单状态） */
function orderLineOf(ctx: LineCheck<DeliveryLine>, v: Delivery, l: DeliveryLine): { order: Order; line: OrderLine } {
  const { flow, maintenance } = ctx;
  const order = sales(flow.store).order(l.orderId, maintenance),
    line = order?.lines.find((x) => x.id === l.orderLineId);
  if (!order || order.customerId !== v.customerId || !line || (!maintenance && !effectiveOrder(order)))
    return fail('请选择同一客户正常已确认订单的有效产品明细。');
  return { order, line };
}

/** 补全后的一行：订单明细的品名、规格、单价、税率，产品尺寸（成品库存没填尺寸的取产品的），产品的材质、楞型 */
function completedLine(ctx: LineCheck<DeliveryLine>, l: DeliveryLine, o: { order: Order; line: OrderLine }, it: StockItemRow): DeliveryLine {
  const { order, line: ol } = o;
  const product = sales(ctx.flow.store).product(ol.productId, true),
    dimensions = it.length != null || it.width != null ? it : product;
  return {
    ...l,
    productName: ol.productName,
    specification: ol.specification,
    unit: ol.unit,
    orderNumber: order.number,
    externalPurchaseOrder: order.externalPurchaseOrder || '',
    customerProductCode: ol.customerProductCode || '',
    // 订单明细的单价库里必填（unit_price_e4 NOT NULL），读出来的明细一定带精确单价
    unitPriceExact: ol.unitPriceExact,
    amountExact: lineMoney(l.quantity, ol.unitPriceExact),
    taxRate: orderTaxSnapshot(ol) ?? orderTaxSnapshot(order),
    taxMode: ol.taxMode || order.taxMode || '',
    productId: ol.productId,
    length: dimensions?.length ?? null,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    dimensionUnit: dimensions?.dimensionUnit ?? null,
    material: product?.material,
    flute: product?.flute,
  };
}

/** 一行送货：成品对得上订单明细的产品和规格，超订单发货按规矩办，记出库变化、补全明细 */
function checkLine(ctx: LineCheck<DeliveryLine>, v: Delivery, l: DeliveryLine) {
  const { flow, actor, skipRemaining, item, change, warnings, lines } = ctx;
  const target = orderLineOf(ctx, v, l),
    { order: o, line: ol } = target;
  // 订单明细和成品的单位都只有“只”（数据库约束），只需对产品
  const it = item(l.stockId, 'finished');
  if (it.productId !== ol.productId) fail('成品库存的产品与订单明细不一致，请重新选择成品。');
  // 成品库存的规格说明就是产品现在的规格（跟着产品改），对不上只可能是订单明细还写着旧规格：让人核对订单。
  // 产品尺寸没填全的不比（规则见 specificationMismatch，页面排送货同一个判断）
  if (specificationMismatch(it, ol)) fail('订单 ' + o.number + ' 的“' + ol.productName + '”' + specificationMismatchText(it, ol) + '。');
  const qty = quantityUnits(l.quantity);
  if (!skipRemaining) {
    const over = checkOverdelivery(actor, v, { order: o, line: ol, quantity: qty, shipped: shippedUnits(flow.store.db, l.orderLineId) });
    if (over) warnings.push(over);
  }
  change(it, -qty, '客户发货', undefined, o.id);
  lines.push(completedLine(ctx, l, target, it));
}

/** 送货单：客户、订单明细、成品对应的产品和规格、超订单发货（要超级管理员模式并写原因） */
export function checkDelivery(ctx: LineCheck<DeliveryLine>, v: Delivery) {
  if (!sales(ctx.flow.store).customer(v.customerId, ctx.maintenance)) fail('客户不存在或已归档。');
  const selected = new Set<number>();
  for (const l of v.lines) {
    if (selected.has(l.orderLineId)) fail('同一订单明细请合并为一条发货数量。');
    selected.add(l.orderLineId);
    checkLine(ctx, v, l);
  }
}

/** 一行送货对一条订单明细：order、line 是订单和明细，quantity 是本次数量、shipped 是别的有效送货单已发的（都是千分整数） */
type DeliveryLineCheck = {
  order: { number: string };
  line: { productName?: string; quantity: number; unit?: string };
  quantity: number;
  shipped: number;
};
/**
 * 超订单发货：这一行发完（已发 + 本次）超过订购数时，没勾“超订单数量发货”按同一句话拒，
 * 勾了要超级管理员模式（进不了模式的账号直接说没有权限）并写原因；返回要加的提示，没超是 null。
 * 新送货单核对和更正送货单（delivery-correction-plan.ts，只查数量变多的行）共用这一处。
 * 订购数按千分整数换算（quantityUnits），不用浮点乘 1000：带三位小数的数量乘出来会差一点点，被误判成超发
 */
export function checkOverdelivery(actor: Actor, v: { allowOverdelivery?: boolean; overdeliveryReason?: string }, c: DeliveryLineCheck) {
  const { order: o, line: ol, quantity: qty, shipped } = c,
    ordered = quantityUnits(String(ol.quantity));
  if (qty + shipped <= ordered) return null;
  // 超了先说超了多少；确实要多发得在送货单里申请超订单发货
  if (!v.allowOverdelivery)
    fail(
      '本次发货超过订单剩余数量（订单 ' + o.number + ' 的“' + ol.productName + '”还能发 ' +
        quantityString(Math.max(0, ordered - shipped)) + ' ' + ol.unit + '，本次 ' +
        quantityString(qty) + ' ' + ol.unit + '）。' +
        (canEnterSuperMode(actor)
          ? '确实要多发，在送货单的“超订单数量发货（特殊情况）”里勾选并写明原因，要超级管理员模式。'
          : '确实要多发，要超级管理员账号来办。'),
      409,
    );
  requireSuperModeFor(actor, '超订单数量发货');
  if (!v.overdeliveryReason) fail('超订单数量发货要写明原因。');
  return o.number + '超订单数量发货：' + ol.productName;
}
