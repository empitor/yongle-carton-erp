// 对外接口：别的模块只能从这里引用记录页的公共小件
export { default as DatabaseDeleteDialog } from './DatabaseDeleteDialog';
export { default as DeletionImpact } from './DeletionImpact';
export { ORDER_LINES_TITLE, orderLineAmount, orderLineExtra } from './OrderLinesView';
// 客户、产品、订单这些档案清单只有这一个取数入口
export { readCatalog } from './catalog-api';
