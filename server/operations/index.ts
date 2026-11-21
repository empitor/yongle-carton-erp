// 采购库存的表的删除、初始化规则（server/core/deletion-rules.ts）
import './deletion.js';
// 产品改了，成品库存跟着改（登记点在 server/core/db.ts 的 registerProductStockSync）
import './stock/product-stock.js';
export { OrderBatchService } from './batches/batches.js';
export { readBatchSchedule } from './batches/batch-schedule.js';
export { stockLedger } from './ledger/ledger.js';
export { readStockDocument } from './ledger/stock-document.js';
export {
  batchNumbers,
  finishedIdsOfProducts,
  movementScope,
  namedVersions,
  negativeStock,
  numberedVersions,
  orderIdsOfProducts,
  stockVersions,
  suppliersOfPurchaseLines,
} from './ledger/lookups.js';
export { productIdsOfCustomer, stockIdsOfParty } from './ledger/party-links.js';
export { lineOrderId, purchaseOrderLinks } from './ledger/purchase-rows.js';
export { operationsRouter } from './router.js';
export { OperationsService } from './service.js';
