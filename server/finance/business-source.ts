/**
 * 财务读业务表的地方里还没搬进只读窗口（server/flow/finance-facts/）的：sourceReversed（成本计算还在用，搬走后删）和采购段。
 *
 * 财务不调用业务代码，按表只读单据流转、采购库存的数据（tests/module-boundaries.test.ts 登记的例外）。
 * 已经搬进窗口的不在这里：往来单位的名称和选单位的名单，补扫的来源（种类、版本、状态、原文和财务口径，财务的对照在 source-scan.ts）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { purchaseLineDocumentSchema } from '../../shared/business/index.js';
import { exists, many, parseStoredJson, rows } from '../core/index.js';
import { readOrSkip } from './unreadable.js';
import { snapshotLines } from './source-snapshot.js';

/**
 * e 的来源（e.source_id 是单据编号：财务事件、库存流水都行）是一张已撤销的 kind 单据，被更正替代的原单也是已撤销。
 * 只看单据，不看 e 是什么来源，调用方另加来源种类。条件。
 */
export const sourceReversed = (e: string, kind: 'delivery' | 'arrival') =>
  `EXISTS(SELECT 1 FROM flow_documents f WHERE f.id=cast(${e}.source_id AS INTEGER) AND f.kind='${kind}' AND f.status='reversed')`;

/**
 * 这张到货单有没有已确认的采购退货（到票时按退后数量开票不用填对应暂估，invoice-blue.ts）。
 * 已撤销、被更正替代的到货在关联、确认发票时就被拦下（invoice-rules.ts），走到这里的到货都还有效，不另看到货状态。
 */
export function hasConfirmedReturn(db: DatabaseSync, arrivalId: number) {
  return exists(db, "SELECT 1 FROM purchase_returns r WHERE r.arrival_id=? AND r.status='confirmed' LIMIT 1", arrivalId);
}

/**
 * 采购退货单 document 里的一行明细，财务只读到货单第几行、退了多少（别的项原样留着）。
 * 退货单内容由单据流转写（server/flow/return-document.ts，写之前按它的结构核对），财务按表只读。
 */
const returnLine = z.looseObject({ lineIndex: z.number().int().nonnegative(), quantity: z.string() });
/** 退货单行上的 lines：document 里明细数组的 JSON 文字 */
const returnLines = z.object({ lines: z.string() });
/** 读出退货单的明细 */
function withLines<R extends { id: number; lines: string }>(r: R) {
  const where = `purchase_returns.document 的明细（退货单 ${r.id}）`;
  return { ...r, lines: parseStoredJson(z.array(returnLine), r.lines, where) };
}
/** 读出一张要记的退货单的明细；读不出来的记下跳过、返回 null（和单据同一套，unreadable.ts） */
export function readReturnOrSkip(db: DatabaseSync, r: z.output<typeof returnToBook>) {
  return readOrSkip(db, { kind: 'purchase_return', id: String(r.id), number: r.number, content: r.lines }, () => withLines(r));
}
const returnToBook = rows.purchase_returns
  .pick({ id: true, number: true, arrival_id: true, status: true, date: true, updated_at: true })
  .extend(returnLines.shape);

/**
 * 要在财务记一笔的采购退货：已确认、还没冲过暂估的，和已撤销、冲过还没恢复的。明细还是原文，逐张用 readReturnOrSkip 读。
 * booked 是财务这边算“这张退货冲了多少”的 SQL 表达式（r 是退货单），由 return-estimates.ts 传进来。
 */
export function purchaseReturnsToBook(db: DatabaseSync, booked: string) {
  return many(
    db,
    returnToBook,
    // 明细取 JSON 原文（->）；document 不是 JSON、没有明细的记成空串：照样逐张读，读不出来跳过，不让整条查询出错
    `SELECT r.id,r.number,r.arrival_id,r.status,r.date,r.updated_at,
        CASE WHEN json_valid(r.document) THEN coalesce(r.document->'$.lines','') ELSE '' END AS lines
      FROM purchase_returns r
      WHERE (r.status='confirmed' AND ${booked}=0) OR (r.status='reversed' AND ${booked}>0) ORDER BY r.id`,
  );
}

const returnOfArrival = rows.purchase_returns.pick({ id: true, arrival_id: true }).extend(returnLines.shape);
/** 几张采购退货的到货单和明细，成本计算给退货计价用 */
export function purchaseReturnLines(db: DatabaseSync, ids: number[]) {
  return many(
    db,
    returnOfArrival,
    `SELECT r.id,r.arrival_id,json_extract(r.document,'$.lines') AS lines FROM purchase_returns r
      WHERE r.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  ).map(withLines);
}

/** 往来对应的采购单和采购明细（明细内容是 document 列的文字） */
const purchaseOfObligation = z.object({
  obligation_id: rows.fin_obligations.shape.id,
  id: rows.purchases.shape.id,
  number: rows.purchases.shape.number,
  line_id: rows.purchase_lines.shape.id,
  quantity_units: rows.purchase_lines.shape.quantity_units,
  document: rows.purchase_lines.shape.document,
});
/** 往来（到货生成的）对应的采购明细：按事件快照里到货明细的 purchaseLineId 找采购单和采购明细。obligationIds 是 JSON 数组。 */
export function purchaseLinesOf(db: DatabaseSync, obligationIds: string) {
  return many(
    db,
    purchaseOfObligation,
    `SELECT o.id AS obligation_id,p.id,p.number,pl.id AS line_id,pl.quantity_units,pl.document
      FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
      JOIN ${snapshotLines('e.snapshot')} l
      JOIN purchase_lines pl ON pl.id=json_extract(l.value,'$.purchaseLineId')
      JOIN purchases p ON p.id=pl.purchase_id WHERE o.id IN (SELECT value FROM json_each(?))`,
    obligationIds,
  );
}

/**
 * 采购明细 document 里的纸板资料和计价方式（purchaseLineAmount 用得到的字段都在里面）。
 * 结构用共用的 purchaseLineDocumentSchema（采购库存写读这一列也用它）。
 */
export function purchaseLineItem(line: { line_id: number; document: string }) {
  return parseStoredJson(purchaseLineDocumentSchema, line.document, `purchase_lines.document（采购明细 ${line.line_id}）`);
}
