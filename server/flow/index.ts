// 加载单据流转模块时登记管理员改库存品、采购明细的连带处理（service.ts 末尾，接口见 server/operations/hooks.ts）
import './service.js';
// 单据流转的表的删除、初始化规则（server/core/deletion-rules.ts）
import './deletion.js';
export { recomputeAfterFlowDeletion } from './deletion.js';
export { archiveFlowDocuments } from './archive.js';
export { ProductionCompletion } from './batch-completion.js';
export { WarehouseDaily } from './daily.js';
export { receivingRouter } from './receiving.js';
export { registerArrival } from './register-arrival.js';
export { correctDocument, planCorrection } from './correction.js';
export { PurchaseReturns } from './returns.js';
export { flowRouter } from './router.js';
export { insertSource, updateSourceDocument } from './sources.js';
export { carryOverFlowDocument, replaceFlowDocument } from './maintenance-writes.js';
export { FlowService } from './service.js';
export { finishedStockOfProduct, stockItemBatches } from './stock-batches.js';
export { updateDocumentInfo } from './document-info.js';
// 财务从业务拿数据的只读窗口：财务只引这一个对象（tests/module-narrow-refs.test.ts）
export { financeFacts } from './finance-facts/facts.js';
