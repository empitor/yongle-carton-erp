import type { Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import { FlowService } from '../flow/index.js';
import { formatStockSize, type FlowDocView } from '../../shared/business/index.js';
import { displayAmount, plainPrice, type Customer, type Order, type Product } from '../../shared/core/index.js';
import { joinSpecification, type RawForm } from './forms.js';
// 送货单要印的内容（只读，不写库）：单据视图加上客户、关联订单补全的字段。

type Delivery = FlowDocView<'delivery'>;
type DeliveryLine = Delivery['lines'][number];
/** 送货单明细关联的订单（含归档的），按编号查 */
type Orders = Map<number, Order>;
/** 待送货的送货单明细的产品（含归档的），按编号查 */
type Products = Map<number, Product>;
/** 精确单价印出来至少留几位小数（1.5000 印成 1.50） */
const PRICE_MIN_DECIMALS = 2;
const UNRECORDED = '未记录';

/** 明细上记了长或宽才印尺寸 */
const lineSize = (l: DeliveryLine) => (l.length != null || l.width != null ? formatStockSize(l) : '');
const orderLineOf = (orders: Orders, l: DeliveryLine) => orders.get(l.orderId)?.lines.find((x) => x.id === l.orderLineId);
/** 几行各自的值去重后连起来 */
const joinedUnique = (values: (string | undefined)[]) => [...new Set(values)].join(' / ');

/** 抬头信息：客户、地址、联系方式、关联订单、送货日期、客户采购单号 */
function deliveryFields(record: Delivery, customer: Customer | undefined, orders: Orders): [string, string][] {
  const confirmed = record.status === 'confirmed';
  return [
    ['送货单号', record.number],
    ['客户', customer?.name || '历史客户'],
    ['收货地址', record.address || customer?.address || UNRECORDED],
    [
      '客户联系信息',
      [record.contact || customer?.contact, record.phone || customer?.phone].filter(Boolean).join(' · ') || UNRECORDED,
    ],
    ['关联销售订单', joinedUnique(record.lines.map((l) => l.orderNumber || orders.get(l.orderId)?.number))],
    [
      confirmed ? '实际送货日期' : '预计送货日期',
      confirmed
        ? [record.date, record.actualTime].filter(Boolean).join(' ')
        : [record.plannedDate || record.date, record.plannedTime].filter(Boolean).join(' '),
    ],
    [
      '客户采购订单号',
      joinedUnique(
        record.lines.map((l) => l.externalPurchaseOrder ?? orders.get(l.orderId)?.externalPurchaseOrder).filter(Boolean),
      ) || UNRECORDED,
    ],
  ];
}

/** 明细默认几列：序号、品名、规格及尺寸、单位、数量、备注 */
function deliveryRow(orders: Orders, l: DeliveryLine, i: number) {
  const ol = orderLineOf(orders, l);
  return [
    String(i + 1),
    l.productName || ol?.productName || '历史产品',
    joinSpecification(l.specification || ol?.specification, lineSize(l)),
    l.unit || ol?.unit || UNRECORDED,
    l.quantity,
    l.notes || '',
  ];
}

/** 金额：是十进制数就按金额写法印，不是的原样印 */
function amountText(l: DeliveryLine) {
  const value = l.amountExact || '';
  return /^-?\d+(\.\d+)?$/.test(value) ? displayAmount(value) : value || UNRECORDED;
}

/**
 * 待送货的送货单明细还没补材质、楞型（出库核对时才按产品补进明细，server/flow/validate-delivery.ts）：
 * 和品名、规格一样按现在的档案印，订单明细的产品一次取齐；已出库的印明细上记的，不取产品。
 */
function draftProducts(store: Store, record: Delivery, orders: Orders): Products {
  if (record.status !== 'draft') return new Map();
  const ids = record.lines.flatMap((l) => {
    const ol = orderLineOf(orders, l);
    return ol ? [ol.productId] : [];
  });
  return new Map(store.products(true, [...new Set(ids)]).map((p) => [p.id, p]));
}

/** 模板可选的列：订单号、客户采购单号、客户产品编号、单价、金额、尺寸、材质、楞型（产品没填的印空） */
function deliveryLineData(orders: Orders, products: Products, l: DeliveryLine) {
  const o = orders.get(l.orderId),
    ol = orderLineOf(orders, l),
    product = ol ? products.get(ol.productId) : undefined;
  return {
    orderNumber: l.orderNumber || o?.number || '',
    customerOrderNumber: l.externalPurchaseOrder ?? o?.externalPurchaseOrder ?? '',
    productCode: l.customerProductCode ?? ol?.customerProductCode ?? '',
    // 快照里的精确单价固定四位小数，印出来去掉多余尾零、至少留两位（1.5000 印成 1.50，1.2345 照印）
    unitPrice: l.unitPriceExact ? plainPrice(l.unitPriceExact, PRICE_MIN_DECIMALS) : UNRECORDED,
    amount: amountText(l),
    dimensions: lineSize(l),
    material: l.material ?? product?.material ?? '',
    flute: l.flute ?? product?.flute ?? '',
  };
}

/** 送货单：已取消、已冲销的不能导出成有效送货单。 */
export function deliveryForm(store: Store, id: number): RawForm<'delivery'> {
  const record = new FlowService(store).get(id);
  if (record.kind !== 'delivery') throw new AppError('请选择送货记录。');
  if (['cancelled', 'reversed'].includes(record.status))
    throw new AppError('取消或冲销的送货单不能导出为有效送货单。', 409);
  const customer = store.customer(record.customerId, true),
    orders: Orders = new Map(store.ordersByIds(record.lines.map((l) => l.orderId), true).map((o) => [o.id, o])),
    products = draftProducts(store, record, orders);
  return {
    record,
    form: {
      title: '送货单',
      number: record.number,
      draft: record.status !== 'confirmed',
      fields: deliveryFields(record, customer, orders),
      headers: ['序号', '产品名称', '规格及尺寸', '单位', '本批送货数量', '备注'],
      columnKeys: ['index', 'name', 'specification', 'unit', 'quantity', 'notes'],
      rows: record.lines.map((l, i) => deliveryRow(orders, l, i)),
      lineData: record.lines.map((l) => deliveryLineData(orders, products, l)),
      notes: record.notes,
      signatures: ['送货人签字', '收货人签字'],
    },
  };
}
