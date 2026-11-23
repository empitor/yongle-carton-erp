import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { quantityText, quantityUnits } from '../../../shared/core/index.js';
import { many, orderIdScope, rows } from '../../core/index.js';

/* 订单明细已经出库多少：只算已确认的送货单（订单状态派生、订单视图、改单核对、送货核对都用这里） */

/**
 * 已确认送货单的每一行：哪张送货单、哪条订单明细、多少。在 SQL 里取这两个数，不解析整张单据——
 * 读订单（列表、单张）每次都要把相关的已出库送货单过一遍，只做合计。
 */
const shippedLine = z.object({ id: rows.flow_documents.shape.id, orderLineId: z.number().int().positive(), quantity: quantityText });
const shippedLines =
  "SELECT flow_documents.id AS id,json_extract(l.value,'$.orderLineId') AS orderLineId,json_extract(l.value,'$.quantity') AS quantity" +
  " FROM flow_documents, json_each(flow_documents.document,'$.lines') l WHERE flow_documents.kind='delivery' AND flow_documents.status='confirmed'";

/**
 * 每条订单明细的有效已发数量（千分单位）：只算已确认的送货单；指定订单时经 flow_refs 索引只读相关送货单
 * （圈出来的送货单里别的订单的行也一起算进结果）。
 */
export function shippedByLine(db: DatabaseSync, orderIds: readonly number[] | undefined) {
  const { predicate, params } = orderIdScope(orderIds);
  const shipped = new Map<number, number>();
  for (const l of many(
    db,
    shippedLine,
    shippedLines + (predicate ? ' AND flow_documents.id IN (SELECT document_id FROM flow_refs WHERE order_id ' + predicate + ')' : ''),
    ...params,
  ))
    shipped.set(l.orderLineId, (shipped.get(l.orderLineId) || 0) + quantityUnits(l.quantity));
  return shipped;
}
/**
 * 一条订单明细已经出库多少（千分单位），只算已确认的送货单；excluding 是不算在内的那张送货单（核对它自己时）。
 * 单据有没有效只看状态：撤销、被更正替代的单据状态都已经不是 confirmed。
 */
export function shippedUnits(db: DatabaseSync, lineId: number | undefined, excluding?: number) {
  let n = 0;
  if (lineId === undefined) return n; // 尚未保存的新明细没有送货记录。
  for (const l of many(db, shippedLine, shippedLines + ' AND flow_documents.id IN (SELECT document_id FROM flow_refs WHERE order_line_id=?)', lineId))
    if (l.id !== excluding && l.orderLineId === lineId) n += quantityUnits(l.quantity);
  return n;
}
