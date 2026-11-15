// 加载财务模块时登记删除业务记录要配合的财务规则（server/core/deletion-rules.ts）
import './source-deletion.js';
// 初始化时财务清空自己的表
import './reset.js';
export { readFinanceTool } from './assistant.js';
export { financeRouter } from './router.js';
