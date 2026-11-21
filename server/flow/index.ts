// 单据流转的表的删除、初始化规则（server/core/deletion-rules.ts）
import './deletion.js';
export { recomputeAfterFlowDeletion } from './deletion.js';
export { archiveFlowDocuments } from './archive.js';
export { ProductionCompletion } from './batch-completion.js';
export { WarehouseDaily } from './daily.js';
export { stockFlowRouter } from './stock-router.js';
export { registerArrival } from './register-arrival.js';
export { correctDocument, planCorrection } from './correction.js';
export { PurchaseReturns } from './returns.js';
export { flowRouter } from './router.js';
export { insertSource, updateSourceDocument } from './sources.js';
export { carryOverFlowDocument, replaceFlowDocument } from './maintenance-writes.js';
export { FlowService } from './service.js';
export { finishedStockOfProduct, stockItemBatches } from './stock-batches.js';
export { updateDocumentInfo } from './document-info.js';
