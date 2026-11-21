/**
 * 窗口的来源一组：财务扫描的业务来源，已确认、已撤销的送货、到货、完工单，加上盘点流水。
 * 补扫（server/finance/events.ts）先用 heads 拿来源的种类、编号、版本、状态、日期，和财务自己的观察记录在程序里比对，
 * 挑出要读的用 texts 按批读原文（带单号），再逐条用 read 解析成财务口径：一步读库、一步不碰库，
 * 内容读不出来时 read 抛 StoredDataError，财务逐条跳过（server/finance/unreadable.ts），别的照常。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { financeSourceSchemas, financialContent, flowDocumentSchema, movementSource, toFinanceSource } from '../../../shared/business/index.js';
import type { FinanceSource } from '../../../shared/business/index.js';
import { many, parseStoredJson } from '../../core/index.js';

/** 来源的种类：三种单据和盘点流水（和约定里财务口径的种类一一对应） */
const kinds = ['delivery', 'arrival', 'production', 'stock'] as const satisfies readonly (keyof typeof financeSourceSchemas)[];
const head = z.object({
  kind: z.enum(kinds),
  id: z.string(),
  version: z.number(),
  status: z.enum(['confirmed', 'reversed']),
  date: z.string(),
});
/** 一条来源：种类、编号（文字；单据是单据编号，盘点流水是流水编号）、版本、状态、单据日期 */
export type SourceHead = z.output<typeof head>;
const text = head.extend({ number: z.string().nullable(), at: z.string(), text: z.string() });
/** 一条来源的原文：加上单号（盘点流水是拼的说明）、更新时间和内容原文（JSON 文字） */
export type SourceText = z.output<typeof text>;

/** 盘点流水 m 的版本：每改写一次（stock_movement_revisions）加一 */
const stockVersion = (m: string) =>
  `1+coalesce((SELECT max(r.id) FROM stock_movement_revisions r WHERE r.movement_id=${m}.id),0)`;

/** 进财务的单据：送货、到货、完工单里已确认、已撤销的（f 是单据表的别名） */
const financeDocuments = (f: string) =>
  `${f}.kind IN ('delivery','arrival','production') AND ${f}.status IN ('confirmed','reversed')`;

/**
 * 全部来源的种类、编号、版本、状态、日期，一次查完，不读内容。
 * 先后：单据按种类、状态、日期、编号，盘点流水排在最后、按记的先后（补扫按这个先后一批批扫）。
 */
function heads(db: DatabaseSync): SourceHead[] {
  return many(
    db,
    head,
    `SELECT kind,id,version,status,date FROM (
      SELECT kind,cast(id AS TEXT) AS id,version,status,date,id AS seq FROM flow_documents f WHERE ${financeDocuments('f')}
      UNION ALL
      SELECT 'stock',m.id,${stockVersion('m')},'confirmed',m.date,m.rowid FROM stock_movements m WHERE m.action='adjust'
    ) ORDER BY kind,status,CASE WHEN kind='stock' THEN '' ELSE date END,seq`,
  );
}

/**
 * 一批来源的原文，一次查完（refs 是种类和编号；找不到的、不是已确认或已撤销的不在结果里，先后不定）。
 * CROSS JOIN 让 SQLite 先走要的编号、再按主键找单据和流水，不按种类把全部单据扫一遍（单据一多就慢）。
 * 盘点流水没有单据，内容是流水的几项拼成的（库存品、调整量、备注、记的时刻），单号拼成“库存品名 规格 调整量 单位”。
 */
function texts(db: DatabaseSync, refs: readonly { kind: string; id: string }[]): SourceText[] {
  if (!refs.length) return [];
  return many(
    db,
    text,
    `WITH want(kind,id) AS (SELECT value->>'$.kind',value->>'$.id' FROM json_each(?))
    SELECT f.kind,cast(f.id AS TEXT) AS id,f.version,f.status,f.date,f.number,f.updated_at AS at,f.document AS text
      FROM want w CROSS JOIN flow_documents f ON f.id=cast(w.id AS INTEGER) AND f.kind=w.kind WHERE ${financeDocuments('f')}
    UNION ALL
    SELECT 'stock',m.id,${stockVersion('m')},'confirmed',m.date,
      -- 盘点流水没有单据号，流水编号是一串内部编号，人认不出。单号显示“库存品名 规格 调整量 单位”（如“虚构纸板 -2 张”），
      -- 日期、“盘点”另有列。只进快照，不进来源指纹（内容不变）。数量是千分之一的整数，这里只拼成文字显示
      (SELECT i.name||coalesce(' '||nullif(trim(json_extract(i.document,'$.specification')),''),'')||' '||
        CASE WHEN m.delta_units>0 THEN '+' WHEN m.delta_units<0 THEN '-' ELSE '' END||
        (abs(m.delta_units)/1000)||rtrim(rtrim('.'||substr('00'||(abs(m.delta_units)%1000),-3),'0'),'.')||' '||i.unit
        FROM stock_items i WHERE i.id=m.item_id),
      m.created_at,json_object('stockId',m.item_id,'deltaUnits',m.delta_units,'reason',m.notes,'createdAt',m.created_at)
      FROM want w CROSS JOIN stock_movements m ON m.id=w.id WHERE w.kind='stock' AND m.action='adjust'`,
    JSON.stringify(refs.map(({ kind, id }) => ({ kind, id }))),
  );
}

/**
 * 解析一条来源的原文（不碰库）：doc 是财务口径（shared/business 的 toFinanceSource，不带单号），
 * counted 是算进来源指纹的内容（financialContent；财务按它算 sha256，算法和库里存的指纹一样）。
 * 单据按库里的单据结构读（种类在行上，不在内容里，读出来去掉）；读不出来抛 StoredDataError。
 */
function read(source: SourceText): { doc: FinanceSource; counted: unknown } {
  const where = `flow_documents.document（单据 ${source.id}，单号 ${source.number ?? '—'}）`;
  switch (source.kind) {
    case 'delivery': {
      const { kind: _kind, ...content } = parseStoredJson(flowDocumentSchema('delivery'), source.text, where);
      return { doc: toFinanceSource('delivery', content), counted: financialContent('delivery', content) };
    }
    case 'arrival': {
      const { kind: _kind, ...content } = parseStoredJson(flowDocumentSchema('arrival'), source.text, where);
      return { doc: toFinanceSource('arrival', content), counted: financialContent('arrival', content) };
    }
    case 'production': {
      const { kind: _kind, ...content } = parseStoredJson(flowDocumentSchema('production'), source.text, where);
      return { doc: toFinanceSource('production', content), counted: financialContent('production', content) };
    }
    case 'stock': {
      const content = parseStoredJson(financeSourceSchemas.stock, source.text, `盘点流水 ${source.id} 拼出的来源内容`);
      return { doc: content, counted: financialContent('stock', content) };
    }
  }
}

const reversalDates = z.object({ id: z.string(), own: z.string().nullable(), replaced: z.string().nullable() });
/**
 * 一批到货单撤销（更正）那天：own 是这张已撤销时冲回它库存的流水日期，replaced 是被这张替代的原单（已撤销）
 * 冲回流水的日期；都取最晚的，没有是 null。财务按它定红字冲销的默认日期（替代单记没记过账由财务判断）。
 */
function arrivalReversalDates(db: DatabaseSync, ids: readonly string[]) {
  const found = many(
    db,
    reversalDates,
    `SELECT j.value AS id,
      (SELECT max(r.date) FROM stock_movements r WHERE r.source_kind=? AND r.source_id=j.value
        AND EXISTS(SELECT 1 FROM flow_documents u WHERE u.id=cast(j.value AS INTEGER) AND u.kind='arrival' AND u.status='reversed')) AS own,
      (SELECT max(r.date) FROM flow_documents u JOIN stock_movements r ON r.source_kind=? AND r.source_id=cast(u.id AS TEXT)
        WHERE u.replaced_by=cast(j.value AS INTEGER) AND u.kind='arrival' AND u.status='reversed') AS replaced
    FROM json_each(?) j`,
    movementSource.reversal,
    movementSource.reversal,
    JSON.stringify(ids),
  );
  return new Map(found.map(({ id, ...dates }) => [id, dates]));
}

export const sources = { heads, texts, read, arrivalReversalDates };
