// 对外接口：别的模块只能从这里引用这个目录（到货、送货页走 records 的页面装配）
// 订货单的取数和登记到货只有这一套：仓库页、采购单详情、AI 导入的到货单都走它
export { readOrderBatch, readOrderBatches, receiveOrderBatch } from './order-batch-api';
