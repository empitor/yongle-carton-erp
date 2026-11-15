import { z } from 'zod';
import { dateSchema } from '../core/index.js';
import { positiveQuantity } from '../core/index.js';

/** 退货原因最多多少字 */
const REASON_MAX_LENGTH = 500;
/** 到货单明细的行号（从 0 起）最大到几 */
const MAX_LINE_INDEX = 999;
/** 一次退货最多几行 */
const MAX_RETURN_LINES = 200;
/** 请求号（防重复提交）至少几个字 */
const REQUEST_ID_MIN_LENGTH = 8;

/**
 * 采购退货：对一张已确认的到货单，按明细退回部分或全部数量。
 * 退货扣库存、冲减采购单的已到货数量；金额以供应商到票（按退货后数量开票）或红字发票为准。
 */
export const purchaseReturnSchema = z.strictObject({
  arrivalId: z.number().int().positive(),
  date: dateSchema,
  reason: z.string().trim().min(1).max(REASON_MAX_LENGTH),
  lines: z
    .array(z.strictObject({ lineIndex: z.number().int().min(0).max(MAX_LINE_INDEX), quantity: positiveQuantity }))
    .min(1)
    .max(MAX_RETURN_LINES),
  requestId: z.string().trim().min(REQUEST_ID_MIN_LENGTH).max(100),
});
