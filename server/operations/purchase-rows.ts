import { z } from 'zod';
import type { Store } from '../core/index.js';
import { many, rows } from '../core/index.js';
import { lineMoney, purchaseBusinessStatuses, purchaseLineAmount, sumMoney } from '../../shared/business/index.js';
import type { PurchaseLineView, PurchaseRowView } from '../../shared/business/index.js';
import { arrivalLineStatus, fulfillmentSummary, quantityString } from '../../shared/core/index.js';
import { readPurchaseLineDocument } from './ledger.js';
import { recordScope, type RecordIds } from './record-scope.js';

/*
 * 读采购单本身：单头、明细、已到货和到货进度，不读单据流转的表（OperationsRepository 的 purchaseRows、purchases 用）。
 * 单头、明细、关联订单的单号都按同一范围批量读，不逐张查。
 */

/**
 * 采购单和客户订单的对应：单头关联的订单，加上明细各自关联的订单。
 * 一张采购单可以给几张订单订料，按订单找采购都用这张表，不只看单头。
 * 结果两列：purchase_id、order_id。两边都是普通外键列，各有索引（明细那一列是只含非空值的部分索引）。
 */
export const purchaseOrderLinks =
  'SELECT id AS purchase_id,customer_order_id AS order_id FROM purchases WHERE customer_order_id IS NOT NULL' +
  ' UNION SELECT purchase_id,customer_order_id FROM purchase_lines WHERE customer_order_id IS NOT NULL';

/** 一行采购明细算在哪张订单上：这一行自己关联的订单，没有就跟单头走。 */
export function lineOrderId(
  purchase: { customerOrderId: number | null; lines: readonly { id: number; customerOrderId: number | null }[] } | null | undefined,
  lineId: number | null | undefined,
): number | null {
  if (!purchase) return null;
  const line = lineId ? purchase.lines.find((l) => l.id === lineId) : null;
  return line?.customerOrderId ?? purchase.customerOrderId ?? null;
}

const headRow = rows.purchases.extend({ status: z.enum(purchaseBusinessStatuses) });
type HeadRow = z.output<typeof headRow>;
type LineRow = z.output<typeof rows.purchase_lines>;
const orderNumberRow = rows.orders.pick({ id: true, number: true });

/** 要读的这批采购单：按编号、按供应商圈（都给就同时满足），交给下面几个函数的 SQL 条件和参数 */
export function purchaseScope(ids: RecordIds, supplierIds: RecordIds) {
  const byId = recordScope(ids),
    bySupplier = recordScope(supplierIds);
  const conditions = [byId.predicate && 'id ' + byId.predicate, bySupplier.predicate && 'supplier_id ' + bySupplier.predicate].filter(Boolean);
  return { where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params: [...byId.params, ...bySupplier.params] };
}
type PurchaseScope = ReturnType<typeof purchaseScope>;
/** 范围内采购单的条件，接在明细、订单的查询后面 */
const inScope = (scope: PurchaseScope) => (scope.where ? ' WHERE purchase_id IN (SELECT id FROM purchases' + scope.where + ')' : '');

/** 范围内的采购单单头（新的在前）；include 为 false 时去掉归档的。archived 是采购单全部的归档编号，组装时还要用 */
export function purchaseHeads(store: Store, scope: PurchaseScope, include: boolean) {
  const archived = store.archivedIds('purchases');
  const heads = many(store.db, headRow, 'SELECT * FROM purchases' + scope.where + ' ORDER BY id DESC', ...scope.params).filter(
    (r) => include || !archived.has(r.id),
  );
  return { heads, archived };
}

/**
 * 把单头组装成采购单：明细、关联订单的单号、到货进度和金额。
 * received 是每条明细的已到货（千分整数，单据流转按有效到货单现算的）；不给时取明细的缓存列 received_units
 * （单据流转按有效到货单、退货维护，见 server/flow/receipt-events.ts 的 syncReceivedUnits）。
 */
export function assemblePurchases(
  store: Store,
  read: { heads: HeadRow[]; scope: PurchaseScope; archived: ReadonlySet<number>; received?: Map<number, number> },
): PurchaseRowView[] {
  const lineRows = many(store.db, rows.purchase_lines, 'SELECT * FROM purchase_lines' + inScope(read.scope) + ' ORDER BY id', ...read.scope.params);
  const orderNumbers = new Map(
    many(
      store.db,
      orderNumberRow,
      'SELECT id,number FROM orders WHERE id IN (SELECT order_id FROM (' + purchaseOrderLinks + ')' + inScope(read.scope) + ')',
      ...read.scope.params,
    ).map((o) => [o.id, o.number]),
  );
  const linesByPurchase = new Map<number, PurchaseLineView[]>();
  for (const l of lineRows) {
    const line = lineView(l, read.received ? read.received.get(l.id) || 0 : l.received_units, orderNumbers);
    const group = linesByPurchase.get(l.purchase_id);
    if (group) group.push(line);
    else linesByPurchase.set(l.purchase_id, [line]);
  }
  return read.heads.map((h) => purchaseView(h, linesByPurchase.get(h.id) || [], orderNumbers, read.archived.has(h.id)));
}

/** 订单的单号，没有关联订单或查不到是空串 */
const orderNumberOf = (orderNumbers: ReadonlyMap<number, string>, orderId: number | null) =>
  (orderId === null ? undefined : orderNumbers.get(orderId)) || '';

/** 一行采购明细：库里的内容加上列里的库存品、关联订单（没有就是 null，跟单头走）、数量和已到货 */
function lineView(l: LineRow, receivedUnits: number, orderNumbers: ReadonlyMap<number, string>): PurchaseLineView {
  const document = readPurchaseLineDocument(l.document, l.id),
    quantity = quantityString(l.quantity_units),
    remainingUnits = Math.max(0, l.quantity_units - receivedUnits);
  return {
    ...document,
    id: l.id,
    stockItemId: l.stock_item_id,
    customerOrderId: l.customer_order_id,
    quantity,
    receivedQuantity: quantityString(receivedUnits),
    remainingQuantity: quantityString(remainingUnits),
    remainingUnits,
    arrivalStatus: arrivalLineStatus(l.quantity_units, receivedUnits),
    quantityUnits: l.quantity_units,
    receivedUnits,
    customerOrderNumber: orderNumberOf(orderNumbers, l.customer_order_id),
    amount:
      document.priceBasis === 'area' ? purchaseLineAmount({ ...document, quantity }) : lineMoney(quantity, document.unitPrice),
  };
}

/** 一张采购单：单头、明细，按明细的到货情况算到货进度和显示的状态 */
function purchaseView(h: HeadRow, lines: PurchaseLineView[], orderNumbers: ReadonlyMap<number, string>, archived: boolean): PurchaseRowView {
  const summary = fulfillmentSummary(
      lines.map((l) => l.arrivalStatus),
      '已到齐',
      '部分到货',
      '未到货',
    ),
    arrivalProgress = summary.progress === '已到齐' ? '全部到货' : summary.progress;
  // 这张采购给哪些订单订的料：单头关联的订单加上各行关联的订单
  const orderIds = [
    ...new Set(
      [h.customer_order_id, ...lines.map((l) => l.customerOrderId ?? h.customer_order_id)].filter(
        (n): n is number => n !== null && n > 0,
      ),
    ),
  ];
  return {
    id: h.id,
    number: h.number,
    supplierId: h.supplier_id,
    supplierName: h.supplier_name,
    customerOrderId: h.customer_order_id,
    orderDate: h.order_date,
    expectedDate: h.expected_date,
    baseStatus: h.status,
    notes: h.notes,
    version: h.version,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    lines,
    businessStatus: h.status,
    arrivalProgress,
    arrivalSummary: { ...summary, progress: arrivalProgress },
    status: h.status === '已取消' ? '已取消' : arrivalProgress === '未到货' ? h.status : arrivalProgress,
    customerOrderNumber: orderNumberOf(orderNumbers, h.customer_order_id),
    orderIds,
    customerOrders: orderIds.map((id) => ({ id, number: orderNumbers.get(id) || '#' + id })),
    totalAmount: sumMoney(lines.map((l) => l.amount)),
    archived,
  };
}
