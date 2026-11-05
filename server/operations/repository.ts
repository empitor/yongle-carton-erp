import type { Store } from '../db.js';
import {
  quantityString,
  quantityUnits,
  lineMoney,
  sumMoney,
  formatStockSize,
} from '../../shared/operations.js';
import { matchesMovement, type MovementFilters } from '../../shared/movement-filters.js';
import { purchaseLineAmount } from '../../shared/physical-flow.js';
import { receiptEvents, effectiveReceiptUnits } from './fulfillment.js';
import { fulfillmentSummary, arrivalLineStatus } from '../../shared/fulfillment.js';
/** 流水被管理员直接改写或删除前留下原值：余额仍由当前流水派生，修订台账负责追溯。 */
export function recordMovementRevision(
  store: Store,
  actor: { id: string; name: string },
  reason: string,
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
) {
  const { __rowid, _rowid, ...original } = before;
  store.db
    .prepare(
      'INSERT INTO stock_movement_revisions(movement_id,item_id,at,actor_id,actor_name,reason,before_document,after_document) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      String(before.id),
      Number(before.item_id),
      new Date().toISOString(),
      actor.id,
      actor.name,
      reason,
      JSON.stringify(original),
      after ? JSON.stringify(after) : null,
    );
}
export class OperationsRepository {
  constructor(readonly store: Store) {}
  suppliers(include = false): any[] {
    const history = new Map<number, any[]>();
    for (const p of this.purchases(true)) {
      const group = history.get(p.supplierId) || [];
      group.push({
        id: p.id,
        number: p.number,
        orderDate: p.orderDate,
        status: p.status,
        businessStatus: p.businessStatus,
        arrivalProgress: p.arrivalProgress,
      });
      history.set(p.supplierId, group);
    }
    const archived = this.store.archivedIds('suppliers');
    return this.store.db
      .prepare(
        'SELECT id,name,contact,phone,address,notes,version,created_at AS createdAt FROM suppliers ORDER BY id DESC',
      )
      .all()
      .filter((r) => include || !archived.has(Number(r.id)))
      .map((r) => ({
        ...r,
        archived: archived.has(Number(r.id)),
        purchaseHistory: history.get(Number(r.id)) || [],
      }));
  }
  /** 只需要确认供应商或取名称时不必加载全部采购历史。 */
  supplierName(id: number, include = false): string | undefined {
    if (!include && this.store.archived('suppliers', id)) return undefined;
    const row = this.store.db.prepare('SELECT name FROM suppliers WHERE id=?').get(id);
    return row ? String(row.name) : undefined;
  }
  /** 传 onlyId 时只组装这一张，供按主键读取。 */
  purchases(include = false, onlyId?: number): any[] {
    const events = receiptEvents(this.store),
      receivedUnits = effectiveReceiptUnits(events),
      archived = this.store.archivedIds('purchases');
    // 按明细和采购单预先分组，避免“每条明细×全部到货事件”的重复扫描。
    const discrepanciesByLine = new Map<number, any[]>(),
      amountsByLine = new Map<number, (string | null)[]>(),
      eventsByPurchase = new Map<number, typeof events>();
    const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
      const group = map.get(key);
      if (group) group.push(value);
      else map.set(key, [value]);
    };
    for (const e of events) {
      const purchaseIds = new Set<number>();
      if (e.purchaseId !== undefined) purchaseIds.add(e.purchaseId);
      for (const line of e.lines) if (line.purchaseId) purchaseIds.add(line.purchaseId);
      for (const id of purchaseIds) push(eventsByPurchase, id, e);
      if (!e.effective) continue;
      for (const d of e.discrepancies || [])
        if (d.lineId) push(discrepanciesByLine, d.lineId, { ...d, receiptId: e.id });
      for (const line of e.lines) if (line.lineId) push(amountsByLine, line.lineId, line.amount);
    }
    const linesByPurchase = new Map<number, any[]>();
    for (const l of this.store.db
      .prepare(
        'SELECT id,purchase_id AS purchaseId,stock_item_id AS stockItemId,document,quantity_units AS quantityUnits,received_units AS receivedUnits FROM purchase_lines ORDER BY id',
      )
      .all())
      push(linesByPurchase, Number(l.purchaseId), l);
    const orderNumbers = new Map(
      this.store.db
        .prepare(
          'SELECT id,number FROM orders WHERE id IN (SELECT customer_order_id FROM purchases WHERE customer_order_id IS NOT NULL)',
        )
        .all()
        .map((o) => [Number(o.id), String(o.number)]),
    );
    return this.store.db
      .prepare(
        'SELECT id,number,supplier_id AS supplierId,supplier_name AS supplierName,customer_order_id AS customerOrderId,order_date AS orderDate,expected_date AS expectedDate,status AS baseStatus,notes,version,created_at AS createdAt,updated_at AS updatedAt FROM purchases ORDER BY id DESC',
      )
      .all()
      .filter(
        (r) =>
          (onlyId === undefined || Number(r.id) === onlyId) &&
          (include || !archived.has(Number(r.id))),
      )
      .map((r) => {
        const lines = (linesByPurchase.get(Number(r.id)) || [])
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
            discrepancies: discrepanciesByLine.get(Number(l.id)) || [],
            receivedAmount: sumMoney(amountsByLine.get(Number(l.id)) || []),
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
          arrivalProgress = summary.progress === '已到齐' ? '全部到货' : summary.progress;
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
          customerOrderNumber: orderNumbers.get(Number(r.customerOrderId)) || '',
          totalAmount: sumMoney(lines.map((l) => l.amount)),
          receivedAmount: sumMoney(lines.map((l) => l.receivedAmount)),
          archived: archived.has(Number(r.id)),
          receipts: [...(eventsByPurchase.get(Number(r.id)) || [])]
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
  /** 已安排：送货草稿和生产登记草稿将要用掉、但尚未确认出库的数量。 */
  private reservedUnits() {
    const units = new Map<number, number>();
    const add = (id: number | null | undefined, quantity: number) => {
      if (id) units.set(id, (units.get(id) || 0) + quantity);
    };
    for (const row of this.store.db
      .prepare(
        "SELECT kind,document FROM flow_documents WHERE status='draft' AND kind IN ('delivery','production') AND id NOT IN (SELECT record_id FROM record_lifecycle WHERE entity IN ('flow_delivery','flow_production'))",
      )
      .all()) {
      const doc = JSON.parse(String(row.document));
      if (row.kind === 'delivery')
        for (const l of doc.lines || []) add(l.stockId, quantityUnits(l.quantity));
      else
        for (const m of doc.materials || [])
          add(m.stockId, quantityUnits(m.issued) - quantityUnits(m.returned || '0'));
    }
    return units;
  }
  /** 在途：已订货采购尚未到齐的数量。 */
  private onOrderUnits() {
    return new Map(
      this.store.db
        .prepare(
          "SELECT l.stock_item_id AS id,SUM(MAX(0,l.quantity_units-l.received_units)) AS n FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE p.status='已订货' AND l.stock_item_id IS NOT NULL AND p.id NOT IN (SELECT record_id FROM record_lifecycle WHERE entity='purchases') GROUP BY l.stock_item_id",
        )
        .all()
        .map((r) => [Number(r.id), Number(r.n)]),
    );
  }
  items(include = false): any[] {
    const archived = this.store.archivedIds('stock_items'),
      balances = new Map(
        this.store.db
          .prepare('SELECT item_id,SUM(delta_units) n FROM stock_movements GROUP BY item_id')
          .all()
          .map((r) => [Number(r.item_id), Number(r.n)]),
      ),
      reserved = this.reservedUnits(),
      onOrder = this.onOrderUnits();
    return this.store.db
      .prepare(
        'SELECT id,name,kind,unit,document,product_id AS productId,version,created_at AS createdAt FROM stock_items ORDER BY id DESC',
      )
      .all()
      .filter((r) => include || !archived.has(Number(r.id)))
      .map((r) => {
        const { document, ...base } = r;
        const balance = balances.get(Number(r.id)) || 0;
        return {
          ...JSON.parse(String(document)),
          ...base,
          quantity: quantityString(balance),
          balanceUnits: balance,
          reservedUnits: reserved.get(Number(r.id)) || 0,
          reserved: quantityString(reserved.get(Number(r.id)) || 0),
          // 可用量只用于提示，可能因草稿超排而为负；实际扣减仍在确认时校验。
          availableUnits: balance - (reserved.get(Number(r.id)) || 0),
          onOrderUnits: onOrder.get(Number(r.id)) || 0,
          onOrder: quantityString(onOrder.get(Number(r.id)) || 0),
          archived: archived.has(Number(r.id)),
        };
      });
  }
  movements(query: MovementFilters = {}): any[] {
    const flows = new Map(
      this.store.db
        .prepare('SELECT id,kind,number FROM flow_documents')
        .all()
        .map((f) => [String(f.id), f]),
    );
    const revisions = new Map(
      this.store.db
        .prepare('SELECT movement_id,COUNT(*) n FROM stock_movement_revisions GROUP BY movement_id')
        .all()
        .map((r) => [String(r.movement_id), Number(r.n)]),
    );
    return this.store.db
      .prepare(
        'SELECT m.*,s.name AS itemName,s.kind,s.unit,s.document AS itemDocument,p.number AS purchaseNumber,o.number AS customerOrderNumber FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN purchase_lines pl ON pl.id=m.purchase_line_id LEFT JOIN purchases p ON p.id=pl.purchase_id LEFT JOIN orders o ON o.id=m.customer_order_id ORDER BY m.created_at DESC,m.rowid DESC',
      )
      .all()
      .map(({ itemDocument, ...row }): any => {
        const document = JSON.parse(String(itemDocument));
        const flow =
          String(row.source_kind).startsWith('flow_') && row.source_id
            ? flows.get(String(row.source_id))
            : null;
        return {
          ...row,
          flowNumber: flow?.number,
          flowKind: flow?.kind,
          revisionCount: revisions.get(String(row.id)) || 0,
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
