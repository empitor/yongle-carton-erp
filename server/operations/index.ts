// 采购库存的表的删除、初始化规则（server/core/deletion-rules.ts）
import './deletion.js';
// 产品改了，成品库存跟着改（登记点在 server/core/db.ts 的 registerProductStockSync）
import './product-stock.js';
export { OrderBatchService } from './batches.js';
export { readBatchSchedule } from './batch-schedule.js';
export { stockLedger } from './ledger.js';
export { readStockDocument } from './stock-document.js';
export { productIdsOfCustomer, stockIdsOfParty } from './party-links.js';
export { lineOrderId, purchaseOrderLinks } from './purchase-rows.js';
export { operationsRouter } from './router.js';
export { OperationsService } from './service.js';
