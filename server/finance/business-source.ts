/**
 * 财务读业务数据的地方（成本计算读库存流水的在 costing-source.ts）。
 *
 * 财务不调用业务代码，按表只读单据流转、采购库存的数据（tests/module-boundaries.test.ts 登记的例外）。
 * 读这些表的 SQL 都放在这里，财务别的文件只调这里的函数或 SQL 片段：业务改了表，财务只改这两个文件。
 * 单据内容按库里的单据结构读（shared/business 的 flowDocumentSchema）；事件快照里抄来的单据字段怎么取见 source-snapshot.ts。
 * 已经搬进单据流转只读窗口（server/flow/finance-facts/）的不在这里：往来单位的名称和选单位的名单。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { financeSourceSchemas, flowDocumentSchema, purchaseLineDocumentSchema, toFinanceSource } from '../../shared/business/index.js';
import type { FinanceSource } from '../../shared/business/index.js';
import { exists, many, parseStoredJson, rows } from '../core/index.js';
import { readOrSkip } from './unreadable.js';
import { sourceHash, withNumber } from './source-fingerprint.js';
import type { FinanceSourceDocument } from './source-snapshot.js';
import { snapshotLines } from './source-snapshot.js';
import { eventSourceKinds } from './stored-values.js';

/**
 * 财务扫描的来源（CTE，名字是 sources，列 kind,id,version,status,date,document,at,number）：
 * 已确认、已撤销的送货、到货、完工单，盘点流水。
 */
export const sourcesCte = `WITH sources(kind,id,version,status,date,document,at,number) AS (
      SELECT kind,cast(id AS TEXT),version,status,date,document,updated_at,number
      FROM flow_documents WHERE kind IN ('delivery','arrival','production') AND status IN ('confirmed','reversed')
      UNION ALL
      SELECT 'stock',m.id,1+coalesce((SELECT max(r.id) FROM stock_movement_revisions r WHERE r.movement_id=m.id),0),
        'confirmed',m.date,json_object('stockId',m.item_id,'deltaUnits',m.delta_units,'reason',m.notes,'createdAt',m.created_at),m.created_at,
        -- 盘点流水没有单据号，流水编号是一串内部编号，人认不出。单号显示“库存品名 规格 调整量 单位”（如“虚构纸板 -2 张”），
        -- 日期、“盘点”另有列。只进快照，不进来源指纹（document 不变）。数量是千分之一的整数，这里只拼成文字显示
        (SELECT i.name||coalesce(' '||nullif(trim(json_extract(i.document,'$.specification')),''),'')||' '||
          CASE WHEN m.delta_units>0 THEN '+' WHEN m.delta_units<0 THEN '-' ELSE '' END||
          (abs(m.delta_units)/1000)||rtrim(rtrim('.'||substr('00'||(abs(m.delta_units)%1000),-3),'0'),'.')||' '||i.unit
          FROM stock_items i WHERE i.id=m.item_id)
      FROM stock_movements m WHERE m.action='adjust'
    )`;

/** 来源 s 的这一版财务还没扫到：观察记录 o 没有，或版本、状态和上次看到的不一样。条件，补扫和“还没同步”的计数同一个口径。 */
export const sourceUnseen = (s: string, o: string) =>
  `(${o}.source_id IS NULL OR ${o}.source_version<>${s}.version OR ${o}.status<>${s}.status)`;

/** sourcesCte 读出的一行：种类、编号（文字）、版本、状态、单据日期、内容、更新时间、单号（盘点流水是拼的说明） */
export const sourceRow = z.object({
  kind: z.enum(eventSourceKinds),
  id: z.string(),
  version: z.number(),
  status: z.enum(['confirmed', 'reversed']),
  date: z.string(),
  document: z.string(),
  at: z.string(),
  number: z.string().nullable(),
});
export type SourceRow = z.output<typeof sourceRow>;

/**
 * 读一条来源：快照存的财务口径（shared/business 的 toFinanceSource，加上单号）和来源指纹（按完整内容算，见 sourceHash）。
 * 送货、到货、完工单按库里的单据结构读（种类在行上，不在 document 里，读出来去掉），盘点流水按 sourcesCte 拼出来的那几项读。
 */
export function readSource(source: SourceRow): { doc: FinanceSourceDocument; hash: string } {
  const read = (content: object, doc: FinanceSource) => ({ doc: withNumber(doc, source.number), hash: sourceHash(source, content) });
  const where = `flow_documents.document（单据 ${source.id}，单号 ${source.number ?? '—'}）`;
  switch (source.kind) {
    case 'delivery': {
      const { kind: _kind, ...content } = parseStoredJson(flowDocumentSchema('delivery'), source.document, where);
      return read(content, toFinanceSource('delivery', content));
    }
    case 'arrival': {
      const { kind: _kind, ...content } = parseStoredJson(flowDocumentSchema('arrival'), source.document, where);
      return read(content, toFinanceSource('arrival', content));
    }
    case 'production': {
      const { kind: _kind, ...content } = parseStoredJson(flowDocumentSchema('production'), source.document, where);
      return read(content, toFinanceSource('production', content));
    }
    case 'stock': {
      const content = parseStoredJson(financeSourceSchemas.stock, source.document, `盘点流水 ${source.id} 拼出的来源内容`);
      return read(content, content);
    }
  }
}

/**
 * 同 readSource，内容读不出来的记下跳过、返回 null（unreadable.ts）：补扫（events.ts）和列“还没同步的单据”的地方
 * （月度台账、报表检查）都用它，一张坏单据不让整批、整页出错。它照样算“还没同步”（unseenSources）。
 */
export function readSourceOrSkip(db: DatabaseSync, source: SourceRow) {
  return readOrSkip(db, { kind: source.kind, id: source.id, number: source.number, content: source.document }, () =>
    readSource(source),
  );
}

/** 一段日期里已确认的送货、到货单（CTE 名字和列同 sourcesCte），参数 ?1、?2 是起止日期。月度台账、报表检查算还没同步的单据用。 */
export const confirmedDocumentsCte = `WITH sources(kind,id,version,status,date,document,at,number) AS (
        SELECT kind,cast(id AS TEXT),version,status,date,document,updated_at,number FROM flow_documents
          WHERE kind IN ('delivery','arrival') AND status='confirmed' AND date BETWEEN ?1 AND ?2
      )`;

/** 观察记录 o（fin_source_observations）对应的来源已经没了（单据或盘点流水被删）。条件。 */
export const sourceMissing = (o: string) =>
  `((${o}.source_kind IN ('delivery','arrival','production') AND NOT EXISTS (SELECT 1 FROM flow_documents f WHERE f.id=cast(${o}.source_id AS INTEGER) AND f.kind=${o}.source_kind))
          OR (${o}.source_kind='stock' AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.id=${o}.source_id)))`;

/** 事件 e 来源单据（送货、到货、完工单）的单号，作为列放进同一条查询，不逐条查；别的来源是 NULL。 */
export const sourceDocumentNumber = (e: string) =>
  `(SELECT f.number FROM flow_documents f WHERE f.id=cast(${e}.source_id AS INTEGER) AND f.kind=${e}.source_kind)`;
/**
 * e 的来源（e.source_id 是单据编号：财务事件、库存流水都行）是一张已撤销的 kind 单据，被更正替代的原单也是已撤销。
 * 只看单据，不看 e 是什么来源，调用方另加来源种类。条件。
 */
export const sourceReversed = (e: string, kind: 'delivery' | 'arrival') =>
  `EXISTS(SELECT 1 FROM flow_documents f WHERE f.id=cast(${e}.source_id AS INTEGER) AND f.kind='${kind}' AND f.status='reversed')`;

/** 财务事件 e 的来源单据还是已确认的；notReplaced 时还要没被更正替代。条件。 */
export const sourceConfirmed = (e: string, notReplaced = false) =>
  `EXISTS(SELECT 1 FROM flow_documents f WHERE f.id=cast(${e}.source_id AS INTEGER) AND f.kind=${e}.source_kind AND f.status='confirmed'${
    notReplaced ? ' AND f.replaced_by IS NULL' : ''
  })`;

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
