import { z } from 'zod';
import { recordNames } from './labels.js';
export const dataManagementModules = [
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'stock_items',
  'arrival',
  'task',
  'production',
  'delivery',
] as const;
/**
 * 数据管理里不能新建的模块和原因：完工单只能经“登记完工”产生（一个入口，挂不挂任务都在那里），这里只能改、核对、撤销。
 * 服务端 server/admin/data-management-service.ts 拒收，界面 src/admin/DataManagementEditor.tsx 不显示“新建”。
 */
export const dataManagementNoCreate: Partial<Record<(typeof dataManagementModules)[number], string>> = {
  production: '登记完工请到生产页用“登记完工”。',
};
/** 模块名：和界面同一套叫法（shared/business/labels.ts） */
export const dataManagementNames: Record<string, string> = {
  ...recordNames,
  workspaces: 'AI识别工作区',
};
/**
 * 数据管理命令：改、归档、恢复、单据的确认、取消、撤销，新建。删除不在这里：页面和助手都走删除引擎
 * （POST /deletions/execute，助手 records.delete），影响范围、恢复快照、库存怎么处理都在那边。
 */
export const dataManagementCommandSchema = z.strictObject({
  requestId: z.uuid(),
  module: z.enum(dataManagementModules),
  action: z.enum(['create', 'update', 'archive', 'restore', 'confirm', 'cancel', 'reverse']),
  items: z
    .array(
      z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() }),
    )
    .max(100)
    .default([]),
  patch: z.record(z.string(), z.unknown()).default({}),
  patches: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  reason: z.string().trim().min(1).max(1000),
});
const dataManagementFieldNames: Record<string, string> = {
  // 叫法和各编辑窗、详情一致（界面规范的词表）；关联的客户、产品这些在编辑窗里是选择器，显示名称不显示编号，
  // 金额按元填（存的还是分，换算见 src/admin/DataManagementEditor.tsx 的 editableInput、submittedInput）
  name: '名称',
  contact: '联系人',
  phone: '电话',
  address: '地址',
  notes: '备注',
  requirements: '加工要求',
  length: '长',
  width: '宽',
  height: '高',
  dimensionUnit: '尺寸单位',
  material: '材质 / 配纸',
  flute: '楞型',
  // 产品的参考单价只填一个“元”（四位小数以内），“分”由它算出来，编辑窗里不单独显示
  priceCents: '参考单价（分）',
  priceExact: '参考单价（元）',
  customerId: '客户',
  supplierId: '供应商',
  productId: '产品',
  stockId: '库存品',
  stockItemId: '库存品',
  finishedStockId: '入库的成品库存',
  orderDate: '订单日期',
  deliveryDate: '交货日期',
  expectedDate: '预计到货日期',
  date: '业务日期',
  status: '状态',
  quantity: '数量',
  unit: '数量单位',
  // 订单明细的单价同样只填“元”，“分”由它算出来
  unitPriceCents: '单价（分）',
  unitPriceExact: '单价（元）',
  unitPrice: '单价（元）',
  specification: '规格说明',
  productName: '产品名称',
  lines: '明细',
  materials: '领料',
  issued: '领用数量',
  returned: '退料数量',
  goodQuantity: '合格数量',
  scrapQuantity: '报废数量',
  operator: '机台操作',
  reference: '供应商送货单号',
  priceBasis: '计价方式',
  statedArea: '标注面积（平方米）',
  statedQuantity: '标注张数',
  differenceReason: '差异原因',
  kind: '种类',
  orderId: '订单',
  orderLineId: '订单明细',
  purchaseLineId: '采购明细',
  customerOrderId: '关联订单',
  taskId: '生产任务',
  orderIds: '关联订单',
  externalPurchaseOrder: '客户采购单号',
  currency: '币种',
  taxRate: '税率',
  taxMode: '含税口径',
  terms: '合同条件',
  roundingPolicy: '金额结算',
  item: '纸板',
  sourceId: '送货单原件',
  correctionOf: '更正的原单',
  allowOverdelivery: '允许超订单发货',
  overdeliveryReason: '超订单原因',
  customerProductCode: '客户料号',
  parentProductId: '附属于',
  dimensionUnitRaw: '原文尺寸单位',
  supplierName: '供应方名称',
  costs: '预估成本',
  // 预估成本里的几项：和档案的“材质”同名，按“上一层.字段”另起名字；库里存分，编辑窗按元填
  'costs.material': '材料成本（元）',
  'costs.processing': '加工成本（元）',
  'costs.waste': '损耗成本（元）',
  'costs.other': '其他成本（元）',
  'costs.basis': '估算依据',
  id: '明细',
  plannedDate: '计划日期',
  plannedTime: '计划时间',
  actualTime: '实际时间',
  orderBatchId: '订货单',
  acceptedQuantity: '验收合格数量',
  rejectedQuantity: '拒收数量',
  stockedQuantity: '入库数量',
};
/**
 * 同一个字段在个别模块里和详情另有叫法（以详情为准，数据管理编辑窗和修改历史跟着用）：
 * 采购单的日期在采购单详情里叫“采购日期”；完工单的备注就是成品库存那一批的“批次备注”（src/flow/FlowDetails.tsx）。
 * 只管单据最外层的字段，明细里的同名字段照旧。
 */
const dataManagementModuleFieldNames: Record<string, Record<string, string>> = {
  purchases: { orderDate: '采购日期' },
  production: { notes: '批次备注' },
};
/**
 * 编辑窗里字段的中文名：先按“上一层.字段”找（预估成本里的 material 不是材质），再按模块找（最外层字段，见上），
 * 最后按字段找。没登记的字段原样显示字段代码（tests/data-management.test.ts 守着每个可编辑字段都有中文名）。
 */
export function dataManagementFieldName(key: string, parent = '', module = '') {
  return (
    dataManagementFieldNames[parent + '.' + key] ||
    (!parent && dataManagementModuleFieldNames[module]?.[key]) ||
    dataManagementFieldNames[key] ||
    key
  );
}
