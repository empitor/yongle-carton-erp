import { z } from 'zod';
import { arrivalItemSchema, arrivalPriceBasisSchema } from './operations.js';
import {
  orderBatchHead,
  orderBatchTail,
  purchaseHead,
  purchaseLineViewSchema,
  stockItemHead,
  stockItemTail,
  type MovementBaseView,
} from './operations-views.js';

/*
 * 库存品、采购单、订货单、库存流水的完整视图：采购库存的基本视图（operations-views.ts）加上单据流转补的内容
 * （已安排和可用、到货记录和到货金额、按到货单现算的已到货、按订货单登记的到货单、来源单据的单号）。
 * 接口表 stock-flow-api.ts 的回答，服务端 server/flow/stock-views.ts 按这些组装。会跟着写接口的结果存进防重复记录的
 * （手工出入库、采购单状态动作、登记到货）写成 zod 结构，同一请求号重发时按结构读回来；栏目顺序和原来的回答一样。
 */

/**
 * 库存品：库里的内容加上结余、已安排（待送货、待入库的单据要用掉的）、可用（结余减已安排，只作提示，可能为负）、
 * 在途（已订货还没到齐的）；数量都有千分整数和文字两种。
 */
export const stockItemViewSchema = z.object({
  ...stockItemHead,
  reservedUnits: z.number(),
  reserved: z.string(),
  availableUnits: z.number(),
  ...stockItemTail,
});
export type StockItemView = z.output<typeof stockItemViewSchema>;

/** 单据被撤销的记录（原因、谁、什么时候、冲掉的流水）：单据内容（flow-document.ts 的 lifecycle）和下面的到货事件都按它 */
export const reversalRecordSchema = z.strictObject({
  reason: z.string(),
  by: z.string(),
  at: z.string(),
  requestId: z.string().optional(),
  movements: z.array(z.string()),
});

/** 到货单的一行按采购单读到的样子：lineId、purchaseId 是它现在挂的采购明细和采购单，验收数没写是 null，金额按单价和计价方式算 */
export const receiptLineSchema = z.strictObject({
  index: z.number(),
  lineId: z.number().nullable(),
  purchaseId: z.number().nullable(),
  stockId: z.number().nullable(),
  quantity: z.string(),
  acceptedQuantity: z.string().nullable(),
  rejectedQuantity: z.string().nullable(),
  stockedQuantity: z.string().nullable(),
  item: z.strictObject(arrivalItemSchema.shape),
  unitPrice: z.string().nullable(),
  priceBasis: arrivalPriceBasisSchema,
  amount: z.string().nullable(),
});

/**
 * 到货事件的单头（不含明细和原单内容）：一张到货单读成采购单、到货记录、到货更正能用的样子，
 * 整个到货事件（加上明细和原单）见 flow-views.ts 的 receiptEventSchema。
 * id 是“flow-编号”，correctionOf、replacedBy 也按这个写。
 */
export const receiptHeadSchema = z.strictObject({
  id: z.string(),
  flowId: z.number(),
  version: z.number(),
  reference: z.string(),
  date: z.string(),
  status: z.string(),
  effective: z.boolean(),
  supplierId: z.number(),
  actorName: z.string(),
  createdAt: z.string(),
  correctionOf: z.string().nullable(),
  replacedBy: z.string().nullable(),
  reversal: reversalRecordSchema.nullable(),
});

/**
 * 采购单的一条到货记录（一张到货单）：到货事件的单头加上原件、原因、撤销没有，
 * items 是挂在这张采购单上的行，correctionLines 是整张到货单的行（更正要用），amount 是整张的金额
 */
const purchaseReceiptSchema = receiptHeadSchema.extend({
  sourceId: z.string().nullable(),
  reason: z.string(),
  reversed: z.boolean(),
  items: z.array(receiptLineSchema),
  correctionLines: z.array(receiptLineSchema),
  amount: z.string().nullable(),
});
/** 采购单的完整样子：采购单本身（已到货按到货单现算），加上到货记录、有效到货金额（整张和每行） */
export const purchaseViewSchema = z.strictObject({
  ...purchaseHead,
  lines: z.array(purchaseLineViewSchema.extend({ receivedAmount: z.string().nullable() })),
  receivedAmount: z.string().nullable(),
  receipts: z.array(purchaseReceiptSchema),
});
export type PurchaseView = z.output<typeof purchaseViewSchema>;

/** 订货单详情：单头、到货安排、里面的采购单、合成的行、按它登记的到货单、到货进度 */
export const orderBatchViewSchema = z.object({
  ...orderBatchHead,
  arrivals: z.array(
    z.object({ id: z.number(), number: z.string(), date: z.string(), status: z.string(), reference: z.string() }),
  ),
  ...orderBatchTail,
});
export type OrderBatchView = z.output<typeof orderBatchViewSchema>;

/** 库存流水列表的一行：基本视图加上来源单据的种类和单号（不是单据来的没有） */
export type MovementView = MovementBaseView & { flowNumber?: string; flowKind?: string };
