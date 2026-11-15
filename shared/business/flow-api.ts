import type { z } from 'zod';
import type { ArchiveResult, Empty, recordArchiveInputSchema } from '../core/index.js';
import type {
  arrivalCorrectionPreviewSchema,
  correctionCommit,
  deliveryCorrectionPreviewSchema,
  productionCorrectionPreviewSchema,
} from './flow-correction.js';
import type {
  arrivalCorrectionExtraSchema,
  arrivalCorrectionViewSchema,
  correctionResultSchema,
  deliveryCorrectionExtraSchema,
  deliveryCorrectionViewSchema,
  productionCorrectionExtraSchema,
  productionCorrectionViewSchema,
} from './flow-correction-views.js';
import type { FlowDocView } from './flow-document.js';
import type {
  arrivalRecordsQuerySchema,
  completionExecuteSchema,
  dailyQuerySchema,
  documentInfoSchema,
  flowConfirmSchema,
  flowDeliveredSchema,
  flowListQuerySchema,
  flowSaveRequestSchema,
  flowUndoActions,
  flowUndoSchema,
  returnReversalSchema,
  returnsQuerySchema,
  stockBatchesQuerySchema,
} from './flow-requests.js';
import type { CompletionPreview, ReturnableLine, completionResultSchema, flowScheduledSchema, purchaseReturnViewSchema } from './flow-results.js';
import type { ArrivalRecord, FlowPreview, WarehouseDailyResult } from './flow-views.js';
import type { OrderBatchView } from './operations-views.js';
import type { batchReceiveSchema } from './order-batch.js';
import type { arrivalSchema, deliverySchema, flowScheduleSchema, FlowKind, productionSchema, taskSchema } from './physical-flow.js';
import type { productionCompletionSchema } from './production-completion.js';
import type { purchaseReturnSchema } from './purchase-return.js';
import type { StockBatchesResponse } from './stock-batches.js';

/*
 * 单据流转的接口表（服务端 server/flow/router.ts 挂在 /api/flow 下，登记到货 server/flow/receiving.ts 挂在 /api 下）。
 * 表的写法见 shared/core/api-table.ts。查询参数和正文照服务端的 zod 规则的输入写（flow-requests.ts 等），服务端照样先校验。
 * 不在表里、照旧用 express 注册的一条：看送货单原件（GET /flow/sources/:sourceId/file）回的是文件。
 * 登记到货结果里的订货单详情是采购库存的视图（operations-views.ts 的 OrderBatchView）。
 */

type ReturnView = z.output<typeof purchaseReturnViewSchema>;
/** 一种单据的保存：单据内容（各自的录入规则）加上请求号和打开时的版本 */
type SaveBody<S extends z.ZodType> = z.input<S> & z.input<typeof flowSaveRequestSchema>;
/** 新建：到货、生产任务、送货（完工只走登记完工） */
type NewFlowBody = SaveBody<typeof arrivalSchema> | SaveBody<typeof taskSchema> | SaveBody<typeof deliverySchema>;
/** 修改还没核对的单据：多一种待入库的完工单 */
type FlowBody = NewFlowBody | SaveBody<typeof productionSchema>;
/** 更正的预览输入：按原单的种类（到货、送货、完工）各一种 */
type CorrectionPreviewBody =
  | z.input<typeof arrivalCorrectionPreviewSchema>
  | z.input<typeof deliveryCorrectionPreviewSchema>
  | z.input<typeof productionCorrectionPreviewSchema>;
/** 提交更正：预览输入加上请求号和预览摘要（correctionCommit） */
type CommitBody<S extends z.ZodRawShape> = z.input<ReturnType<typeof correctionCommit<S>>>;
type CorrectionCommitBody =
  | CommitBody<(typeof arrivalCorrectionPreviewSchema)['shape']>
  | CommitBody<(typeof deliveryCorrectionPreviewSchema)['shape']>
  | CommitBody<(typeof productionCorrectionPreviewSchema)['shape']>;
/** 更正的预览：按原单的种类各一种（flow-correction-views.ts） */
type CorrectionPreview =
  | z.output<typeof arrivalCorrectionViewSchema>
  | z.output<typeof deliveryCorrectionViewSchema>
  | z.output<typeof productionCorrectionViewSchema>;
/** 一种单据提交更正的结果：每种都有的部分加上这种单据多带的 extra（correctionResultSchema） */
type ResultOf<K extends Exclude<FlowKind, 'task'>, E extends z.ZodType<object>> = z.output<ReturnType<typeof correctionResultSchema<K, z.output<E>>>>;
/** 提交更正的结果：按原单的种类各一种（flow-correction-views.ts） */
type CorrectionResult =
  | ResultOf<'arrival', typeof arrivalCorrectionExtraSchema>
  | ResultOf<'delivery', typeof deliveryCorrectionExtraSchema>
  | ResultOf<'production', typeof productionCorrectionExtraSchema>;

/** 取消（还没核对的作废）、撤销（已核对的撤回）：各一个地址，同一份输入 */
type UndoActions = {
  [A in (typeof flowUndoActions)[number] as `POST /flow/:id/${A}`]: { body: z.input<typeof flowUndoSchema>; response: FlowDocView };
};

/** 采购退货：挂在到货单下 */
type ReturnsApi = {
  'GET /flow/returns': { query?: z.input<typeof returnsQuerySchema>; response: ReturnView[] };
  'GET /flow/returns/returnable/:id': { response: ReturnableLine[] };
  'POST /flow/returns': { body: z.input<typeof purchaseReturnSchema>; response: ReturnView };
  'POST /flow/returns/:id/reverse': { body: z.input<typeof returnReversalSchema>; response: ReturnView };
};

/** 只看的：单据列表、成品批次、到货记录、仓库台账、单张单据 */
type ReadApi = {
  'GET /flow': { query?: z.input<typeof flowListQuerySchema>; response: FlowDocView[] };
  'GET /flow/stock-batches/:id': { query?: z.input<typeof stockBatchesQuerySchema>; response: StockBatchesResponse };
  'GET /flow/arrival-records': { query?: z.input<typeof arrivalRecordsQuerySchema>; response: ArrivalRecord[] };
  'GET /flow/daily': { query: z.input<typeof dailyQuerySchema>; response: WarehouseDailyResult };
  'GET /flow/:id': { response: FlowDocView };
};

/** 办一张单据：更正（预览、提交）、核对、排期、编辑说明、确认、送达 */
type DocumentApi = {
  'POST /flow/:id/correction-preview': { body: CorrectionPreviewBody; response: CorrectionPreview };
  'POST /flow/:id/correct': { body: CorrectionCommitBody; response: CorrectionResult };
  'POST /flow/:id/preview': { body: Empty; response: FlowPreview };
  'POST /flow/:id/schedule': { body: z.input<typeof flowScheduleSchema>; response: z.output<typeof flowScheduledSchema> };
  'POST /flow/:id/info': { body: z.input<typeof documentInfoSchema>; response: FlowDocView & { changed: boolean } };
  'POST /flow/:id/confirm': { body: z.input<typeof flowConfirmSchema>; response: FlowDocView };
  'POST /flow/:id/delivered': { body: z.input<typeof flowDeliveredSchema>; response: FlowDocView<'delivery'> };
};

export type FlowApi = UndoActions &
  ReturnsApi &
  ReadApi &
  DocumentApi & {
    'POST /flow/production-completion/preview': { body: z.input<typeof productionCompletionSchema>; response: CompletionPreview };
    'POST /flow/production-completion/execute': {
      body: z.input<typeof completionExecuteSchema>;
      response: z.output<typeof completionResultSchema>;
    };
    'POST /flow/batch': { body: z.input<typeof recordArchiveInputSchema>; response: ArchiveResult<number> };
    'POST /flow/:kind': { body: NewFlowBody; response: FlowDocView };
    'PUT /flow/:id': { body: FlowBody; response: FlowDocView };
    /** 登记到货（挂在订货单下面） */
    'POST /order-batches/:id/receive': {
      body: z.input<typeof batchReceiveSchema>;
      response: { arrival: FlowDocView<'arrival'>; batch: OrderBatchView; verified: true; summary: string };
    };
  };
