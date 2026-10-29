import type { Store } from '../db.js';
import { quantityString, lineMoney, sumMoney, formatStockSize } from '../../shared/operations.js';
import { matchesMovement, type MovementFilters } from '../../shared/movement-filters.js';
import { purchaseLineAmount } from '../../shared/physical-flow.js';
import { receiptEvents, effectiveReceiptUnits } from './fulfillment.js';
import { fulfillmentSummary, arrivalLineStatus } from '../../shared/fulfillment.js';
export class OperationsRepository {
  constructor(readonly store: Store) {}
  suppliers(include = false): any[] {
    const purchases = this.purchases(true);
    return this.store.db
      .prepare(
        'SELECT id,name,contact,phone,address,notes,version,created_at AS createdAt FROM suppliers ORDER BY id DESC',
      )
      .all()
      .filter((r) => include || !this.store.archived('suppliers', Number(r.id)))
      .map((r) => ({
        ...r,
        archived: this.store.archived('suppliers', Number(r.id)),
        purchaseHistory: purchases.filter((p) => p.supplierId === Number(r.id))
          .map((p) => ({
            id: p.id,
            number: p.number,
            orderDate: p.orderDate,
            status: p.status,
            businessStatus: p.businessStatus,
            arrivalProgress: p.arrivalProgress,
          })),
      }));
  }
  purchases(include = false): any[] {
    const events = receiptEvents(this.store),
      receivedUnits = effectiveReceiptUnits(events);
    return this.store.db
      .prepare(
        'SELECT id,number,supplier_id AS supplierId,supplier_name AS supplierName,customer_order_id AS customerOrderId,order_date AS orderDate,expected_date AS expectedDate,status AS baseStatus,notes,version,created_at AS createdAt,updated_at AS updatedAt FROM purchases ORDER BY id DESC',
      )
      .all()
      .filter((r) => include || !this.store.archived('purchases', Number(r.id)))
      .map((r) => {
        const lines = this.store.db
          .prepare(
            'SELECT id,stock_item_id AS stockItemId,document,quantity_units AS quantityUnits,received_units AS receivedUnits FROM purchase_lines WHERE purchase_id=? ORDER BY id',
          )
          .all(r.id)
          .map((l) => ({
            ...JSON.parse(String(l.document)),
            id: Number(l.id),
            stockItemId: l.stockItemId,
            quantity: quantityString(Number(l.quantityUnits)),
            receivedQuantity: quantityString(receivedUnits.get(Number(l.id)) || 0),
            remainingQuantity: quantityString(
              Math.max(0, Number(l.quantityUnits) - (receivedUnits.get(Number(l.id)) || 0)),
            ),
            remainingUnits: Math.max(
              0,
              Number(l.quantityUnits) - (receivedUnits.get(Number(l.id)) || 0),
            ),
            arrivalStatus: arrivalLineStatus(
              Number(l.quantityUnits),
              receivedUnits.get(Number(l.id)) || 0,
            ),
            quantityUnits: Number(l.quantityUnits),
            receivedUnits: receivedUnits.get(Number(l.id)) || 0,
            discrepancies: events.filter((e) => e.effective).flatMap((e) => (e.discrepancies || []).filter((d) => d.lineId === Number(l.id)).map((d) => ({ ...d, receiptId: e.id }))),
            receivedAmount: sumMoney(
              events
                .filter((e) => e.effective)
                .flatMap((e) =>
                  e.lines.filter((line) => line.lineId === Number(l.id)).map((line) => line.amount),
                ),
            ),
            amount:
              JSON.parse(String(l.document)).priceBasis === 'area'
                ? purchaseLineAmount({
                    ...JSON.parse(String(l.document)),
                    quantity: quantityString(Number(l.quantityUnits)),
                  })
                : lineMoney(
                    quantityString(Number(l.quantityUnits)),
                    JSON.parse(String(l.document)).unitPrice,
                  ),
          }));
        const summary = fulfillmentSummary(
            lines.map((l) => l.arrivalStatus),
            '已到齐',
            '部分到货',
            '未到货',
          ),
          arrivalProgress = summary.progress === '已到齐' ? '全部到货' : summary.progress,
          linked = r.customerOrderId
            ? this.store.db.prepare('SELECT number FROM orders WHERE id=?').get(r.customerOrderId)
            : null;
        return {
          ...r,
          lines,
          businessStatus: r.baseStatus,
          arrivalProgress,
          discrepancies: lines.flatMap((l) => l.discrepancies),
          reconciliationStatus: lines.some((l) => l.discrepancies.length) ? '待核对差异' : '一致',
          arrivalSummary: { ...summary, progress: arrivalProgress },
          status:
            r.baseStatus === '已取消'
              ? '已取消'
              : arrivalProgress === '未到货'
                ? r.baseStatus
                : arrivalProgress,
          customerOrderNumber: linked?.number || '',
          totalAmount: sumMoney(lines.map((l) => l.amount)),
          receivedAmount: sumMoney(lines.map((l) => l.receivedAmount)),
          archived: this.store.archived('purchases', Number(r.id)),
          receipts: events
            .filter(
              (e) =>
                e.purchaseId === Number(r.id) || e.lines.some((l) => l.purchaseId === Number(r.id)),
            )
            .reverse()
            .map(({ document, lines: receiptLines, ...e }) => ({
              ...e,
              sourceId: document.sourceId || null,
              reason: document.correctionReason || document.reason || e.reversal?.reason || '',
              reversed: e.status === 'reversed',
              items: receiptLines.filter((l) => l.purchaseId === Number(r.id)),
              correctionLines: receiptLines,
              amount: sumMoney(receiptLines.map((l) => l.amount)),
            })),
        };
      });
  }
  balance(id: number) {
    return Number(
      this.store.db
        .prepare('SELECT COALESCE(SUM(delta_units),0) n FROM stock_movements WHERE item_id=?')
        .get(id)!.n,
    );
  }
  items(include = false): any[] {
    return this.store.db
      .prepare(
        'SELECT id,name,kind,unit,document,product_id AS productId,version,created_at AS createdAt FROM stock_items ORDER BY id DESC',
      )
      .all()
      .filter((r) => include || !this.store.archived('stock_items', Number(r.id)))
      .map((r) => {
        const { document, ...base } = r;
        const balance = this.balance(Number(r.id));
        return {
          ...JSON.parse(String(document)),
          ...base,
          quantity: quantityString(balance),
          balanceUnits: balance,
          archived: this.store.archived('stock_items', Number(r.id)),
        };
      });
  }
  movements(query: MovementFilters = {}): any[] {
    return this.store.db
      .prepare(
        'SELECT m.*,s.name AS itemName,s.kind,s.unit,s.document AS itemDocument,p.number AS purchaseNumber,o.number AS customerOrderNumber FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN purchase_lines pl ON pl.id=m.purchase_line_id LEFT JOIN purchases p ON p.id=pl.purchase_id LEFT JOIN orders o ON o.id=m.customer_order_id ORDER BY m.created_at DESC,m.rowid DESC',
      )
      .all()
      .map(({ itemDocument, ...row }): any => {
        const document = JSON.parse(String(itemDocument));
        const flow =
          String(row.source_kind).startsWith('flow_') && row.source_id
            ? this.store.db
                .prepare('SELECT kind,number FROM flow_documents WHERE id=?')
                .get(Number(row.source_id))
            : null;
        return {
          ...row,
          flowNumber: flow?.number,
          flowKind: flow?.kind,
          itemSpecification: document.specification || formatStockSize(document),
          material: document.material || '',
          flute: document.flute || '',
        };
      })
      .filter((r) => matchesMovement(r, query))
      .map((r) => ({
        ...r,
        delta: quantityString(Math.abs(Number(r.delta_units))),
        direction: Number(r.delta_units) < 0 ? '-' : '+',
        before: quantityString(Number(r.before_units)),
        after: quantityString(Number(r.after_units)),
      }));
  }
  nextId(entity: 'suppliers' | 'purchases' | 'stock_items') {
    return Number(
      this.store.db
        .prepare(
          'SELECT MAX(n)+1 n FROM (SELECT COALESCE(MAX(id),0) n FROM ' +
            entity +
            ' UNION ALL SELECT COALESCE(MAX(record_id),0) n FROM permanent_record_deletions WHERE entity=?)',
        )
        .get(entity)!.n,
    );
  }
}
