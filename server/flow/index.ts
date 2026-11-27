// 单据流转的表的删除、初始化规则（server/core/records/deletion-rules.ts）
import './deletion.js';
export { recomputeAfterFlowDeletion } from './deletion.js';
export { archiveFlowDocuments } from './documents/archive.js';
export { ProductionCompletion } from './production/batch-completion.js';
export { WarehouseDaily } from './daily.js';
export { stockFlowRouter } from './stock-router.js';
export { registerArrival } from './arrival/register-arrival.js';
export { correctDocument, planCorrection } from './correction/correction.js';
export { PurchaseReturns } from './arrival/returns.js';
export { flowRouter } from './router.js';
export { insertSource, updateSourceDocument } from './documents/sources.js';
export { detachTasks, moveDeliveries, retainDeliveryLines } from './rules/order-edit-cascade.js';
export { orderEditGuard } from './rules/order-edit-guard.js';
export { shippedByLine } from './documents/shipped.js';
export { FlowService } from './rules/service.js';
export { arrivalHeads, documentVersions, pendingCompletionVersions, pendingDeliveryNumbersBySite, referencingDocuments, sourceFileNames } from './documents/document-lookups.js';
export { clearHistoricalDeliverySites } from './documents/document-store.js';
export { finishedStockOfProduct, stockItemBatches } from './stock/stock-batches.js';
export { updateDocumentInfo } from './correction/document-info.js';
// 财务从业务拿数据的只读窗口：财务只引这一个对象（tests/module-narrow-refs.test.ts）
export { financeFacts } from './finance-facts/facts.js';
export type { ReversalOriginal, StockMovement } from './finance-facts/facts.js';
export type { SourceHead, SourceText } from './finance-facts/facts.js';
