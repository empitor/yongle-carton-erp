import { z } from 'zod';
import { quantityText } from '../core/index.js';
import { flowViewSchema } from './flow-document.js';
import { productionCompletionSchema } from './production-completion.js';

/*
 * 单据流转接口回答的结构（接口表 flow-api.ts）：服务端 server/flow 按它们组装结果；写成 zod 结构的，同一请求号再交时
 * 按它核对上次存下的结果（server/core 的 onceByRequest、replayRequest）。单据视图的结构在 flow-document.ts。
 */

/** 排期（POST /flow/:id/schedule）的结果：排好的生产任务或送货单 */
export const flowScheduledSchema = z.object({
  document: z.union([flowViewSchema('task'), flowViewSchema('delivery')]),
  verified: z.boolean(),
  inventoryChanged: z.literal(false),
});

/** 一种领料：库存品、领料、退料（数量文字） */
const materialLine = z.strictObject({ stockId: z.number(), issued: z.string(), returned: z.string() });
/** 登记出的一张完工单 */
const registeredRow = z.strictObject({
  taskId: z.number().nullable(),
  productId: z.number(),
  productionId: z.number(),
  number: z.string(),
  finishedStockId: z.number(),
  goodQuantity: z.string(),
  scrapQuantity: z.string(),
  materials: z.array(materialLine),
  verified: z.literal(true),
});
/** 登记完工（POST /flow/production-completion/execute，助手也走同一个服务）的结果 */
export const completionResultSchema = z.strictObject({
  count: z.number(),
  results: z.array(registeredRow),
  materials: z.array(materialLine),
  allocation: productionCompletionSchema.shape.allocation,
  allocationBasis: z.string(),
  verified: z.literal(true),
  pending: z.boolean(),
  inventoryChanged: z.boolean(),
  message: z.string(),
});
type CompletionResult = z.output<typeof completionResultSchema>;
/** 登记完工的核验（POST /flow/production-completion/preview）：按同一份方案预演，不出完工单号；带预览摘要，登记时带回来 */
export type CompletionPreview = Omit<CompletionResult, 'results' | 'verified' | 'inventoryChanged'> & {
  results: Omit<CompletionResult['results'][number], 'productionId' | 'number' | 'finishedStockId'>[];
  verified: false;
  inventoryChanged: false;
  previewDigest: string;
};

/** 采购退货单（purchase_returns.status）能存的全部状态，和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const purchaseReturnStatuses = ['confirmed', 'reversed'] as const;
const id = z.number().int().positive();
const returnLine = z.strictObject({
  /** 到货单的第几行（从 0 数） */
  lineIndex: z.number().int().nonnegative(),
  /** 退的库存品；库存品删了清成 null */
  stockId: id.nullable(),
  name: z.string(),
  unit: z.string(),
  /** 退货时这一行挂的采购明细；明细删了、解除了清成 null */
  purchaseLineId: id.nullable(),
  quantity: quantityText,
});
/**
 * 退货单内容（purchase_returns.document）：退货的请求号、原因、原到货单号、供应商、退了哪几行，撤销后加撤销记录。
 * 服务端读和写都按这一份结构（strictObject：多出的键算对不上，见 server/flow/return-document.ts）。
 */
export const purchaseReturnDocumentSchema = z.strictObject({
  requestId: z.string(),
  reason: z.string(),
  arrivalNumber: z.string(),
  supplierId: id,
  supplierName: z.string(),
  lines: z.array(returnLine),
  reversal: z.strictObject({ reason: z.string(), by: z.string(), at: z.string() }).optional(),
});
/** 接口、助手看到的退货单：行上的列加上内容 */
export const purchaseReturnViewSchema = purchaseReturnDocumentSchema.extend({
  id,
  number: z.string(),
  arrivalId: id,
  date: z.string(),
  status: z.enum(purchaseReturnStatuses),
  version: z.number(),
  actorName: z.string(),
  createdAt: z.string(),
});

/** 到货单每行还能退多少（GET /flow/returns/returnable/:id）：入库、已退、还能退（数量文字）；hint 有字的这一行不能退 */
export type ReturnableLine = {
  lineIndex: number;
  stockId: number | null;
  name: string;
  unit: string;
  purchaseLineId: number | null;
  stocked: string | null;
  returned: string;
  returnable: string;
  hint: string;
};
