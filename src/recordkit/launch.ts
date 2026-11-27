import { pageHref } from '../../shared/core/index';

/**
 * 从选中的记录新建单据：跳到对应页面打开新建窗，并带上选中的内容。
 * 右上角的“新建”是空白单；这里是“拿这些东西开单”，所以客户、产品、供应商、纸板都预先填好。
 * 末尾带一个时间戳，连点两次同一个按钮也能再打开。
 */

/** 新建订单：带客户，或带几种产品（每种一行，数量自己填；产品不属于某个客户，客户不猜）。 */
export function newOrderFrom({ customerId, productIds }: { customerId?: number; productIds?: number[] }) {
  location.hash = pageHref('orders', {
    create: true,
    customer: customerId,
    products: productIds,
    n: Date.now(),
  });
}

/** 新建采购单：带供应商，或带几种纸板（每种一行，张数和单价自己填）。 */
export function newPurchaseFrom({ supplierId, stockIds }: { supplierId?: number; stockIds?: number[] }) {
  location.hash = pageHref('purchases', {
    create: true,
    supplier: supplierId,
    stocks: stockIds,
    n: Date.now(),
  });
}
