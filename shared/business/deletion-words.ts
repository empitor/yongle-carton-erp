/**
 * 删除清单和删除确认里各种记录的叫法，只写这一份：表和解除的字段叫什么、量词、单据怎么叫、库存品和流水怎么叫，
 * 以及“库存怎么处理”的选项。服务器写“库存怎么变”的说明（deletion-summary.ts）、页面删除窗口和助手核对区的
 * 影响清单（src/recordkit/deletion-impact.ts）都从这里取，前端不再自己维护一张。
 * 每行记录的名字由表的主人登记（各模块的 deletion.ts）。
 */
import { flowNames, isFlowKind } from './physical-flow.js';

/** 删的是单据（到货、生产任务、完工、送货）；别的是档案（客户、供应商、产品、订单、采购单、库存品） */
const documentModules = ['arrival', 'task', 'production', 'delivery'];
export const deletesDocuments = (module: string) => documentModules.includes(module);

/** 选“库存数量不动”时删的是什么：删单据说“只删单子”，删档案（连带删掉单据）说“只删记录” */
export const keepStockScope = (module: string) =>
  deletesDocuments(module) ? '只删单子' : '只删记录';

/**
 * “库存怎么处理”两个选项的文字：删单据时说“这张单子”，删会连带删单据的档案时说“连带删掉的单据”“只删记录”。
 */
export function inventoryOptions(module: string) {
  return {
    recalculate: deletesDocuments(module)
      ? '库存一起改回（当这张单子没发生过）'
      : '库存一起改回（当连带删掉的单据没发生过）',
    preserve: '库存数量不动，' + keepStockScope(module),
  };
}

/** 一组流水里入库、出库各几笔 */
export type Directions = { in: number; out: number };
/** 流水的叫法：全是入库“入库流水”，全是出库“出库流水”，两种都有“出入库流水” */
export const movementWord = (d: Directions) =>
  d.in && !d.out ? '入库流水' : d.out && !d.in ? '出库流水' : '出入库流水';

/** 库存品的叫法：成品的叫“成品库存”，原材料的叫“原材料库存”，混着的、说不出的叫“库存品” */
export const stockWord = (kinds: readonly string[]) =>
  kinds.length && kinds.every((k) => k === 'finished')
    ? '成品库存'
    : kinds.length && kinds.every((k) => k === 'raw')
      ? '原材料库存'
      : '库存品';

/** 表的叫法；业务单据按单据类型叫，见 deletionTableLabel */
const tableLabels: Record<string, string> = {
  customers: '客户',
  products: '产品',
  orders: '订单',
  order_lines: '订单明细',
  suppliers: '供应商',
  purchases: '采购单',
  purchase_lines: '采购明细',
  stock_items: '库存品',
  stock_movements: '流水',
  flow_documents: '业务单据',
  flow_refs: '单据关联',
  flow_receipt_keys: '收货编号关联',
  flow_file_uses: '原件关联',
  import_executions: '导入记录',
  // 订货批次界面上叫“订货单”（导出订货单、订货单 DG-…）
  order_batches: '订货单',
  order_batch_purchases: '订货单里的采购单',
  product_marks: '唛头',
  mark_files: '唛头原文件',
  purchase_returns: '采购退货',
};

/** 一行是什么：业务单据按单据类型叫（到货单、送货单……），库存品按仓库叫，没登记的表不露英文表名 */
export function deletionTableLabel(r: { table: string; kind?: string }) {
  if (r.table === 'flow_documents' && r.kind && isFlowKind(r.kind)) return flowNames[r.kind];
  // 删产品时连带的成品库存叫“成品库存”，看得出就是这个产品的库存，不和“产品”同名并列
  if (r.table === 'stock_items' && (r.kind === 'finished' || r.kind === 'raw')) return stockWord([r.kind]);
  return tableLabels[r.table] || '关联记录';
}

/** 解除关联的字段叫什么：每个会被解除的字段都要登记（测试按删除预览逐条查） */
export const deletionFieldLabels: Record<string, string> = {
  customer_order_id: '客户订单',
  purchase_line_id: '采购明细',
  purchase_id: '采购单',
  stock_id: '库存品',
  stock_item_id: '库存品',
  product_id: '产品',
  order_id: '订单',
  // 库存流水的来源（哪张单据）：类型和编号一起解除，只说一遍“来源单据”
  source_id: '来源单据',
  source_kind: '来源单据',
  task_id: '生产任务',
  // 单据内容里记的引用。说得出是哪种的（订单、库存品、采购明细……）按上面的叫法，说不出的才用这句
  document: '单据内容里的引用',
  movements: '出入库流水',
  parent_product_id: '附属于',
  order_batch_id: '订货单',
  // 订货单保留、去掉其中一张采购单时，到货安排里只属于它的行一起去掉
  schedule: '到货安排',
  correction_of: '更正的原单',
  replaced_by: '替代它的单据',
  customer_id: '客户',
  supplier_id: '供应商',
};

// 量词：“1 张采购单”“1 条采购明细”“2 笔入库流水”，没登记的按“张”
const measures: Record<string, string> = {
  customers: '家',
  suppliers: '家',
  products: '个',
  stock_items: '个',
  order_lines: '条',
  purchase_lines: '条',
  stock_movements: '笔',
  product_marks: '个',
  mark_files: '份',
  purchase_returns: '笔',
  import_executions: '条',
};
export const deletionMeasure = (table: string) => measures[table] || '张';
