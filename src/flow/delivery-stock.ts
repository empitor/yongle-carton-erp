import { deliveryCandidates, sizeText, type FlowDocView } from '../../shared/business/index';
import { quantityString } from '../../shared/core/index';
import type { CatalogLists } from '../recordkit/catalog-api';

/* 送货单“送哪些货”里一种成品的说法和新加一行：勾选列表和明细行共用。 */

type DeliveryDoc = FlowDocView<'delivery'>;
/** 编辑窗里送货单的一行：换了客户、新勾的成品还没挂上订单明细时订单是 null */
export type DeliveryEditLine = Omit<DeliveryDoc['lines'][number], 'orderId' | 'orderLineId'> & {
  orderId: number | null;
  orderLineId: number | null;
};
/** 编辑窗里的送货单：已有送货单的副本，客户可能还没选，明细可能还没挂订单 */
export type DeliveryEditing = Omit<DeliveryDoc, 'customerId' | 'lines'> & { customerId: number | null; lines: DeliveryEditLine[] };
/** 送货单表单要对照的档案：客户、库存品、产品、订单 */
export type DeliveryFormData = Pick<CatalogLists, 'customers' | 'items' | 'products' | 'orders'>;
/** 一种库存品（库存品清单里的一条） */
export type StockItem = CatalogLists['items'][number];
type OrderLine = CatalogLists['orders'][number]['lines'][number];
/** 一种成品能对上的一条订单明细（订单号、产品、待交付、单位） */
export type Candidate = ReturnType<typeof deliveryCandidates<OrderLine>>[number];

/** 一种可送成品的勾选、明细行要用的：这一行能对哪些订单明细、新加一行怎么预填、改明细行 */
export type DeliveryPick = {
  lines: DeliveryEditLine[];
  candidates: (item: StockItem) => Candidate[];
  seed: (item: StockItem, current: DeliveryEditLine[]) => DeliveryEditLine;
  change: (patch: { lines: DeliveryEditLine[] }) => void;
};

/** 库存的说法。有待送货的单子占着时写“可用”，和订单“下一步”里的库存可用说法一致。 */
export function stockText(item: Pick<StockItem, 'reservedUnits' | 'availableUnits' | 'quantity' | 'unit'>) {
  const available = quantityString(Math.max(0, item.availableUnits)) + ' ' + item.unit;
  return item.reservedUnits > 0
    ? '可用 ' + available + ' / 现存 ' + item.quantity + ' ' + item.unit
    : '库存 ' + item.quantity + ' ' + item.unit;
}

/** 成品名称后面那一小行：所属客户、客户型号、规格 */
export const describeStock = (
  item: Pick<StockItem, 'customerName' | 'specification' | 'length' | 'width' | 'height' | 'dimensionUnit'>,
  product: { customerProductCode?: string | null } | undefined,
) =>
  [item.customerName, product?.customerProductCode, item.specification || sizeText(item) || '规格待补充']
    .filter(Boolean)
    .join(' · ');

/** 新加一行：这种成品还没被别的行占用的订单明细只剩一条时直接选上 */
export function seedLine(choices: Candidate[], item: Pick<StockItem, 'id'>, current: DeliveryEditLine[]): DeliveryEditLine {
  const left = choices.filter((c) => !current.some((l) => l.orderLineId === c.orderLineId));
  const only = left.length === 1 ? left[0] : null;
  return {
    stockId: item.id,
    orderId: only ? only.orderId : null,
    orderLineId: only ? only.orderLineId : null,
    quantity: '',
    notes: '',
  };
}
