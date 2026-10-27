import { quantityUnits } from './operations.js';

export function deliveryCandidates(
  stock: any,
  customerId: number | null,
  orders: any[],
  allowOverdelivery = false,
) {
  const spec = (v: string) =>
    String(v || '')
      .replace(/\s+/g, '')
      .replaceAll('×', 'x');
  return orders
    .filter(
      (o) =>
        o.customerId === customerId &&
        !o.archived &&
        !['草稿', '已取消'].includes(o.status) &&
        (allowOverdelivery || o.status !== '已发货'),
    )
    .flatMap((o) =>
      o.lines
        .filter(
          (l: any) =>
            l.productId === stock.productId &&
            l.unit &&
            l.unit === stock.unit &&
            (allowOverdelivery || (l.remainingQuantity ?? l.quantity) > 0) &&
            (!stock.specification ||
              !l.specification ||
              spec(stock.specification) === spec(l.specification)),
        )
        .map((line: any) => ({
          orderId: o.id,
          orderLineId: line.id,
          orderNumber: o.number,
          ...line,
        })),
    );
}
export function selectedStockUnits(lines: any[], stockId: number) {
  let total = 0;
  for (const line of lines.filter((l) => l.stockId === stockId)) {
    try {
      total += quantityUnits(String(line.quantity));
    } catch {
      return null;
    }
  }
  return total;
}
/** Old bookmarks remain useful, while new UI has no independent delivery page. */
export function warehouseDeliveryHash(hash: string) {
  if (hash.split('?')[0] !== '#deliveries') return hash;
  const params = new URLSearchParams(hash.split('?')[1] || '');
  params.set('kind', 'finished');
  if (params.has('order') || params.has('stock')) params.set('createDelivery', '1');
  else params.set('deliveries', '1');
  return '#warehouse?' + params;
}
