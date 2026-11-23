// 采购库存的表的删除、初始化规则（server/core/records/deletion-rules.ts）
import './deletion.js';
export { syncFinishedStock } from './stock/product-stock.js';
export { materialByOrder } from './ledger/material-progress.js';
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
export { stockIdsOfParty } from './ledger/party-links.js';
export { lineOrderId, purchaseOrderLinks } from './ledger/purchase-rows.js';
export { operationsRouter } from './router.js';
export { OperationsService } from './service.js';
