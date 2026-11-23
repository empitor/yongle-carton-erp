// 产品唛头资料（业务总览自己的表）的删除、初始化规则（server/core/deletion-rules.ts）
import './marks-deletion.js';
export { buildDashboard } from './dashboard.js';
export { periodOrders } from './period-records.js';
export { historyRefs } from './history-refs.js';
export { entityRecords, namedDocuments } from './module-records.js';
export type { EntityRecordOf, NamedDocument } from './module-records.js';
export { marksRouter } from './mark-router.js';
export { MarkService } from './product-marks.js';
export { auditTrail, recordContext } from './record-context.js';
export { workbenchRouter } from './workbench-router.js';
export { relatedBusiness } from './related-business.js';
