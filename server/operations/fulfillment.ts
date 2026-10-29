import type { Store } from '../db.js';
import { quantityUnits, quantityString } from '../../shared/operations.js';
import { purchaseLineAmount } from '../../shared/physical-flow.js';

export type ReceiptLine = {
  index: number;
  lineId: number | null;
  purchaseId: number | null;
  stockId: number | null;
  quantity: string;
  recordedQuantity?: string;
  acceptedQuantity: string | null;
  rejectedQuantity: string | null;
  stockedQuantity: string | null;
  item: any;
  unitPrice: string | null;
  priceBasis: 'area' | 'quantity' | null;
  amount: string | null;
};
export type ReceiptEvent = {
  id: string;
  source: 'flow' | 'legacy';
  flowId: number | null;
  version: number;
  reference: string;
  date: string;
  status: string;
  effective: boolean;
  supplierId: number;
  purchaseId?: number;
  missingFlow?: number;
  actorName: string;
  createdAt: string;
  correctionOf: string | null;
  replacedBy: string | null;
  reversal: any;
  lines: ReceiptLine[];
  document: any;
  dataEdits?: any[];
  discrepancies?: any[];
};
/** arrival 是正式事件，purchase_receipts.flowId 是其采购投影，永不再次相加。
 * 无 flowId 的旧入口记录仍是独立正式事件；缺少投影的历史 arrival 也能读取。
 */
export function receiptEvents(store: Store): ReceiptEvent[] {
  const db = store.db;
  const purchaseLines = new Map(
    db
      .prepare('SELECT * FROM purchase_lines')
      .all()
      .map((l) => [Number(l.id), l]),
  );
  const purchases = new Map(
    db
      .prepare('SELECT id,supplier_id FROM purchases')
      .all()
      .map((p) => [Number(p.id), p]),
  );
  const events: ReceiptEvent[] = [];
  for (const row of db
    .prepare("SELECT * FROM flow_documents WHERE kind='arrival' ORDER BY id")
    .all()) {
    const doc = JSON.parse(String(row.document));
    if (doc.isPlan) continue;
    events.push({
      id: 'flow-' + row.id,
      source: 'flow',
      flowId: Number(row.id),
      version: Number(row.version),
      reference: doc.reference,
      date: String(row.date),
      status: String(row.status),
      effective: row.status === 'confirmed' && !doc.reversal && !doc.replacedBy,
      supplierId: doc.supplierId,
      actorName: String(row.actor_name),
      createdAt: String(row.created_at),
      correctionOf: doc.correctionOfReceiptId || (doc.correctionOf ? 'flow-' + doc.correctionOf : null),
      replacedBy: doc.replacedBy ? 'flow-' + doc.replacedBy : null,
      reversal: doc.reversal || null,
      document: doc,
      lines: (doc.lines || []).map((l: any, index: number) => {
        const pl = purchaseLines.get(l.purchaseLineId);
        return {
          index,
          lineId: pl ? Number(pl.id) : null,
          purchaseId: pl ? Number(pl.purchase_id) : null,
          stockId: l.stockId,
          quantity: l.quantity,
          acceptedQuantity: l.acceptedQuantity ?? null,
          rejectedQuantity: l.rejectedQuantity ?? null,
          stockedQuantity: l.stockedQuantity ?? null,
          item: l.item,
          unitPrice: l.unitPrice ?? null,
          priceBasis: l.priceBasis ?? null,
          amount: purchaseLineAmount({
            ...l.item,
            quantity: l.quantity,
            unitPrice: l.unitPrice ?? null,
            priceBasis: l.priceBasis ?? null,
          }),
        };
      }),
    });
  }
  for (const row of db.prepare('SELECT * FROM purchase_receipts ORDER BY created_at,id').all()) {
    const doc = JSON.parse(String(row.document));
    if (doc.flowId && events.some((e) => e.flowId === doc.flowId)) continue;
    const auditRow = db
      .prepare(
        "SELECT document FROM business_audit WHERE action='receive' AND entity='purchases' AND json_extract(document,'$.receiptId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(row.id);
    const receiptAudit = auditRow ? JSON.parse(String(auditRow.document)) : null;
    events.push({
      id: String(row.id),
      source: 'legacy',
      flowId: null,
      version: doc.version || 1,
      reference: doc.originalReference || String(row.reference),
      date: String(row.date),
      status: doc.reversed || doc.replacedBy ? 'reversed' : 'confirmed',
      effective:
        !doc.reversed &&
        !doc.replacedBy &&
        !doc.cancelled &&
        (!doc.status || doc.status === 'confirmed'),
      supplierId: Number(purchases.get(Number(row.purchase_id))?.supplier_id),
      purchaseId: Number(row.purchase_id),
      ...(doc.flowId ? { missingFlow: doc.flowId } : {}),
      actorName: String(row.actor_name),
      createdAt: String(row.created_at),
      correctionOf: doc.correctionOf || null,
      replacedBy: doc.replacedBy || null,
      reversal: doc.reversal || null,
      document: doc,
      lines: (doc.items || []).map((l: any, index: number) => {
        const pl = purchaseLines.get(l.lineId),
          meta = pl ? JSON.parse(String(pl.document)) : {};
        const move = db
          .prepare(
            'SELECT item_id FROM stock_movements WHERE source_kind=? AND source_id=? AND purchase_line_id=? LIMIT 1',
          )
          .get(
            doc.flowId ? 'flow_arrival' : 'purchase_receipt',
            doc.flowId ? String(doc.flowId) : row.id,
            l.lineId ?? null,
          );
        const snapshot =
          l.item || receiptAudit?.before?.lines?.find((line: any) => line.id === l.lineId);
        const item = snapshot || meta,
          unitPrice = l.unitPrice !== undefined ? l.unitPrice : (snapshot?.unitPrice ?? null);
        const priceBasis =
          l.priceBasis !== undefined ? l.priceBasis : (snapshot?.priceBasis ?? null);
        return {
          index,
          lineId: pl && pl.purchase_id === row.purchase_id ? Number(pl.id) : null,
          purchaseId: pl && pl.purchase_id === row.purchase_id ? Number(pl.purchase_id) : null,
          stockId:
            l.stockId ||
            (move ? Number(move.item_id) : pl?.stock_item_id ? Number(pl.stock_item_id) : null),
          quantity: l.quantity,
          acceptedQuantity: l.acceptedQuantity ?? null,
          rejectedQuantity: l.rejectedQuantity ?? null,
          stockedQuantity: l.stockedQuantity ?? null,
          item,
          unitPrice,
          priceBasis,
          amount: purchaseLineAmount({ ...item, quantity: l.quantity, unitPrice, priceBasis }),
        };
      }),
    });
  }
  // 管理员统计纠偏使用原不可变审计台账；原到货和原库存流水保持原样。
  const edits = store.db.prepare("SELECT * FROM business_audit WHERE action='receipt-data-edit' ORDER BY id").all();
  for (const event of events) {
    for (const line of event.lines) {
      if (line.stockedQuantity == null && line.stockId) {
        const movements = db.prepare('SELECT delta_units FROM stock_movements WHERE source_kind=? AND source_id=? AND item_id=? AND purchase_line_id IS ?').all(
          event.flowId || event.missingFlow ? 'flow_arrival' : 'purchase_receipt', event.flowId || event.missingFlow ? String(event.flowId || event.missingFlow) : event.id, line.stockId, line.lineId);
        if (movements.length) line.stockedQuantity = quantityString(movements.reduce((n, m) => n + Number(m.delta_units), 0));
      }
    }
    event.dataEdits = edits.map((r) => ({ ...JSON.parse(String(r.document)), auditId: Number(r.id), at: r.at, actorName: r.actor_name }))
      .filter((r) => r.receiptId === event.id);
    event.version += event.dataEdits.length;
    for (const line of event.lines) {
      line.recordedQuantity = line.quantity;
      for (const edit of event.dataEdits) {
        const change = edit.items.find((i: any) => i.index === line.index && i.lineId === line.lineId);
        if (change) line.quantity = change.quantity;
      }
      line.amount = purchaseLineAmount({ ...line.item, quantity: line.quantity, unitPrice: line.unitPrice, priceBasis: line.priceBasis });
    }
    event.discrepancies = event.lines.filter((l) => quantityUnits(l.quantity) !== quantityUnits(l.recordedQuantity!)).map((l) => ({
      index: l.index, lineId: l.lineId, purchaseId: l.purchaseId, stockId: l.stockId,
      name: l.item.name, unit: l.item.unit, recordedQuantity: l.recordedQuantity, effectiveQuantity: l.quantity,
      differenceUnits: quantityUnits(l.recordedQuantity!) - quantityUnits(l.quantity), status: '待核对差异',
    }));
  }
  return events;
}
export function effectiveReceiptUnits(events: ReceiptEvent[]) {
  const units = new Map<number, number>();
  for (const event of events.filter((e) => e.effective))
    for (const line of event.lines)
      if (line.lineId)
        units.set(line.lineId, (units.get(line.lineId) || 0) + quantityUnits(line.quantity));
  return units;
}
export function syncReceivedUnits(store: Store, bumpVersion = false) {
  const units = effectiveReceiptUnits(receiptEvents(store)),
    changed = new Set<number>();
  for (const l of store.db
    .prepare('SELECT id,purchase_id,received_units FROM purchase_lines')
    .all()) {
    const received = units.get(Number(l.id)) || 0;
    if (received !== Number(l.received_units)) {
      store.db.prepare('UPDATE purchase_lines SET received_units=? WHERE id=?').run(received, l.id);
      changed.add(Number(l.purchase_id));
    }
  }
  if (bumpVersion)
    for (const id of changed)
      store.db
        .prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
}
