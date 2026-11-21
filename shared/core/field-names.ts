/**
 * 栏目登记表：业务栏目全站一个叫法，编辑窗、详情、列表列名、数据管理、修改历史、助手卡片、报错、识别结果表、
 * 导出单据都从这里取；以及哪个栏目指向哪张表。改叫法只改这里（docs/界面规范.md“栏目叫法”）。
 * 放在共用-基础：报错（user-errors.ts）、识别导入、前端财务都只能引到这一层。
 * 选项的叫法（尺寸单位、计价方式、币种、种类、状态）跟选项的值写在一起，不在这里。
 */

/** 一个栏目：叫法；窄处（列表列、明细小格）的简写；带单位的写成“单价（元）” */
type Field = { label: string; short?: string; unit?: '元' | '分' | 'm²' | '%' };

/** 栏目的基本叫法（没有记录种类、上一层时就用它，报错也用它） */
export const fields = {
  name: { label: '名称' },
  contact: { label: '联系人' },
  phone: { label: '联系方式' },
  address: { label: '地址' },
  notes: { label: '备注' },
  requirements: { label: '加工要求' },
  length: { label: '长' },
  width: { label: '宽' },
  height: { label: '高' },
  dimensionUnit: { label: '尺寸单位' },
  dimensionUnitRaw: { label: '原文尺寸单位' },
  material: { label: '材质 / 配纸' },
  flute: { label: '楞型' },
  /** 材质和楞型合在一列时，材质在前 */
  materialFlute: { label: '材质 / 楞型' },
  specification: { label: '规格' },
  priceCents: { label: '参考单价', unit: '分' },
  priceExact: { label: '参考单价', unit: '元' },
  customerId: { label: '客户' },
  supplierId: { label: '供应商' },
  productId: { label: '产品' },
  stockId: { label: '库存品' },
  stockItemId: { label: '库存品' },
  finishedStockId: { label: '入库的成品库存' },
  orderDate: { label: '下单日期' },
  deliveryDate: { label: '交货日期' },
  expectedDate: { label: '预计到货日期', short: '预计到货' },
  date: { label: '日期' },
  status: { label: '状态' },
  quantity: { label: '数量' },
  unit: { label: '数量单位' },
  unitPriceCents: { label: '单价', unit: '分' },
  unitPriceExact: { label: '单价', unit: '元' },
  unitPrice: { label: '单价', unit: '元' },
  amount: { label: '金额', unit: '元' },
  productName: { label: '产品名称' },
  lines: { label: '明细' },
  materials: { label: '领料' },
  issued: { label: '领用数量' },
  returned: { label: '退料数量' },
  goodQuantity: { label: '合格数量' },
  scrapQuantity: { label: '报废数量' },
  operator: { label: '机台操作' },
  reference: { label: '供应商送货单号' },
  priceBasis: { label: '计价方式' },
  statedArea: { label: '标注面积', unit: 'm²' },
  statedQuantity: { label: '标注张数' },
  differenceReason: { label: '差异原因' },
  kind: { label: '种类' },
  orderId: { label: '订单' },
  orderLineId: { label: '订单明细' },
  purchaseLineId: { label: '采购明细' },
  customerOrderId: { label: '关联订单' },
  orderIds: { label: '关联订单' },
  taskId: { label: '生产任务' },
  externalPurchaseOrder: { label: '客户采购单号' },
  currency: { label: '币种' },
  taxRate: { label: '税率' },
  taxMode: { label: '含税口径' },
  terms: { label: '合同条件' },
  roundingPolicy: { label: '金额结算' },
  item: { label: '纸板' },
  sourceId: { label: '送货单原件' },
  correctionOf: { label: '更正的原单' },
  allowOverdelivery: { label: '允许超订单发货' },
  overdeliveryReason: { label: '超订单原因' },
  customerProductCode: { label: '客户料号' },
  parentProductId: { label: '附属于' },
  supplierName: { label: '供应方' },
  costs: { label: '预估成本' },
  // 明细自己的编号：编辑窗不显示，报错时说是哪一行明细（不露“编号”）
  id: { label: '明细' },
  plannedDate: { label: '计划日期' },
  plannedTime: { label: '计划时间' },
  actualTime: { label: '实际时间' },
  orderBatchId: { label: '订货单' },
  acceptedQuantity: { label: '验收合格数量', short: '合格' },
  rejectedQuantity: { label: '拒收数量', short: '拒收' },
  stockedQuantity: { label: '入库数量', short: '入库' },
} as const satisfies Record<string, Field>;
export type FieldKey = keyof typeof fields;

/** 上一层下面另起的叫法（预估成本里的 material 不是材质）：按“上一层.栏目”找 */
const nested: Record<string, Field> = {
  'costs.material': { label: '材料成本', unit: '元' },
  'costs.processing': { label: '加工成本', unit: '元' },
  'costs.waste': { label: '损耗成本', unit: '元' },
  'costs.other': { label: '其他成本', unit: '元' },
  'costs.basis': { label: '估算依据' },
  // 采购明细、到货明细的纸板资料
  'item.name': { label: '纸板名称' },
  'item.notes': { label: '纸板备注' },
};

/** 记录种类（数据管理的模块名，单据按单据种类） */
const fieldRecords = [
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
type FieldRecord = (typeof fieldRecords)[number];
/** 是不是登记了叫法的记录种类（报错时按地址认出是哪种记录用） */
export const isRecordKind = (r: string | undefined): r is FieldRecord => fieldRecords.some((k) => k === r);

/** 各种记录最外层另起的叫法（和页面上的格子名一致），只登记和基本叫法不同的 */
const byRecord: Partial<Record<FieldRecord, Partial<Record<FieldKey, Field>>>> = {
  purchases: { orderDate: { label: '采购日期' } },
  arrival: { date: { label: '到货日期' }, actualTime: { label: '到货时间' } },
  task: { date: { label: '登记日期' }, plannedDate: { label: '计划生产日期' } },
  // 完工单的备注就是成品库存那一批的“批次备注”
  production: { date: { label: '完工日期' }, notes: { label: '批次备注' } },
  delivery: {
    date: { label: '送货日期' },
    actualTime: { label: '送货时间' },
    plannedDate: { label: '计划送货日期', short: '计划送货' },
    address: { label: '收货地址' },
    contact: { label: '收货联系人' },
  },
};
/** 各种记录明细一层另起的叫法 */
const byLine: Partial<Record<FieldRecord, Partial<Record<FieldKey, Field>>>> = {
  // 订单明细上可以另起的名字叫“本单名称”，和产品档案的“产品名称”分开；交期、税率按这一项说
  orders: {
    productName: { label: '本单名称' },
    deliveryDate: { label: '分项交期' },
    taxRate: { label: '本项税率' },
    taxMode: { label: '本项含税口径' },
  },
  purchases: { quantity: { label: '订货数量', short: '订货' } },
  arrival: { quantity: { label: '实到数量', short: '实到' } },
};

/** 查叫法的位置：哪种记录、上一层是什么（明细是 lines） */
export type FieldPlace = { record?: string; parent?: string };
const own = <T>(table: Partial<Record<string, T>> | undefined, key: string) =>
  table && Object.hasOwn(table, key) ? table[key] : undefined;

/** 一个栏目在这个位置的登记：先按“上一层.栏目”，再按记录种类（明细一层或最外层），最后基本叫法；没登记是 undefined */
function fieldAt(key: string, place: FieldPlace = {}): Field | undefined {
  const { record, parent = '' } = place;
  const kind = isRecordKind(record) ? record : undefined;
  return (
    own(nested, parent + '.' + key) ??
    (kind && parent === 'lines' ? own(byLine[kind], key) : undefined) ??
    (kind && !parent ? own(byRecord[kind], key) : undefined) ??
    own<Field>(fields, key)
  );
}
/** 栏目叫法（不带单位）：报错、修改历史、助手卡片用；没登记的返回 undefined，由调用方决定怎么办 */
export const fieldName = (key: string, place?: FieldPlace) => fieldAt(key, place)?.label;
/** 带单位的写法“名称（单位）”：单位写法只在这里 */
export const unitLabel = (label: string, unit?: string) => (unit ? label + '（' + unit + '）' : label);
/** 栏目标题（带单位，“单价（元）”“标注面积（m²）”）：编辑窗、数据管理、列名用 */
export function fieldTitle(key: string, place?: FieldPlace) {
  const f = fieldAt(key, place);
  return f && unitLabel(f.label, f.unit);
}
/** 窄处的简写（“合格”“拒收”“预计到货”），没有简写的用全称 */
export function fieldShort(key: FieldKey, place?: FieldPlace) {
  const f: Field = fieldAt(key, place) ?? fields[key];
  return f.short ?? f.label;
}
/** 常用的直接取：fieldLabel('material') → “材质 / 配纸” */
export const fieldLabel = (key: FieldKey, place?: FieldPlace) => fieldAt(key, place)?.label ?? fields[key].label;

/**
 * 哪个栏目指向哪张表（值是真实表名）：修改历史按它批量查名称（shared/business/history-fields.ts），
 * 数据管理按它出选择器（src/admin/field-rules.ts）。tests/field-names.test.ts 核对表名都登记过主人。
 */
export const fieldTables = {
  customerId: 'customers',
  supplierId: 'suppliers',
  productId: 'products',
  parentProductId: 'products',
  stockId: 'stock_items',
  stockItemId: 'stock_items',
  finishedStockId: 'stock_items',
  orderId: 'orders',
  customerOrderId: 'orders',
  orderIds: 'orders',
  orderLineId: 'order_lines',
  purchaseLineId: 'purchase_lines',
  taskId: 'flow_documents',
  correctionOf: 'flow_documents',
  sourceId: 'flow_sources',
  orderBatchId: 'order_batches',
} as const satisfies Partial<Record<FieldKey, string>>;
export type FieldTable = (typeof fieldTables)[keyof typeof fieldTables];
/** 这个栏目指向哪张表；不指向表的是 undefined */
export const fieldTable = (key: string): FieldTable | undefined => own<FieldTable>(fieldTables, key);
