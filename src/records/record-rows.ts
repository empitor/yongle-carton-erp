import type { PurchaseView, RecordEntity, StockItemView, SupplierView } from '../../shared/business/index';
import type { Customer, TrackedOrder, Product } from '../../shared/core/index';
import { centsText, displayAmount } from '../../shared/core/index';

/**
 * 档案、订单、采购单、库存品列表和详情里的一条，按记录种类：列表读到的带“已归档”标记，
 * 按一条重读的（recordkit/record-api.ts 的 readRecord）客户、产品、订单不带，所以那三种的 archived 可以没有。
 * 种类和行要对得上的地方，用按种类写的映射表（{ [K in RecordEntity]: … }）加泛型取，不靠断言。
 */
type MaybeListed<T> = T & { archived?: boolean };
export type RecordRowOf = {
  orders: MaybeListed<TrackedOrder>;
  customers: MaybeListed<Customer>;
  products: MaybeListed<Product> & { orderedCustomers?: string[] };
  suppliers: SupplierView;
  purchases: PurchaseView;
  stock_items: StockItemView;
};
export type RecordRow<E extends RecordEntity = RecordEntity> = RecordRowOf[E];

/** 一条记录的叫法：订单、采购单是单号，其余是名称 */
export const recordLabel = (row: RecordRow) => ('number' in row ? row.number : row.name);

export function orderAmount(row: Pick<TrackedOrder, 'totalAmountExact' | 'totalCents'>) {
  return row.totalAmountExact ? displayAmount(row.totalAmountExact) : centsText(row.totalCents);
}
