import { z } from 'zod';
import type { arrivalLineStatus } from '../core/index.js';
import { flowContentSchema, flowViewSchema } from './flow-document.js';
import { receiptEventSchema, receiptLineSchema } from './flow-views.js';
import { arrivalProgresses, purchaseBusinessStatuses } from './operations.js';
import { purchaseViewSchema, stockItemViewSchema } from './operations-views.js';
import { arrivalLineSchema, type FlowKind } from './physical-flow.js';

/*
 * 更正到货单、送货单、完工单的预览（server/flow/correction.ts 的 planCorrection，POST /flow/:id/correction-preview）：
 * 更正后库存、采购或订单、生产任务各会变成多少。服务端方案的预览类型由这里推出（只有这一份定义）；
 * 助手的更正卡片按这里的结构读预览。提交更正的结果（correctDocument，POST /flow/:id/correct）也在这里，
 * 送货、完工多带的订单、任务影响取预览的同一份。输入在 flow-correction.ts。
 */

/** 能更正的单据：到货、送货、完工（生产任务不进更正） */
type Correctable = Exclude<FlowKind, 'task'>;

/** 更正前后的文字（日期、合格数、报废数） */
const change = z.strictObject({ before: z.string(), after: z.string() });
/** 一行更正前后的数量文字：新加的行更正前是 null，删掉的原单行更正后是 0 */
const lineChange = z.strictObject({ before: z.string().nullable(), after: z.string() });

/**
 * 每个库存品更正前后：before、after 是数量文字（到货新加的行还没有库存品时是 null，只说会入多少），
 * deltaUnits 是千分整数的净变化，delta 是带正负号的文字；version 是核对时库存品的版本
 */
export const stockImpactSchema = z.strictObject({
  stockId: z.number().nullable(),
  name: z.string(),
  unit: z.string(),
  version: z.number().optional(),
  deltaUnits: z.number(),
  delta: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

/** 每种更正的预览都有的：原单编号、种类、单号，每个库存品前后、提示、预览摘要（提交时带回，核对影响没变） */
const previewHead = <K extends Correctable>(kind: K) => ({
  id: z.number(),
  kind: z.literal(kind),
  number: z.string(),
  stockImpact: z.array(stockImpactSchema),
  warnings: z.array(z.string()),
  previewDigest: z.string(),
});
/** 预览里这种单据自己的内容（服务端方案的 view）：去掉每种都有的那几项 */
export type CorrectionDetail<V> = Omit<V, keyof ReturnType<typeof previewHead>>;

/** 采购明细的到货情况：取值和 shared/core 的 arrivalLineStatus 一样（少写、多写了，服务端拼预览的地方就编译不过） */
const arrivalLineStatuses = ['未到货', '部分到货', '已到齐'] as const satisfies readonly ReturnType<typeof arrivalLineStatus>[];
/** 到货：采购明细更正前后（预览和提交结果的说法里用）：订购、已到货前后、剩余、到货情况 */
const purchaseLineImpact = z.strictObject({
  name: z.string(),
  unit: z.string(),
  arrivalStatus: z.enum(arrivalLineStatuses),
  lineId: z.number(),
  ordered: z.string(),
  before: z.string(),
  after: z.string(),
  remaining: z.string(),
});
/** 到货：每张采购单更正后的每条明细和到货进度；version 是核对时采购单的版本（算进预览摘要） */
const purchaseImpact = z.strictObject({
  id: z.number(),
  number: z.string(),
  version: z.number(),
  businessStatus: z.enum(purchaseBusinessStatuses),
  lines: z.array(purchaseLineImpact),
  arrivalProgress: z.enum(arrivalProgresses),
});
/** 到货预览里替代单的一行：和到货记录的行同一个样子，只是验收数、金额照替代单内容（没写就没有） */
const arrivalLine = receiptLineSchema.extend({
  acceptedQuantity: arrivalLineSchema.shape.acceptedQuantity,
  rejectedQuantity: arrivalLineSchema.shape.rejectedQuantity,
  stockedQuantity: arrivalLineSchema.shape.stockedQuantity,
  amount: flowContentSchema('arrival').shape.lines.element.shape.amount,
});
/** 更正到货单的预览：原到货单编号和到货记录编号、原单的到货事件、替代单逐行、每张采购单前后、到货金额前后（缺单价算不出时是 null） */
export const arrivalCorrectionViewSchema = z.strictObject({
  ...previewHead('arrival'),
  arrivalId: z.number(),
  receiptId: z.string(),
  original: receiptEventSchema,
  lines: z.array(arrivalLine),
  purchaseImpact: z.array(purchaseImpact),
  beforeAmount: z.string().nullable(),
  afterAmount: z.string().nullable(),
});

/** 送货：每条订单明细的已发前后和订购数；单位跟订单明细（没写就没有） */
const orderImpact = z.strictObject({
  orderId: z.number(),
  orderNumber: z.string(),
  orderLineId: z.number(),
  productName: z.string(),
  unit: z.string().optional(),
  ordered: z.string(),
  before: z.string(),
  after: z.string(),
});
/** 送货预览的一行：原单第几行（新加的是 null）、挂的订单明细、数量前后、单价（换挂、新加的行是订单现价）、金额 */
const deliveryLine = z.strictObject({
  index: z.number().nullable(),
  orderId: z.number(),
  orderNumber: z.string().optional(),
  orderLineId: z.number(),
  productName: z.string().optional(),
  unit: z.string().optional(),
  ...lineChange.shape,
  unitPrice: z.string().nullable(),
  amount: z.string().nullable(),
});
/** 更正送货单的预览：原单视图、客户、出库日期前后、逐行前后、订单已发前后、送货金额前后（缺单价算不出时是 null） */
export const deliveryCorrectionViewSchema = z.strictObject({
  ...previewHead('delivery'),
  original: flowViewSchema('delivery'),
  customerName: z.string(),
  date: change,
  lines: z.array(deliveryLine),
  orderImpact: z.array(orderImpact),
  beforeAmount: z.string().nullable(),
  afterAmount: z.string().nullable(),
});

/** 完工：生产任务的已入库前后和计划数 */
const taskImpact = z.strictObject({
  id: z.number(),
  number: z.string(),
  unit: z.string(),
  planned: z.string(),
  before: z.string(),
  after: z.string(),
});
/** 完工预览的一种纸板：原单第几行（新加的是 null）、哪个库存品、领用和退料前后 */
const materialLine = z.strictObject({
  index: z.number().nullable(),
  stockId: z.number(),
  name: z.string(),
  unit: z.string(),
  issued: lineChange,
  returned: lineChange,
});
const productRef = z.strictObject({ id: z.number(), name: z.string() });
/** 更正完工单的预览：原单视图、成品单位、完工日期和产品前后、合格报废前后、每种纸板领退料前后、生产任务已入库前后 */
export const productionCorrectionViewSchema = z.strictObject({
  ...previewHead('production'),
  original: flowViewSchema('production'),
  unit: z.string(),
  date: change,
  product: z.strictObject({ before: productRef, after: productRef }),
  good: change,
  scrap: change,
  materials: z.array(materialLine),
  taskImpact: z.array(taskImpact),
});

/** 每种提交更正的结果都有的：原单和替代单的编号、单号，请求号，每个库存品前后，替代单和冲回的流水编号，读回核验，一句话说明 */
const resultHead = <K extends Correctable>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    originalId: z.number(),
    originalNumber: z.string(),
    replacementId: z.number(),
    replacementNumber: z.string(),
    requestId: z.string(),
    stockImpact: z.array(stockImpactSchema),
    movements: z.object({ replacement: z.array(z.string()), reversal: z.array(z.string()) }),
    verified: z.boolean(),
    summary: z.string(),
  });
/**
 * 提交更正的结果：每种都有的部分加上这种单据多带的 extra（下面三份）。服务端按它组装，同一请求号重发时按它读回上次的结果。
 * 外层不用严格结构：两部分合起来核对，各自不认对方的键
 */
export function correctionResultSchema<K extends Correctable, R extends object>(kind: K, extra: z.ZodType<R>) {
  return resultHead(kind).and(extra);
}

/**
 * 提交结果里到货多带的：原到货记录和替代单的记录键、编号，到货金额前后（缺单价算不出时是 null），
 * 更正后读回的采购单、库存品（采购库存的完整视图，operations-views.ts），每行原登记和更正后的数量
 */
export const arrivalCorrectionExtraSchema = z.object({
  originalReceiptId: z.string(),
  replacementReceiptId: z.string(),
  replacementFlowId: z.number(),
  beforeAmount: z.string().nullable(),
  afterAmount: z.string().nullable(),
  purchases: z.array(purchaseViewSchema),
  stock: z.array(stockItemViewSchema),
  corrections: z.array(
    z.object({
      name: z.string(),
      unit: z.string(),
      originalQuantity: z.string(),
      correctedQuantity: z.string(),
      purchaseId: z.number().nullable(),
      lineId: z.number().nullable(),
    }),
  ),
});
/** 提交结果里送货多带的：每条订单明细的已发前后、送货金额前后，和预览同一份 */
export const deliveryCorrectionExtraSchema = z.object(deliveryCorrectionViewSchema.pick({ orderImpact: true, beforeAmount: true, afterAmount: true }).shape);
/** 提交结果里完工多带的：生产任务的已入库前后，和预览同一份 */
export const productionCorrectionExtraSchema = z.object(productionCorrectionViewSchema.pick({ taskImpact: true }).shape);
