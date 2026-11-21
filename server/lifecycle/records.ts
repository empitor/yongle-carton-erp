import type { Store } from '../core/index.js';
import { OperationsService } from '../operations/index.js';
import { FlowService } from '../flow/index.js';
import type { PurchaseView, RecordEntity, StockItemView, SupplierView } from '../../shared/business/index.js';
import type { Customer, Order, Product } from '../../shared/core/index.js';

/**
 * 每类记录读出来的样子：客户、产品、订单在数据库层的 Store 里，供应商在采购库存模块；
 * 采购单、库存品读带单据内容的完整视图（单据流转的 views：到货记录、已安排）
 */
export type BusinessRecordOf = {
  customers: Customer;
  products: Product;
  orders: Order;
  suppliers: SupplierView;
  purchases: PurchaseView;
  stock_items: StockItemView;
};

/** 每类记录怎么读：给了编号只读这几条，没给读全部；按 entity 取，返回值跟着 entity 走 */
const readers: {
  [E in RecordEntity]: (store: Store, includeArchived: boolean, ids?: readonly number[]) => BusinessRecordOf[E][];
} = {
  customers: (store, include, ids) => store.customers(include, ids),
  products: (store, include, ids) => store.products(include, ids),
  orders: (store, include, ids) => (ids ? store.ordersByIds(ids, include) : store.orders(include)),
  suppliers: (store, include, ids) => new OperationsService(store).suppliers(include, ids),
  purchases: (store, include, ids) => new FlowService(store).views.purchases(include, ids),
  stock_items: (store, include, ids) => new FlowService(store).views.items(include, ids),
};

/**
 * 按类型取客户、产品、订单、供应商、采购单、库存品（归档、删除、关联记录、助手按编号查都用它）。
 * 客户、产品、订单在数据库层的 Store 里，供应商在采购库存模块，采购单、库存品读单据流转的完整视图，这里统一一个入口。
 */
export function businessRecord<E extends RecordEntity>(
  store: Store,
  entity: E,
  id: number,
  includeArchived = false,
): BusinessRecordOf[E] | undefined {
  return businessRecords(store, entity, [id], includeArchived).at(0);
}

export function businessRecords<E extends RecordEntity>(
  store: Store,
  entity: E,
  ids: readonly number[],
  includeArchived = false,
): BusinessRecordOf[E][] {
  if (!ids.length) return [];
  return readers[entity](store, includeArchived, ids);
}

/** 某类记录的全部（数据管理、助手列表用）。 */
export function businessList<E extends RecordEntity>(store: Store, entity: E, includeArchived = false): BusinessRecordOf[E][] {
  return readers[entity](store, includeArchived);
}
