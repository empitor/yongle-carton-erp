import { readCatalog, type CatalogLists } from '../recordkit/catalog-api';
import { readRecord, readRelated } from '../recordkit/record-api';
import {
  boardReference,
  previousSingleProductOrder,
  purchaseSeedFromOrder,
  type BoardReference,
  type PurchaseLineForm,
} from './purchase-seed';

/** 安排订料要对照的档案：订单、产品、供应商、原材料库存品 */
const launchCatalog = ['orders', 'products', 'suppliers', 'rawItems'] as const;

/** 安排订料窗口打开时读的：编辑窗要的档案、预填好的采购单、关联了哪几张订单（编号，提示里用） */
export type LaunchData = {
  orders: CatalogLists['orders'];
  suppliers: CatalogLists['suppliers'];
  items: CatalogLists['rawItems'];
  seed: { customerOrderId: number | null; lines: PurchaseLineForm[] };
  numbers: string;
};

/** 以前那张订单关联的采购单里的纸板规格；读不到当没有参考（参考信息不影响开单） */
async function referenceOf(orderId: number) {
  try {
    return boardReference((await readRelated('orders', orderId)).purchases);
  } catch {
    // 参考信息读不到不影响开单
    return null;
  }
}

/**
 * 一张订单：读这张订单（含明细），每种要生产的产品一行纸板。
 * 同一产品上次订过的纸板规格标成“参考上次”：每种产品最多看一张以前的订单，读不到就不带。
 */
export async function readSingleLaunch(orderId: number, productIds: number[]): Promise<LaunchData> {
  const [order, { orders, products, suppliers, rawItems: items }] = await Promise.all([
    readRecord('orders', orderId),
    readCatalog(launchCatalog),
  ]);
  const ids = productIds.length ? productIds : [...new Set<number>(order.lines.map((l) => l.productId))];
  const references: Record<number, BoardReference> = {};
  await Promise.all(
    ids.slice(0, 10).map(async (id) => {
      const previous = previousSingleProductOrder(orders, order, id);
      if (!previous) return;
      const reference = await referenceOf(previous.id);
      if (reference) references[id] = reference;
    }),
  );
  return { orders, suppliers, items, seed: purchaseSeedFromOrder(order, products, ids, references), numbers: order.number };
}

/** 几张订单：每张订单的每种产品一行纸板，每行记着给哪张订单 */
export async function readManyLaunch(orderIds: number[]): Promise<LaunchData> {
  const { orders, products, suppliers, rawItems: items } = await readCatalog(launchCatalog);
  const picked = orderIds.map((id) => orders.find((o) => o.id === id)).filter((o) => o !== undefined);
  return {
    orders,
    suppliers,
    items,
    seed: {
      customerOrderId: picked.length === 1 ? picked[0].id : null,
      lines: picked.flatMap((o) => purchaseSeedFromOrder(o, products, []).lines.map((l) => ({ ...l, customerOrderId: o.id }))),
    },
    numbers: orderIds.map((id) => orders.find((o) => o.id === id)?.number || '#' + id).join('、'),
  };
}
