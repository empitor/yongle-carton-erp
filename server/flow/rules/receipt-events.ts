import { z } from 'zod';
import type { Store } from '../../core/index.js';
import { quantityUnits } from '../../../shared/core/index.js';
import { purchaseLineAmount, type ReceiptEvent } from '../../../shared/business/index.js';
import { many, rows } from '../../core/index.js';
import { storedContent, storedDocuments } from '../documents/read.js';
import { stockLedger } from '../../operations/index.js';

const { setPurchaseLineReceived, touchPurchases } = stockLedger;

/**
 * 到货事件：到货单（arrival）读成采购单能用的样子（结构在 shared/business/flow/flow-views.ts），
 * 以及按它重算采购明细的已到货缓存（purchase_lines.received_units，写由采购库存的 ledger.ts 负责）。
 */
/** 到货事件就是到货单（arrival）。
 * 传 purchaseIds 时按单据关联表 flow_refs.purchase_id 找到货单（每次保存、确认、改单、更正都按明细重写，解除采购关联时一起清空）。
 * 传 options.arrivalIds 时只按主键读这几张到货单，不看 purchaseIds；按主键取到的事件与全量读取时同一事件的内容一致。
 */
export function receiptEvents(
  store: Store,
  purchaseIds?: readonly number[],
  options: { arrivalIds?: readonly number[] } = {},
): ReceiptEvent[] {
  const db = store.db;
  const { arrivalIds } = options;
  if (arrivalIds) purchaseIds = undefined;
  if ((purchaseIds && !purchaseIds.length) || (arrivalIds && !arrivalIds.length)) return [];
  const scoped = !!purchaseIds || !!arrivalIds;
  const scope = JSON.stringify(purchaseIds || []);
  const flowRows = arrivalIds
    ? many(db, rows.flow_documents, "SELECT * FROM flow_documents WHERE kind='arrival' AND id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(arrivalIds))
    : many(
      db,
      rows.flow_documents,
      "SELECT * FROM flow_documents WHERE kind='arrival'" +
        (purchaseIds ? ' AND id IN (SELECT document_id FROM flow_refs WHERE purchase_id IN (SELECT value FROM json_each(?)))' : '') +
        ' ORDER BY id',
      ...(purchaseIds ? [scope] : []),
    );
  // 同一到货单可能跨采购单；保留该单的完整明细，不能截掉 correctionLines。
  const docs = new Map(flowRows.map((r) => [r, storedContent('arrival', r)]));
  const linkedLineIds = [...docs.values()].flatMap((d) => d.lines.flatMap((l) => (l.purchaseLineId == null ? [] : [l.purchaseLineId])));
  const purchaseLines = new Map(
    many(
      db,
      rows.purchase_lines.pick({ id: true, purchase_id: true }),
      'SELECT id,purchase_id FROM purchase_lines' +
        (scoped ? ' WHERE purchase_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?))' : ''),
      ...(scoped ? [scope, JSON.stringify(linkedLineIds)] : []),
    ).map((l) => [l.id, l]),
  );
  const events: ReceiptEvent[] = [];
  for (const [row, doc] of docs) {
    events.push({
      id: 'flow-' + row.id,
      flowId: Number(row.id),
      version: Number(row.version),
      reference: doc.reference,
      date: String(row.date),
      status: String(row.status),
      effective: row.status === 'confirmed',
      supplierId: doc.supplierId,
      actorName: String(row.actor_name),
      createdAt: String(row.created_at),
      correctionOf: doc.correctionOfReceiptId || (doc.correctionOf ? 'flow-' + doc.correctionOf : null),
      replacedBy: doc.replacedBy ? 'flow-' + doc.replacedBy : null,
      reversal: doc.reversal || null,
      document: doc,
      lines: doc.lines.map((l, index) => {
        const pl = l.purchaseLineId == null ? undefined : purchaseLines.get(l.purchaseLineId);
        return {
          index,
          lineId: pl ? pl.id : null,
          purchaseId: pl ? pl.purchase_id : null,
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
/** 采购退货的一行（退货单内容里的行号、数量，见 shared/business/flow/purchase-return.ts） */
const returnedLine = rows.purchase_returns.pick({ id: true, arrival_id: true }).extend({ line_index: z.number(), quantity: z.string() });
/**
 * 有效到货数量要扣掉没冲销的采购退货：退回去的货，供应商补货时可以再到货。
 * 退货挂哪条采购明细，以到货单“现在”的第 lineIndex 行为准（来自 events，明细存在才算），
 * 不看退货单里存的旧编号：退货登记以后，管理员可能把这一行改挂到别的采购明细，或者把原来的明细解除关联、删掉，
 * 旧编号就过时了（明细编号自增、不复用，旧编号不会指到新明细上，但也不能再当现在的关联用）。
 * 到货单已失效（冲销、被更正替代）的退货不再扣。扣到 0 为止，不出现负数。
 * excludeReturnId：算“这张退货冲销后”的到货量时跳过它。
 */
export function subtractReturnedUnits(
  store: Store,
  units: Map<number, number>,
  events: readonly ReceiptEvent[],
  excludeReturnId?: number,
) {
  const arrivals = new Map<number, ReceiptEvent>();
  for (const e of events) if (e.flowId && e.effective) arrivals.set(e.flowId, e);
  if (!arrivals.size) return units;
  for (const row of many(
    store.db,
    returnedLine,
    `SELECT r.id,r.arrival_id,json_extract(l.value,'$.lineIndex') AS line_index,json_extract(l.value,'$.quantity') AS quantity
      FROM purchase_returns r, json_each(r.document,'$.lines') l
      WHERE r.status='confirmed' AND r.arrival_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify([...arrivals.keys()]),
  )) {
    if (excludeReturnId !== undefined && row.id === excludeReturnId) continue;
    const lineId = arrivals.get(row.arrival_id)?.lines[row.line_index]?.lineId,
      had = lineId ? units.get(lineId) : undefined;
    if (lineId && had !== undefined) units.set(lineId, Math.max(0, had - quantityUnits(row.quantity)));
  }
  return units;
}
/**
 * 按有效到货事件重算采购明细的已到货缓存。
 * 传 purchaseIds 时只重算这几张采购单的明细：按采购单读到的事件已包含涉及这些明细的全部到货
 * （跨单到货也带完整明细），退货也按这些到货扣，所以这几张单的结果与全量重算相同。
 * 不传时全量重算，数据维护走这条路。
 */
export function syncReceivedUnits(store: Store, bumpVersion = false, purchaseIds?: readonly number[]) {
  if (purchaseIds && !purchaseIds.length) return;
  const events = receiptEvents(store, purchaseIds),
    units = subtractReturnedUnits(store, effectiveReceiptUnits(events), events),
    changed = new Set<number>();
  for (const l of many(
    store.db,
    rows.purchase_lines.pick({ id: true, purchase_id: true, received_units: true }),
    'SELECT id,purchase_id,received_units FROM purchase_lines' + (purchaseIds ? ' WHERE purchase_id IN (SELECT value FROM json_each(?))' : ''),
    ...(purchaseIds ? [JSON.stringify(purchaseIds)] : []),
  )) {
    const received = units.get(l.id) || 0;
    if (received !== l.received_units) {
      setPurchaseLineReceived(store, l.id, received);
      changed.add(l.purchase_id);
    }
  }
  if (bumpVersion) touchPurchases(store, changed, new Date().toISOString());
}
/**
 * 这几张到货单关联的采购单：按到货明细里的采购明细查所属采购单，再并上单据引用里记的采购单。
 * 到货确认、冲销、更正和退货只影响这些采购单的已到货，用来限定 syncReceivedUnits 的范围。
 */
export function arrivalPurchaseIds(store: Store, arrivalIds: readonly (number | null | undefined)[]) {
  const ids = [...new Set(arrivalIds.filter((id): id is number => typeof id === 'number'))];
  if (!ids.length) return [];
  const lineIds = storedDocuments(store, ids).flatMap(({ document }) =>
    document.kind === 'arrival' ? document.lines.flatMap((l) => (l.purchaseLineId == null ? [] : [l.purchaseLineId])) : [],
  );
  return many(
    store.db,
    rows.purchase_lines.pick({ purchase_id: true }),
    `SELECT purchase_id FROM purchase_lines WHERE id IN (SELECT value FROM json_each(?))
      UNION SELECT purchase_id FROM flow_refs WHERE purchase_id IS NOT NULL AND document_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(lineIds),
    JSON.stringify(ids),
  ).map((r) => r.purchase_id);
}
