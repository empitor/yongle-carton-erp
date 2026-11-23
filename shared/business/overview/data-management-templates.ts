import { FINISHED_UNIT, RAW_UNIT } from '../../core/index.js';
import type { dataManagementModules } from '../lifecycle/data-management-modules.js';

/*
 * 数据管理“新建”时每个模块的空白模板（服务端数据管理列表、助手 records.search 的 describe 都给它）。
 * 客户、产品、供应商、库存品、订单这些编号一律留空（null）让人选，不拿 0 冒充真值；漏填时提示“请选择客户”这类话。
 */
type DataManagementModule = (typeof dataManagementModules)[number];

const contactTemplate = () => ({ contact: '', phone: '', address: '' });
const customerTemplate = () => ({ name: '', ...contactTemplate(), notes: '' });
const supplierTemplate = () => ({ name: '', ...contactTemplate(), notes: '' });
const productTemplate = () => ({
  name: '',
  length: null,
  width: null,
  height: null,
  dimensionUnit: null,
  material: '',
  flute: '',
  requirements: '',
  // 分是 0 就是没定价（不是 0 元）；精确价格留空让人填，填了就按它定价
  priceCents: 0,
  priceExact: '',
  customerProductCode: '',
  // 所属客户：留空是通用产品，所有客户订单都能选
  customerId: null,
  // 附属于哪个产品：默认不关联
  parentProductId: null,
});
// 采购明细、到货明细的纸板资料：库存品那几格去掉“种类”“产品”（纸板就是原材料，录入结构不收这两格，放进来会被悄悄丢掉）
const sheetTemplate = () => ({
  name: '',
  unit: RAW_UNIT,
  specification: '',
  length: null,
  width: null,
  height: null,
  dimensionUnit: null,
  material: '',
  flute: '',
  notes: '',
});
const stockTemplate = () => {
  const { name, ...sheet } = sheetTemplate();
  return { name, kind: 'raw', ...sheet, productId: null };
};
const orderLineTemplate = () => ({
  productId: null,
  // 本单名称不放进模板（原因写在 tests/data-management-template-fields.test.ts 的 notInTemplate）
  specification: '',
  notes: '',
  // 数量、单价留空让人填（漏填时校验报“请填写有效数量”“请填写单价”），不拿 1 和 0 冒充真值，和订单编辑窗一致
  quantity: null,
  unit: FINISHED_UNIT,
  unitPriceCents: null,
  // 精确单价留空：只填“单价（分）”时按分存。预填成 0 的话精确价优先，填的分会被 0 盖掉
  unitPriceExact: '',
  customerProductCode: '',
  // 本项税率、含税口径空着就跟整单走；分项交期空着就是整单的交货日期
  taxRate: '',
  taxMode: '',
  deliveryDate: null,
});
// 采购、到货、生产、送货的数量同样留空（null）让人填，不预填 1；报废、退料没有就是 0，照旧预填 0
const quantity = null;

const orderTemplate = (today: string) => ({
  customerId: null,
  orderDate: today,
  // 交货日期不猜，留空让人填（订单编辑窗也是空的）
  deliveryDate: null,
  status: '待确认',
  notes: '',
  lines: [orderLineTemplate()],
  costs: null,
  currency: 'CNY',
  externalPurchaseOrder: '',
  // 金额结算和订单页编辑窗一样先是“精确到分，不自动舍入”；单价有不足一分的尾数时人在这一格改选
  roundingPolicy: 'exact-cents',
  supplierName: '',
  taxRate: '',
  // 含税口径和订单页编辑窗新单一样先是“未明确”（不默认含税）
  taxMode: '未明确',
  terms: '',
});
const purchaseTemplate = (today: string) => ({
  supplierId: null,
  customerOrderId: null,
  orderDate: today,
  expectedDate: null,
  status: '待订货',
  notes: '',
  // 这一行给哪张订单订的料：默认不关联（跟采购单的关联订单走）
  lines: [{ ...sheetTemplate(), stockItemId: null, quantity, unitPrice: null, priceBasis: 'area', customerOrderId: null }],
});
const arrivalTemplate = (today: string) => ({
  date: today,
  actualTime: null,
  notes: '',
  supplierId: null,
  reference: '',
  sourceId: null,
  lines: [
    {
      stockId: null,
      purchaseLineId: null,
      item: sheetTemplate(),
      quantity,
      // 验收合格、拒收、入库空着照旧：合格等于实到、拒收 0、入库等于合格（shared/business/flow/arrival.ts 的 arrivalQuantities）
      acceptedQuantity: null,
      rejectedQuantity: null,
      stockedQuantity: null,
      statedQuantity: null,
      unitPrice: null,
      // 计价方式留空，和录入结构一样不猜按平方米；挂了采购明细的保存时跟采购明细走
      priceBasis: null,
      statedArea: null,
      differenceReason: '',
    },
  ],
});
const productionTemplate = (today: string) => ({
  date: today,
  notes: '',
  taskId: null,
  productId: null,
  finishedStockId: null,
  goodQuantity: quantity,
  scrapQuantity: '0',
  operator: '',
  materials: [{ stockId: null, issued: quantity, returned: '0' }],
});
const deliveryTemplate = (today: string) => ({
  date: today,
  // 计划送货日期空着按单据日期算
  plannedDate: null,
  plannedTime: null,
  notes: '',
  customerId: null,
  address: '',
  contact: '',
  phone: '',
  allowOverdelivery: false,
  overdeliveryReason: '',
  lines: [{ orderId: null, orderLineId: null, stockId: null, quantity, notes: '' }],
});

const templates = (today: string) =>
  ({
    customers: customerTemplate(),
    suppliers: supplierTemplate(),
    products: productTemplate(),
    stock_items: stockTemplate(),
    orders: orderTemplate(today),
    purchases: purchaseTemplate(today),
    arrival: arrivalTemplate(today),
    // 计划生产日期空着按单据日期补（server/flow/validate.ts 的 inputDocument）
    task: { date: today, plannedDate: null, plannedTime: null, notes: '', productId: null, quantity, unit: FINISHED_UNIT, orderIds: [] },
    production: productionTemplate(today),
    delivery: deliveryTemplate(today),
  }) satisfies Record<DataManagementModule, object>;

/** 这个模块新建时的空白模板；单据日期预填今天 */
export function dataManagementTemplate<M extends DataManagementModule>(module: M, today: string): ReturnType<typeof templates>[M] {
  return templates(today)[module];
}
