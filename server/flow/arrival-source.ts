import { z } from 'zod';
import type { Store } from '../core/index.js';
import { sumMoney, type PurchaseRowView, type PurchaseView, type ReceiptEvent } from '../../shared/business/index.js';
import { exists, many, rows } from '../core/index.js';
import { storedContent } from './read.js';
import { quantityText, quantityUnits } from '../../shared/core/index.js';
import type { ArrivalSource } from '../operations/index.js';
import { effectiveReceiptUnits, receiptEvents, subtractReturnedUnits } from './receipt-events.js';

/*
 * 采购库存要看的单据流转数据，按采购库存定的接口（server/operations/hooks.ts 的 ArrivalSource）提供，
 * 加载单据流转时登记（server/flow/service.ts 末尾）。采购库存自己不读单据流转的表。
 */

/** 采购单的一条到货记录：到货事件加上原件、原因、是否撤销，挂在这张采购单上的行和整张的行、金额 */
function receiptOf(purchaseId: number, { document, lines, ...e }: ReceiptEvent) {
  return {
    ...e,
    reversal: e.reversal ?? null,
    sourceId: document.sourceId || null,
    reason: document.correctionReason || e.reversal?.reason || '',
    reversed: e.status === 'reversed',
    items: lines.filter((l) => l.purchaseId === purchaseId),
    correctionLines: lines,
    amount: sumMoney(lines.map((l) => l.amount)),
  };
}

/**
 * 采购单上和到货单有关的部分：已到货（按有效到货单现算，扣掉没撤销的退货）、到货记录（receipts）、
 * 有效到货金额（receivedAmount，按到货单上的单价算）。
 * 采购单本身（单头、明细、到货进度）由采购库存的 purchaseRows 组装；这里按同一批采购单一次读齐相关到货单，不逐张查。
 * 返回的 receivedUnits 交给 purchaseRows，apply 把到货单信息补进它组装好的采购单。
 */
export function purchaseArrivals(store: Store, purchaseIds: number[]) {
  const events = receiptEvents(store, purchaseIds),
    receivedUnits = subtractReturnedUnits(store, effectiveReceiptUnits(events), events);
  // 按明细和采购单预先分组，避免“每条明细×全部到货事件”的重复扫描。
  const amountsByLine = new Map<number, (string | null)[]>(),
    eventsByPurchase = new Map<number, ReceiptEvent[]>();
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const group = map.get(key);
    if (group) group.push(value);
    else map.set(key, [value]);
  };
  for (const e of events) {
    const ids = new Set<number>();
    for (const line of e.lines) if (line.purchaseId) ids.add(line.purchaseId);
    for (const id of ids) push(eventsByPurchase, id, e);
    if (!e.effective) continue;
    for (const line of e.lines) if (line.lineId) push(amountsByLine, line.lineId, line.amount);
  }
  const apply = (purchases: PurchaseRowView[]): PurchaseView[] =>
    purchases.map((p) => {
      const lines = p.lines.map((l) => ({ ...l, receivedAmount: sumMoney(amountsByLine.get(l.id) || []) }));
      return {
        ...p,
        lines,
        receivedAmount: sumMoney(lines.map((l) => l.receivedAmount)),
        receipts: [...(eventsByPurchase.get(p.id) || [])].reverse().map((e) => receiptOf(p.id, e)),
      };
    });
  return { receivedUnits, apply };
}

/** 待核对的、没归档的单据（已安排数只算这些） */
const pendingDocuments =
  "flow_documents.status='draft' AND flow_documents.id NOT IN (SELECT record_id FROM record_lifecycle WHERE entity IN ('flow_delivery','flow_production'))";
/** 只看用到这些库存品的单据（按单据 JSON 里的 lines[].stockId、materials[].stockId 圈）；圈中的单据整张都算 */
const usingStocks = ` AND (EXISTS(SELECT 1 FROM json_each(flow_documents.document,'$.lines') x
    WHERE json_extract(x.value,'$.stockId') IN (SELECT value FROM json_each(?)))
    OR EXISTS(SELECT 1 FROM json_each(flow_documents.document,'$.materials') x
    WHERE json_extract(x.value,'$.stockId') IN (SELECT value FROM json_each(?))))`;
/** 送货单每行、完工单每种领料：库存品和用掉的数（送货是数量，完工是领用和退回），在 SQL 里取，不解析整张单据 */
const reservedLine = z.object({ stockId: z.number().int().positive(), used: quantityText, back: quantityText });

/**
 * 已安排：待送货的送货单、待入库的完工单（没归档的）将要用掉、但还没核对出库的数量，按库存品。
 * ids 给了只读用到这些库存品的单据。库存列表每次都要算，只做合计：每行取两三个数，不解析整张单据。
 */
export function reservedUnits(store: Store, ids?: readonly number[]) {
  const scope = pendingDocuments + (ids === undefined ? '' : usingStocks),
    params = ids === undefined ? [] : [JSON.stringify(ids), JSON.stringify(ids)];
  const units = new Map<number, number>();
  for (const l of many(
    store.db,
    reservedLine,
    "SELECT json_extract(l.value,'$.stockId') AS stockId,json_extract(l.value,'$.quantity') AS used,'0' AS back" +
      " FROM flow_documents, json_each(flow_documents.document,'$.lines') l WHERE flow_documents.kind='delivery' AND " + scope +
      " UNION ALL SELECT json_extract(m.value,'$.stockId'),json_extract(m.value,'$.issued'),json_extract(m.value,'$.returned')" +
      " FROM flow_documents, json_each(flow_documents.document,'$.materials') m WHERE flow_documents.kind='production' AND " + scope,
    ...params,
    ...params,
  ))
    units.set(l.stockId, (units.get(l.stockId) || 0) + quantityUnits(l.used) - quantityUnits(l.back));
  return units;
}

/** 被引用的库存品（按 IN 圈出来的不会是空） */
const stockRef = z.object({ stock_id: z.number() });

export const arrivalSource: ArrivalSource = {
  purchases: purchaseArrivals,
  purchaseReferenced: (store, purchaseId) => exists(store.db, 'SELECT 1 FROM flow_refs WHERE purchase_id=? LIMIT 1', purchaseId),
  batchArrivals: (store, batchId) =>
    many(store.db, rows.flow_documents.pick({ id: true, number: true, date: true, status: true, document: true }), 'SELECT id,number,date,status,document FROM flow_documents WHERE order_batch_id=? ORDER BY date,id', batchId)
      .map((a) => ({ id: a.id, number: a.number, date: a.date, status: a.status, reference: storedContent('arrival', a).reference || '' })),
  batchHasArrivals: (store, batchId) => exists(store.db, 'SELECT 1 FROM flow_documents WHERE order_batch_id=? LIMIT 1', batchId),
  reservedUnits,
  documentNumbers: (store, ids) =>
    new Map(
      many(store.db, rows.flow_documents.pick({ id: true, kind: true, number: true }), 'SELECT id,kind,number FROM flow_documents WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))
        .map((f) => [String(f.id), { kind: f.kind, number: f.number }]),
    ),
  referencedStock: (store, stockIds) =>
    new Set(
      many(store.db, stockRef, 'SELECT DISTINCT stock_id FROM flow_refs WHERE stock_id IN (SELECT value FROM json_each(?))', JSON.stringify(stockIds))
        .map((r) => r.stock_id),
    ),
};
