import { z } from 'zod';
import { roundingPolicies, statuses } from './domain.js';
import { shippingProgresses } from './fulfillment.js';

/*
 * 读出来的订单视图（server/sales/orders.ts 组装）的结构，类型 Order 就按它推。只描述形状，不带录入规则的长度上限、
 * 去空格这些：防重复提交同号重发时按它校验库里存的上次结果，那是存过的数据，不该再过一遍录入时的限制。
 */

/** 订料进度：不用订料、待订、部分到料、到齐 */
const materialProgresses = ['none', 'pending', 'partial', 'done'] as const;
const optionalText = z.string().optional();

/** 读出来的订单明细：一定有编号、产品名称和四位小数的精确单价 */
const orderLineView = z.object({
  id: z.number(),
  productId: z.number(),
  productName: z.string(),
  specification: z.string(),
  notes: optionalText,
  quantity: z.number(),
  unitPriceCents: z.number(),
  unitPriceExact: z.string(),
  customerProductCode: optionalText,
  unit: optionalText,
  taxRate: optionalText,
  taxMode: optionalText,
  deliveryDate: optionalText,
});

/** 预估成本（分）和估算依据 */
const costView = z.object({
  material: z.number(),
  processing: z.number(),
  waste: z.number(),
  other: z.number(),
  basis: z.string(),
});

const orderHeadView = z.object({
  id: z.number(),
  number: z.string(),
  customerId: z.number(),
  customerName: z.string(),
  orderDate: z.string(),
  deliveryDate: z.string(),
  status: z.enum(statuses),
  notes: z.string(),
  costs: costView.nullable(),
  externalPurchaseOrder: optionalText,
  supplierName: optionalText,
  currency: z.literal('CNY').optional(),
  taxRate: optionalText,
  taxMode: optionalText,
  terms: optionalText,
  roundingPolicy: z.enum(roundingPolicies).optional(),
  version: z.number(),
  totalCents: z.number(),
  totalAmountExact: z.string().optional(),
  costCents: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const orderViewSchema = orderHeadView.extend({ lines: z.array(orderLineView) });
export type Order = z.output<typeof orderViewSchema>;

export const trackedOrderViewSchema = orderHeadView.extend({
  shippingProgress: z.enum(shippingProgresses),
  shippingSummary: z.object({ progress: z.string(), completedLines: z.number(), totalLines: z.number() }),
  materialProgress: z.enum(materialProgresses),
  lines: z.array(orderLineView.extend({
    shippedQuantity: z.number(),
    remainingQuantity: z.number(),
    shippingStatus: z.enum(shippingProgresses),
  })),
});
export type TrackedOrder = z.output<typeof trackedOrderViewSchema>;
