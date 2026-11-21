/**
 * 月度台账的明细从哪来：送货、到货的财务事件（还没同步的按页面传进来的算），收付款核销、没核销的收付款、
 * 直接记在资金科目上的凭证分录，现结优惠、压款利息、保证金和退回，接单（不算待确认、已取消）。每一路查成同样的 13 列，合在一起。
 * 参数用 monthlyAllParams、monthlyObservedParams 排。
 */
import { z } from 'zod';
import { isReversed } from './reversal-pairs.js';
import { allocationSum, voucherReversed } from './obligation-sql.js';
import { sourceConfirmed } from './business-source.js';
import { uncountedOrderStatuses } from '../../shared/core/index.js';

const cashSign =
  "CASE WHEN c.kind IN ('receipt','income') THEN 'actualIncome' ELSE 'actualExpense' END";
// 来源单对应的往来单按“没被更正冲销、不是冲销行、没被替换、凭证没作废”认，不看金额：
// 整张红票冲减后往来金额为 0，按金额大于 0 找会找不到，已收付就显示成 0。
const eventSql = `SELECT CASE WHEN e.source_kind='delivery' THEN 'theoreticalIncome' ELSE 'theoreticalExpense' END AS metric,
  e.id AS id,e.date,substr(e.date,1,7) AS source_month, e.source_id AS source_id,
  coalesce(e.source_number,e.source_id) AS number,
  e.party_name AS party,
  e.theoretical_cents AS amount,
  e.snapshot AS detail,e.status, o.due_date, coalesce(${allocationSum('a.obligation_id=o.id', true)},0) AS paid,
  CASE WHEN e.status='info_pending' AND e.missing_tax=1 THEN 1 ELSE 0 END AS missing_tax
  FROM fin_source_observations obs JOIN fin_events e ON e.id=obs.event_id
  LEFT JOIN fin_obligations o ON o.id=(SELECT max(x.id) FROM fin_obligations x LEFT JOIN fin_vouchers xv ON xv.id=x.voucher_id
    WHERE x.event_id=e.id AND x.reversal_of IS NULL AND x.tax_status<>'superseded' AND (x.voucher_id IS NULL OR xv.status<>'void')
    AND NOT ${isReversed('x')})
  WHERE e.source_kind IN ('delivery','arrival') AND obs.status='confirmed'
  AND e.status NOT IN ('before_opening','source_deleted','corrected')
  AND e.id NOT IN (SELECT value FROM json_each(?))
  AND ${sourceConfirmed('e')}`;
const allocationRows = `SELECT ${cashSign} AS metric,c.id,c.date,substr(o.date,1,7) AS source_month,
  e.source_id AS source_id,CAST(c.id AS TEXT) AS number,c.party_name AS party,
  a.amount_cents-a.discount_cents AS amount,
  json_object('cashId',c.id,'cashKind',c.kind,'cashDate',c.date,'cashTotal',c.amount_cents,
    'allocationId',a.id,'obligationId',o.id,'eventId',o.event_id,'discount',a.discount_cents,
    'source',json(e.snapshot)) AS detail,c.status,o.due_date,
  a.amount_cents-a.discount_cents AS paid,0 AS missing_tax
  FROM fin_allocations a JOIN fin_cash_documents c ON c.id=a.cash_id
  JOIN fin_obligations o ON o.id=a.obligation_id JOIN fin_vouchers av ON av.id=a.voucher_id
  LEFT JOIN fin_events e ON e.id=o.event_id WHERE c.status='confirmed' AND av.status<>'void' AND (a.status IN ('active','reversing') OR
    (a.status='revoked' AND EXISTS(SELECT 1 FROM fin_allocations r WHERE r.reversal_of=a.id)))`;
const cashSql = `SELECT ${cashSign} AS metric,c.id,c.date,
  CASE WHEN c.kind IN ('income','outlay') THEN substr(coalesce(ex.date,c.date),1,7)
    WHEN EXISTS(SELECT 1 FROM fin_obligations o WHERE o.party_id=c.party_id AND o.date<=c.date
      AND o.kind=CASE WHEN c.kind='receipt' THEN 'receivable' ELSE 'payable' END) THEN 'unallocated'
    ELSE 'advance' END AS source_month,
  NULL AS source_id,CAST(c.id AS TEXT) AS number,c.party_name AS party,
  c.amount_cents-${allocationSum('a.cash_id=c.id')} AS amount,
  json_object('cashId',c.id,'cashKind',c.kind,'cashDate',c.date,'cashTotal',c.amount_cents,
    'expenseId',ex.id,'description',c.description) AS detail,
  c.status,NULL AS due_date,c.amount_cents AS paid,0 AS missing_tax
  FROM fin_cash_documents c LEFT JOIN fin_expenses ex ON ex.cash_id=c.id
  WHERE c.kind<>'transfer' AND c.status='confirmed'`;
const ledgerCash = `SELECT CASE WHEN direction>0 THEN 'actualIncome' ELSE 'actualExpense' END,id,date,substr(source_date,1,7),
  NULL,cast(number AS TEXT),NULL,abs(direction)*sign,
  json_object('voucherId',id,'reversalOf',reversal_of,'entry',position,'description',description),
  'posted',NULL,abs(direction)*sign,0 FROM (
    SELECT v.id,v.number,v.date,e.position,e.description,v.reversal_of,coalesce(original.date,v.date) AS source_date,
      e.debit-e.credit AS direction,CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END AS sign
    FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id LEFT JOIN fin_vouchers original ON original.id=v.reversal_of
    JOIN fin_accounts a ON a.code=e.account_code WHERE v.status='posted'
      AND coalesce(v.module_source,original.module_source,'') NOT IN ('cash','deposit')
      AND coalesce(e.cash_flow,'')<>'内部转账'
      AND (a.cash_kind IS NOT NULL OR EXISTS(SELECT 1 FROM fin_cash_accounts ca WHERE ca.account_code=e.account_code)))`;
const supplementary = `
  SELECT CASE WHEN c.kind='receipt' THEN 'discountExpense' ELSE 'discountIncome' END,
    a.id,a.date,substr(o.date,1,7),e.source_id,cast(a.id AS TEXT),o.party_name,a.discount_cents,
    json_object('obligationId',o.id,'cashId',c.id,'cashKind',c.kind,'cashDate',c.date,'cashTotal',c.amount_cents,
      'reason',a.discount_reason),'posted',o.due_date,0,0
    FROM fin_allocations a JOIN fin_vouchers v ON v.id=a.voucher_id JOIN fin_cash_documents c ON c.id=a.cash_id
    JOIN fin_obligations o ON o.id=a.obligation_id LEFT JOIN fin_events e ON e.id=o.event_id
    WHERE a.discount_cents<>0 AND v.status='posted'
  UNION ALL
  SELECT CASE WHEN o.kind='receivable' THEN 'interestIncome' ELSE 'interestExpense' END,
    i.id,i.date,substr(o.date,1,7),NULL,cast(i.id AS TEXT),o.party_name,i.amount_cents,
    json_object('obligationId',o.id,'reason',i.reason,'recordKind','interest','recordDate',i.date,'recordTotal',i.amount_cents),
    'posted',o.due_date,0,0 FROM fin_interest i
    JOIN fin_obligations o ON o.id=i.obligation_id JOIN fin_vouchers v ON v.id=i.voucher_id WHERE v.status='posted' AND NOT ${voucherReversed('v', true)}
  UNION ALL
  SELECT CASE WHEN d.kind='received' THEN 'depositIncome' ELSE 'depositExpense' END,
    d.id,d.date,substr(d.date,1,7),NULL,cast(d.id AS TEXT),d.party_name,d.amount_cents,
    json_object('description',d.description,'recordKind','deposit','recordDate',d.date,'recordTotal',d.amount_cents),
    'posted',NULL,0,0 FROM fin_deposits d
    JOIN fin_vouchers v ON v.id=d.voucher_id WHERE v.status='posted' AND NOT ${voucherReversed('v', true)}
  UNION ALL
  SELECT CASE WHEN d.kind='paid' THEN 'depositIncome' ELSE 'depositExpense' END,
    a.id,a.date,substr(d.date,1,7),NULL,cast(a.id AS TEXT),d.party_name,a.amount_cents,
    json_object('depositId',d.id,'actionId',a.id,'recordKind','deposit_refund','recordDate',a.date,'recordTotal',a.amount_cents),
    'posted',NULL,0,0 FROM fin_deposit_actions a
    JOIN fin_deposits d ON d.id=a.deposit_id JOIN fin_vouchers v ON v.id=a.voucher_id WHERE v.status='posted' AND NOT ${voucherReversed('v', true)} AND a.kind='refund'
  UNION ALL
  SELECT 'ordered',id,order_date,substr(order_date,1,7),cast(id AS TEXT),number,customer_name,total_cents,
    json_object('orderId',id),status,NULL,0,0 FROM orders WHERE status NOT IN (${uncountedOrderStatuses.map(() => '?').join(',')})`;
const unsyncedSql = `SELECT CASE WHEN json_extract(u.value,'$.source_kind')='delivery' THEN 'theoreticalIncome' ELSE 'theoreticalExpense' END,
  json_extract(u.value,'$.id'),json_extract(u.value,'$.date'),substr(json_extract(u.value,'$.date'),1,7),
  json_extract(u.value,'$.source_id'),coalesce(json_extract(u.value,'$.number'),json_extract(u.value,'$.source_id')),
  json_extract(u.value,'$.party'),
  json_extract(u.value,'$.theoretical'),json_extract(u.value,'$.snapshot'),json_extract(u.value,'$.status'),NULL,0,
  EXISTS(SELECT 1 FROM json_each(u.value,'$.missing') WHERE value='tax') FROM json_each(?) u`;
export const monthlyAll = `${eventSql} UNION ALL ${unsyncedSql} UNION ALL ${allocationRows} UNION ALL ${cashSql} UNION ALL ${ledgerCash} UNION ALL ${supplementary}`;
export const monthlyObserved = `${eventSql} UNION ALL ${allocationRows} UNION ALL ${cashSql} UNION ALL ${ledgerCash} UNION ALL ${supplementary}`;
const replacedEvents = (pending: { id: number | null }[]) =>
  JSON.stringify(pending.flatMap((row) => row.id === null ? [] : [row.id]));
/**
 * 两份查询的参数，按 SQL 里 ? 的先后：被还没同步的单据替掉的事件、（monthlyAll 才有）还没同步的单据，
 * 最后是接单不算的订单状态（待确认、已取消，和今日页、经营概况同一份清单）。接在后面的条件参数由调用方再加。
 */
export const monthlyAllParams = (pending: { id: number | null }[]) => [replacedEvents(pending), JSON.stringify(pending), ...uncountedOrderStatuses];
export const monthlyObservedParams = (pending: { id: number | null }[]) => [replacedEvents(pending), ...uncountedOrderStatuses];
/** 月度台账明细一行（各来源合在一起）：哪项、编号、日期、来源月份、单号、往来单位、金额、明细 JSON、状态、到期日、已收付、是否缺税率 */
export const detailRow = z.object({
  metric: z.string(),
  id: z.number().nullable(),
  date: z.string(),
  source_month: z.string().nullable(),
  source_id: z.string().nullable(),
  number: z.string().nullable(),
  party: z.string().nullable(),
  amount: z.number().nullable(),
  detail: z.string(),
  status: z.string(),
  due_date: z.string().nullable(),
  paid: z.number(),
  missing_tax: z.number(),
});
