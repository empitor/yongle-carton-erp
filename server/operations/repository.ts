import type { Store } from '../db.js';
import { quantityString, lineMoney, sumMoney, formatStockSize } from '../../shared/operations.js';
import { matchesMovement, type MovementFilters } from '../../shared/movement-filters.js';
import { purchaseLineAmount } from '../../shared/physical-flow.js';
export class OperationsRepository {
  constructor(readonly store: Store) {}
  suppliers(include = false): any[] {
    return this.store.db
      .prepare(
        'SELECT id,name,contact,phone,address,notes,version,created_at AS createdAt FROM suppliers ORDER BY id DESC',
      )
      .all()
      .filter((r) => include || !this.store.archived('suppliers', Number(r.id)))
      .map((r) => ({
        ...r,
        archived: this.store.archived('suppliers', Number(r.id)),
        purchaseHistory: this.store.db
          .prepare(
            "SELECT p.id,p.number,CASE WHEN p.status='已取消' THEN '已取消' WHEN NOT EXISTS(SELECT 1 FROM purchase_lines l WHERE l.purchase_id=p.id AND l.received_units<l.quantity_units) THEN '全部到货' WHEN EXISTS(SELECT 1 FROM purchase_lines l WHERE l.purchase_id=p.id AND l.received_units>0) THEN '部分到货' ELSE p.status END AS status,p.order_date AS orderDate FROM purchases p WHERE p.supplier_id=? ORDER BY p.id DESC",
          )
          .all(r.id),
      }));
  }
  purchases(include = false): any[] {
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
            receivedQuantity: quantityString(Number(l.receivedUnits)),
            quantityUnits: Number(l.quantityUnits),
            receivedUnits: Number(l.receivedUnits),
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
        const received = lines.reduce((n, l) => n + l.receivedUnits, 0),
          full = lines.every((l) => l.receivedUnits >= l.quantityUnits),
          linked = r.customerOrderId
            ? this.store.db.prepare('SELECT number FROM orders WHERE id=?').get(r.customerOrderId)
            : null;
        return {
          ...r,
          lines,
          status:
            r.baseStatus === '已取消'
              ? '已取消'
              : full
                ? '全部到货'
                : received
                  ? '部分到货'
                  : r.baseStatus,
          customerOrderNumber: linked?.number || '',
          totalAmount: sumMoney(lines.map((l) => l.amount)),
          archived: this.store.archived('purchases', Number(r.id)),
          receipts: this.store.db
            .prepare(
              'SELECT id,reference,date,document,actor_name AS actorName,created_at AS createdAt FROM purchase_receipts WHERE purchase_id=? ORDER BY created_at DESC',
            )
            .all(r.id)
            .map((s) => ({
              ...s,
              items: JSON.parse(String(s.document)).items,
              reversed: !!JSON.parse(String(s.document)).reversed,
              flowId: JSON.parse(String(s.document)).flowId,
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
