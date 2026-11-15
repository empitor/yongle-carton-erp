import { FINISHED_UNIT, RAW_UNIT } from '../core/index.js';
import type { dataManagementModules } from './data-management-modules.js';

/*
 * 数据管理“新建”时每个模块的空白模板（服务端数据管理列表、助手 records.search 的 describe 都给它）。
 * 客户、产品、供应商、库存品、订单这些编号一律留空（null）让人选，不拿 0 冒充真值；漏填时提示“请选择客户”这类话。
 */
type DataManagementModule = (typeof dataManagementModules)[number];

const archiveTemplate = () => ({ name: '', contact: '', phone: '', address: '', notes: '' });
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
});
const stockTemplate = () => ({
  name: '',
  kind: 'raw',
  unit: RAW_UNIT,
  specification: '',
  length: null,
  width: null,
  height: null,
  dimensionUnit: null,
  material: '',
  flute: '',
  notes: '',
  productId: null,
});
const orderLineTemplate = () => ({
  productId: null,
  // 产品名称不放进模板：不填就按产品档案的名称存（server/core/db.ts 保存订单），要另起名字的保存后再编辑。
  // 放一个空串进来，保存时会被“产品名称至少一个字”拦下
  specification: '',
  notes: '',
  // 数量、单价留空让人填（漏填时校验报“请填写有效数量”“请填写单价”），不拿 1 和 0 冒充真值，和订单编辑窗一致
  quantity: null,
  unit: FINISHED_UNIT,
  unitPriceCents: null,
  // 精确单价留空：只填“单价（分）”时按分存。预填成 0 的话精确价优先，填的分会被 0 盖掉
  unitPriceExact: '',
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
});
const purchaseTemplate = (today: string) => ({
  supplierId: null,
  customerOrderId: null,
  orderDate: today,
  expectedDate: null,
  status: '待订货',
  notes: '',
  lines: [{ ...stockTemplate(), stockItemId: null, quantity, unitPrice: null, priceBasis: 'area' }],
});
const arrivalTemplate = (today: string) => ({
  date: today,
  notes: '',
  supplierId: null,
  reference: '',
  sourceId: null,
  lines: [
    {
      stockId: null,
      purchaseLineId: null,
      item: stockTemplate(),
      quantity,
      statedQuantity: null,
      unitPrice: null,
      priceBasis: 'area',
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
    customers: archiveTemplate(),
    suppliers: archiveTemplate(),
    products: productTemplate(),
    stock_items: stockTemplate(),
    orders: orderTemplate(today),
    purchases: purchaseTemplate(today),
    arrival: arrivalTemplate(today),
    task: { date: today, notes: '', productId: null, quantity, unit: FINISHED_UNIT, orderIds: [] },
    production: productionTemplate(today),
    delivery: deliveryTemplate(today),
  }) satisfies Record<DataManagementModule, object>;

/** 这个模块新建时的空白模板；单据日期预填今天 */
export function dataManagementTemplate<M extends DataManagementModule>(module: M, today: string): ReturnType<typeof templates>[M] {
  return templates(today)[module];
}
