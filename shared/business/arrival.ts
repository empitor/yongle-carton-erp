import { RAW_UNIT, UNITS_PER_QUANTITY } from '../core/index.js';
import { z } from 'zod';
import { dateSchema } from '../core/index.js';
import { quantityText, quantityUnits, quantityString } from '../core/index.js';

export const inspectionFields = {
  acceptedQuantity: quantityText.nullable().optional(),
  rejectedQuantity: quantityText.nullable().optional(),
  stockedQuantity: quantityText.nullable().optional(),
};
/** 到货一行里验收要用的数量：实到必填，合格、拒收、入库可以没写；纸板（单位“张”）只收整张 */
type InspectedLine = {
  quantity: string;
  acceptedQuantity?: string | null;
  rejectedQuantity?: string | null;
  stockedQuantity?: string | null;
  item?: { unit?: string | null } | null;
};
/** 到货单的收货编号最多多少字 */
const RECEIPT_ID_MAX_LENGTH = 150;
export function arrivalQuantities(line: InspectedLine) {
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
    throw new Error('验收合格数量与拒收数量之和必须等于实到数量。');
  if (stocked < 0 || stocked > accepted) throw new Error('入库数量不能超过验收合格数量。');
  if (line.item?.unit === RAW_UNIT && [quantity, accepted, rejected, stocked].some((q) => q % UNITS_PER_QUANTITY))
    throw new Error('纸板到货、验收及入库均使用整张数量。');
  return {
    acceptedQuantity: quantityString(accepted),
    rejectedQuantity: quantityString(rejected),
    stockedQuantity: quantityString(stocked),
  };
}
const id = z.number().int().positive();
export const arrivalQuerySchema = z.strictObject({
  date: dateSchema.optional(),
  purchaseId: id.optional(),
  supplierId: id.optional(),
  receiptId: z.string().max(RECEIPT_ID_MAX_LENGTH).optional(),
  includeInactive: z.boolean().default(true),
});
