import type { Store } from '../../core/index.js';
import { one, rows } from '../../core/index.js';
import type { FlowDocument } from '../../../shared/business/index.js';

/*
 * 单据的关联表（flow_refs）和到货的防重复凭据（flow_receipt_keys）的写法，各只写一处。
 * flow_refs：一张单据关联了哪些供应商、采购单、采购明细、库存品、产品、订单、生产任务、客户，
 * 按单据现在的内容整组重写（保存、确认、更正的替代单、管理员连带改单据都调 rewriteRefs）；查“谁引用了谁”都走这张表的索引。
 */

/**
 * 按单据内容重写它在 flow_refs 里的关联（先删后写）。到货单：供应商一行，每条明细一行（库存品、采购明细和它所属的采购单）；
 * 生产任务：产品一行，每张关联订单一行；完工单：产品、成品库存和生产任务一行，每种原材料一行；
 * 送货单：客户一行，每条明细一行（订单、订单明细、库存品和订单明细的产品）。
 */
export function rewriteRefs(store: Store, id: number, doc: FlowDocument) {
  const add = (r: Record<string, number | null>) => {
    const columns = Object.keys(r);
    store.db
      .prepare(
        'INSERT INTO flow_refs(document_id,' +
          columns.join(',') +
          ') VALUES(?,' +
          columns.map(() => '?').join(',') +
          ')',
      )
      .run(id, ...Object.values(r));
  };
  store.db.prepare('DELETE FROM flow_refs WHERE document_id=?').run(id);
  if (doc.kind === 'arrival') {
    add({ supplier_id: doc.supplierId });
    for (const l of doc.lines) {
      const p = l.purchaseLineId
        ? one(store.db, rows.purchase_lines.pick({ purchase_id: true }), 'SELECT purchase_id FROM purchase_lines WHERE id=?', l.purchaseLineId)
        : undefined;
      add({
        stock_id: l.stockId,
        purchase_line_id: l.purchaseLineId,
        purchase_id: p ? p.purchase_id : null,
      });
    }
  }
  if (doc.kind === 'task') {
    add({ product_id: doc.productId });
    for (const orderId of doc.orderIds) add({ order_id: orderId });
  }
  if (doc.kind === 'production') {
    add({ product_id: doc.productId, stock_id: doc.finishedStockId, task_id: doc.taskId });
    for (const m of doc.materials) add({ stock_id: m.stockId });
  }
  if (doc.kind === 'delivery') {
    add({ customer_id: doc.customerId });
    for (const l of doc.lines)
      add({
        order_id: l.orderId,
        order_line_id: l.orderLineId,
        stock_id: l.stockId,
        product_id:
          store.order(l.orderId, true)?.lines.find((x) => x.id === l.orderLineId)
            ?.productId || null,
      });
  }
}

/** 送货单号的查重写法：去掉首尾空白、全半角统一、字母大写 */
export function receiptKey(reference: string) {
  return reference.trim().normalize('NFKC').toUpperCase();
}

/** 记下这家供应商的这个送货单号已经入过库（已有就改指到这张单据：更正的替代单接手原单的号） */
export function saveReceiptKey(store: Store, supplierId: number, reference: string, documentId: number) {
  store.db
    .prepare(
      'INSERT INTO flow_receipt_keys(supplier_id,reference,document_id) VALUES(?,?,?) ON CONFLICT(supplier_id,reference) DO UPDATE SET document_id=excluded.document_id',
    )
    .run(supplierId, receiptKey(reference), documentId);
}
