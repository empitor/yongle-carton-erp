import { z } from 'zod';
import type { JsonView } from '../../shared/assistant/index';

/*
 * 会话里识别任务的导入预览和导入结果给人看的几项。任务里的 preview、result 原样是 JSON
 * （shared/assistant 的 WorkflowTaskView）；预览是导入方案（server/import/import-plan.ts 的 Plan），
 * 这里只按订单任务卡要显示的字段认，认不出就不显示预览。
 */

const text = z.string().nullish();
const size = z.number().nullish();

const previewLine = z.object({
  productName: text,
  specification: text,
  notes: text,
  quantity: z.number().nullish(),
  unit: text,
  unitPriceExact: text,
  unitPriceCents: z.number().nullish(),
});
/** 新建客户的资料 */
const customerInput = z.object({ contact: text, phone: text, address: text, notes: text });
/** 新建产品的资料：规格行（specLine）要的几项和加工要求 */
const productInput = z.object({
  specification: text,
  length: size,
  width: size,
  height: size,
  dimensionUnit: text,
  material: text,
  flute: text,
  requirements: text,
});
const existingRef = z.object({ mode: z.literal('existing'), name: z.string() });
const customerRef = z.discriminatedUnion('mode', [
  existingRef,
  z.object({ mode: z.literal('new'), name: z.string(), input: customerInput }),
]);
const productRef = z.discriminatedUnion('mode', [
  existingRef,
  z.object({ mode: z.literal('new'), name: z.string(), input: productInput }),
]);
const previewPlan = z.object({
  total: z.string().nullable(),
  customer: customerRef,
  products: z.array(productRef),
  order: z.object({
    orderDate: text,
    deliveryDate: text,
    externalPurchaseOrder: text,
    currency: text,
    taxRate: text,
    taxMode: text,
    terms: text,
    notes: text,
    lines: z.array(previewLine),
  }),
  warnings: z.array(z.string()),
});
const taskPreview = z.object({ plan: previewPlan });
/** 正式导入以后的结果：建好的订单 */
const taskResult = z.object({ orderId: z.number(), orderNumber: z.string() });

export type PreviewPlan = z.infer<typeof previewPlan>;

/** 任务的导入方案；没有预览或认不出时没有 */
export function previewPlanOf(preview: JsonView | undefined): PreviewPlan | undefined {
  const parsed = taskPreview.safeParse(preview);
  return parsed.success ? parsed.data.plan : undefined;
}

/** 任务导入成的正式订单；还没导入时没有 */
export function importedOrderOf(result: JsonView | undefined) {
  const parsed = taskResult.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}
