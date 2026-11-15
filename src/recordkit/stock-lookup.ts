import { stockByProduct } from '../../shared/business/index';

/** 库存品列表里原材料、成品混着时：只取成品，再按产品取（shared/business 的 stockByProduct）。 */
export function finishedStockByProduct<T extends { kind?: string; productId?: number | null }>(items: readonly T[]) {
  return stockByProduct(items.filter((item) => item.kind === 'finished'));
}
