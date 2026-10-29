import { z } from 'zod';
import { dateSchema } from './domain.js';
import { positiveQuantity, quantityText, quantityUnits, quantityString } from './operations.js';

export const arrivalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间使用HH:mm格式')
  .nullable()
  .optional();
export const inspectionFields = {
  acceptedQuantity: quantityText.nullable().optional(),
  rejectedQuantity: quantityText.nullable().optional(),
  stockedQuantity: quantityText.nullable().optional(),
};
export function arrivalQuantities(line: any) {
  const quantity = quantityUnits(line.quantity);
  const accepted =
    line.acceptedQuantity == null
      ? line.rejectedQuantity == null
        ? quantity
        : quantity - quantityUnits(line.rejectedQuantity)
      : quantityUnits(line.acceptedQuantity);
  const rejected =
    line.rejectedQuantity == null ? quantity - accepted : quantityUnits(line.rejectedQuantity);
  const stocked = line.stockedQuantity == null ? accepted : quantityUnits(line.stockedQuantity);
  if (accepted < 0 || rejected < 0 || accepted + rejected !== quantity)
    throw new Error('验收合格与不合格数量之和必须等于本批实际到货数量。');
  if (stocked < 0 || stocked > accepted) throw new Error('实际入库数量不能超过验收合格数量。');
  if (line.item?.unit === '张' && [quantity, accepted, rejected, stocked].some((q) => q % 1000))
    throw new Error('纸板到货、验收及入库均使用整张数量。');
  return {
    acceptedQuantity: quantityString(accepted),
    rejectedQuantity: quantityString(rejected),
    stockedQuantity: quantityString(stocked),
  };
}
const id = z.number().int().positive();
const items = z
  .array(z.strictObject({ lineId: id, quantity: positiveQuantity, ...inspectionFields }))
  .min(1)
  .max(100);
export const arrivalPlanInputSchema = z.strictObject({
  id: id.optional(),
  expectedVersion: id.optional(),
  purchaseId: id,
  expectedPurchaseVersion: id,
  requestId: z.string().uuid(),
  plannedDate: dateSchema,
  plannedTime: arrivalTimeSchema,
  notes: z.string().trim().max(2000).default(''),
  items: z
    .array(z.strictObject({ lineId: id, quantity: positiveQuantity }))
    .min(1)
    .max(100),
});
export const arrivalReceiveInputSchema = z.strictObject({
  purchaseId: id,
  expectedPurchaseVersion: id,
  requestId: z.string().uuid(),
  reference: z.string().trim().min(1).max(100).optional(),
  date: dateSchema,
  actualTime: arrivalTimeSchema,
  planId: id.optional(),
  expectedPlanVersion: id.optional(),
  notes: z.string().trim().max(2000).default(''),
  items,
});
// AI正式登记必须给出明确验收事实；旧HTTP/人工表单保留已披露的全部合格默认口径。
export const arrivalAiReceiveSchema = arrivalReceiveInputSchema.extend({
  items: z
    .array(
      z.strictObject({
        lineId: id,
        quantity: positiveQuantity,
        acceptedQuantity: quantityText,
        rejectedQuantity: quantityText,
        stockedQuantity: quantityText,
      }),
    )
    .min(1)
    .max(100),
});
export const arrivalQuerySchema = z.strictObject({
  date: dateSchema.optional(),
  purchaseId: id.optional(),
  supplierId: id.optional(),
  receiptId: z.string().max(150).optional(),
  includeInactive: z.boolean().default(true),
});
