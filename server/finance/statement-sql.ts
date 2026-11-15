/**
 * 往来对账单的查询：一个单位一段时间里应收（应付）和预收（预付）科目上的分录，加上还没记账的送货、到货往来，
 * 同一条冲销链的几行挨着排。多查几列给 statements.ts 拼对方看得懂的摘要。
 */
import { z } from 'zod';
import { chainCtes, chainRoot, inChain, isRerecorded, isReversed, reversedDocument } from './reversal-pairs.js';
import { snapshotNumber } from './source-snapshot.js';

/** 对账单查询的一行：前面几列给对方看，后面几列拼摘要用，拼好就去掉 */
export const statementRow = z.object({
  voucher_id: z.number().nullable(),
  date: z.string(),
  number: z.number().nullable(),
  description: z.string(),
  position: z.number(),
  /** 红字冲销那行（红字凭证，或还没记账的冲销往来）和被冲销的原来那行没有到期日 */
  due_date: z.string().nullable(),
  delta: z.number(),
  /** 1 是红字冲销那行；摘要按冲的是哪张单据生成（“红字冲销 送货单 SH-…”），不带操作员写的冲销原因 */
  red: z.number(),
  /** 1 是在对账期末以前已被红字冲销的原来那行，不带到期日 */
  reversed: z.number(),
  /** 1 是单据改过、红字冲销后按新内容重记的那行，摘要后面写“（更正后重记）” */
  rerecorded: z.number(),
  document_number: z.string().nullable(),
  red_document: z.string().nullable(),
  red_module: z.string().nullable(),
  red_original_date: z.string().nullable(),
  /** 红字凭证冲的是一笔核销（撤销核销），不是撤销整笔收付款 */
  red_allocation: z.number().nullable(),
  /** 红字凭证冲的原凭证是送货、到货生成的：那张单据的单号 */
  red_original_document: z.string().nullable(),
  /** 原凭证（或没记账时原往来）的摘要：上面两样都没有时，红字行写“红字冲销 原摘要” */
  red_original_description: z.string().nullable(),
  /** 凭证是哪个功能生成的（没记账的往来是 NULL） */
  module: z.string().nullable(),
  /** 1 是预收（预付）科目上的分录；合并以后是“这张凭证在这个单位上只动了预收（预付）” */
  adv: z.number(),
  /** 红字冲销往来冲的那笔的日期、是不是重记的那笔 */
  red_target_date: z.string().nullable(),
  red_target_rerecorded: z.number().nullable(),
  /** 收付款生成的凭证：那笔收付款的类型、日期、总额，摘要写“收客户款 01-03 100.00”，不用操作员填的资金单摘要 */
  cash_kind: z.string().nullable(),
  cash_date: z.string().nullable(),
  cash_total: z.number().nullable(),
  /** 1 是确认收付款时就核销的那张凭证（只动应收应付） */
  cash_initial: z.number().nullable(),
  /** 红字凭证冲的原凭证是收付款生成的：那笔收付款的日期 */
  red_cash_date: z.string().nullable(),
});
export type StatementRow = z.output<typeof statementRow>;

/**
 * 对账单的 SQL。参数依次：往来种类、方向（应收 1、应付 -1）、期末、辅助核算种类、单位、起止日期，
 * 再是往来种类、单位、起止日期（还没记账的往来）。
 * 应收、应付之外，这个单位的预收（2203）、预付（1123）也进对账单：没核销直接记预收的收款，对方已经付了钱，
 * 对账单上不能看不到。科目编码是代码里的常量，直接写进 SQL。
 */
export function statementSql(receivable: boolean) {
  const code = receivable ? '1122' : '2202',
    adv = receivable ? '2203' : '1123';
  const onAccount = (e: string) => `(${e}.account_code LIKE '${code}%' OR ${e}.account_code LIKE '${adv}%')`;
  return `WITH RECURSIVE ${chainCtes()}
      SELECT voucher_id,date,number,description,position,
      CASE WHEN red OR reversed THEN NULL ELSE due_date END AS due_date,delta,red,reversed,rerecorded,
      document_number,red_document,red_module,red_original_date,red_allocation,red_original_document,red_original_description,
      module,adv,red_target_date,red_target_rerecorded,cash_kind,cash_date,cash_total,cash_initial,red_cash_date FROM (
      -- 同一条冲销链（原来那笔、红字冲销、重记，再冲销、再重记……）的几行挨着，按链里的先后排，
      -- 整组放在链里第一行的位置；不在链上的行照旧按日期、凭证、分录排
      SELECT *,CASE WHEN grp IS NULL THEN date ELSE first_value(date) OVER chain END AS group_date,
        CASE WHEN grp IS NULL THEN voucher_id ELSE first_value(voucher_id) OVER chain END AS group_voucher FROM (
      SELECT v.id AS voucher_id,v.date,v.number,e.position,v.description,
      (SELECT min(o.due_date) FROM fin_obligations o WHERE o.voucher_id=v.id AND o.party_id=e.auxiliary_id) AS due_date,
      CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END * ? * (e.debit-e.credit) AS delta,
      v.reversal_of IS NOT NULL AS red,
      v.reversal_of IS NULL AND EXISTS(SELECT 1 FROM fin_obligations o
        WHERE o.voucher_id=v.id AND o.party_id=e.auxiliary_id AND ${isReversed('o', ' AND r.date<=?')}) AS reversed,
      EXISTS(SELECT 1 FROM fin_obligations o WHERE o.voucher_id=v.id AND ${isRerecorded('o')}) AS rerecorded,
      -- 送货、到货生成的凭证：对账单写“送货单 SH-…”，不写“送货确认”“到货暂估”这类记账说法
      (SELECT ${snapshotNumber('ev.snapshot')}
        FROM fin_events ev WHERE ev.id=v.event_id AND ev.source_kind IN ('delivery','arrival')) AS document_number,
      (SELECT ${reversedDocument('ro')} FROM fin_obligations ro
        WHERE ro.voucher_id=v.id AND ro.reversal_of IS NOT NULL LIMIT 1) AS red_document,
      -- 红字凭证冲的原凭证（ov）：哪个功能生成的、日期、摘要、是不是送货到货生成的；撤销核销的红字凭证挂着反向核销
      ov.module_source AS red_module,ov.date AS red_original_date,
      v.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM fin_allocations a WHERE a.voucher_id=v.id AND a.reversal_of IS NOT NULL) AS red_allocation,
      (SELECT ${snapshotNumber('oe.snapshot')}
        FROM fin_events oe WHERE oe.id=ov.event_id AND oe.source_kind IN ('delivery','arrival')) AS red_original_document,
      ov.description AS red_original_description,
      (SELECT min(${chainRoot('o')}) FROM fin_obligations o WHERE o.voucher_id=v.id AND o.party_id=e.auxiliary_id AND ${inChain('o')}) AS grp,
      (SELECT min(o.id) FROM fin_obligations o WHERE o.voucher_id=v.id AND o.party_id=e.auxiliary_id) AS chain_pos,
      v.module_source AS module,e.account_code LIKE '${adv}%' AS adv,
      -- 红字冲销往来冲的那笔：哪天的、是不是重记的那笔（多层链里两行红字冲销靠它分得出冲的是哪一笔）
      (SELECT x.date FROM fin_obligations ro JOIN fin_obligations x ON x.id=ro.reversal_of
        WHERE ro.voucher_id=v.id LIMIT 1) AS red_target_date,
      (SELECT ${isRerecorded('x')} FROM fin_obligations ro JOIN fin_obligations x ON x.id=ro.reversal_of
        WHERE ro.voucher_id=v.id LIMIT 1) AS red_target_rerecorded,
      c.kind AS cash_kind,c.date AS cash_date,c.amount_cents AS cash_total,
      EXISTS(SELECT 1 FROM fin_allocations a WHERE a.voucher_id=v.id AND a.initial=1) AS cash_initial,
      (SELECT oc.date FROM fin_cash_documents oc WHERE ov.module_source='cash' AND oc.id=ov.module_id) AS red_cash_date
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id LEFT JOIN fin_vouchers ov ON ov.id=v.reversal_of
      LEFT JOIN fin_cash_documents c ON v.module_source='cash' AND c.id=v.module_id
      WHERE v.status='posted' AND ${onAccount('e')} AND e.auxiliary_kind=? AND e.auxiliary_id=?
      AND v.date BETWEEN ? AND ?
      UNION ALL SELECT o.voucher_id,o.date,NULL,0,o.description,o.due_date,o.amount_cents,o.reversal_of IS NOT NULL,0,
        ${isRerecorded('o')},
        CASE WHEN o.reversal_of IS NULL THEN (SELECT ${snapshotNumber('ev.snapshot')}
          FROM fin_events ev WHERE ev.id=o.event_id) END,
        CASE WHEN o.reversal_of IS NOT NULL THEN ${reversedDocument('o')} END,NULL,NULL,NULL,NULL,
        (SELECT x.description FROM fin_obligations x WHERE x.id=o.reversal_of),
        CASE WHEN ${inChain('o')} THEN ${chainRoot('o')} END,o.id,NULL,0,
        (SELECT x.date FROM fin_obligations x WHERE x.id=o.reversal_of),
        (SELECT ${isRerecorded('x')} FROM fin_obligations x WHERE x.id=o.reversal_of),
        NULL,NULL,NULL,0,NULL
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind=? AND o.party_id=? AND o.opening_id IS NULL AND o.tax_status<>'superseded'
        AND (o.voucher_id IS NULL OR (v.status<>'posted' AND v.status<>'void' AND o.event_id IS NOT NULL))
        AND o.date BETWEEN ? AND ?)
      WINDOW chain AS (PARTITION BY grp ORDER BY chain_pos,date,voucher_id,position))
      ORDER BY group_date,group_voucher,grp,chain_pos,date,voucher_id,position`;
}
