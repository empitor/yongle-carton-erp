import { z } from 'zod';
import { periodSchema } from '../../shared/finance.js';
import { today } from '../../shared/domain.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { financeActor } from './core.js';
import { allocationSum } from './settlements.js';
import { FinanceEvents } from './events.js';
import { adjacentPeriod, endOfMonth, pageSql } from './query.js';

const metrics = [
  'theoreticalIncome',
  'theoreticalExpense',
  'actualIncome',
  'actualExpense',
  'discountIncome',
  'discountExpense',
  'interestIncome',
  'interestExpense',
  'depositIncome',
  'depositExpense',
  'ordered',
] as const;
const filters = z.object({
  period: periodSchema,
  metric: z.enum(metrics).optional(),
  sourceMonth: z.string().max(20).optional(),
  missingTax: z.enum(['0', '1']).optional(),
});
const cashSign =
  "CASE WHEN c.kind IN ('receipt','income') THEN 'actualIncome' ELSE 'actualExpense' END";
const eventSql = `SELECT CASE WHEN e.source_kind='delivery' THEN 'theoreticalIncome' ELSE 'theoreticalExpense' END AS metric,
  e.id AS id,e.date,substr(e.date,1,7) AS source_month, e.source_id AS source_id,
  coalesce(json_extract(e.snapshot,'$.doc.number'),json_extract(e.snapshot,'$.doc.reference'),e.source_id) AS number,
  coalesce(json_extract(e.snapshot,'$.doc.customerName'),json_extract(e.snapshot,'$.doc.supplierName')) AS party,
  coalesce(json_extract(e.snapshot,'$.theoretical.gross'),
    CASE WHEN json_type(e.snapshot,'$.financialLines') IS NULL AND e.event_type='delivery.confirmed'
      AND json_extract(e.snapshot,'$.doc.lines[0].taxMode') IN ('未税','不含税') THEN json_extract(e.snapshot,'$.money.net')
      WHEN json_type(e.snapshot,'$.financialLines') IS NULL AND e.event_type='delivery.confirmed'
      AND json_extract(e.snapshot,'$.doc.lines[0].taxMode')='含税' THEN json_extract(e.snapshot,'$.money.gross') END) AS amount,
  e.snapshot AS detail,e.status, o.due_date, coalesce(${allocationSum('a.obligation_id=o.id', true)},0) AS paid,
  CASE WHEN e.status='info_pending' AND EXISTS(SELECT 1 FROM json_each(e.snapshot,'$.missing') WHERE value='tax') THEN 1 ELSE 0 END AS missing_tax
  FROM fin_source_observations obs JOIN fin_events e ON e.id=obs.event_id
  LEFT JOIN fin_obligations o ON o.id=(SELECT max(id) FROM fin_obligations WHERE event_id=e.id AND amount_cents>0 AND tax_status<>'superseded')
  WHERE e.source_kind IN ('delivery','arrival','legacy_arrival') AND obs.status='confirmed'
  AND e.status NOT IN ('before_opening','source_deleted','corrected')
  AND e.id NOT IN (SELECT value FROM json_each(?))
  AND (CASE WHEN e.source_kind='legacy_arrival' THEN EXISTS(SELECT 1 FROM purchase_receipts p
    WHERE p.id=e.source_id AND coalesce(json_extract(p.document,'$.reversed'),0)=0 AND json_extract(p.document,'$.replacedBy') IS NULL)
    ELSE EXISTS(SELECT 1 FROM flow_documents f WHERE f.id=cast(e.source_id AS INTEGER) AND f.kind=e.source_kind AND f.status='confirmed') END)`;
const allocationRows = `SELECT ${cashSign} AS metric,c.id,c.date,substr(o.date,1,7) AS source_month,
  e.source_id AS source_id,CAST(c.id AS TEXT) AS number,c.party_name AS party,
  a.amount_cents-a.discount_cents AS amount,
  json_object('cashId',c.id,'allocationId',a.id,'obligationId',o.id,'eventId',o.event_id,'discount',a.discount_cents,
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
  json_object('cashId',c.id,'expenseId',ex.id,'description',c.description) AS detail,
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
    json_object('obligationId',o.id,'cashId',c.id,'reason',a.discount_reason),'posted',o.due_date,0,0
    FROM fin_allocations a JOIN fin_vouchers v ON v.id=a.voucher_id JOIN fin_cash_documents c ON c.id=a.cash_id
    JOIN fin_obligations o ON o.id=a.obligation_id LEFT JOIN fin_events e ON e.id=o.event_id
    WHERE a.discount_cents<>0 AND v.status='posted'
  UNION ALL
  SELECT CASE WHEN o.kind='receivable' THEN 'interestIncome' ELSE 'interestExpense' END,
    i.id,i.date,substr(o.date,1,7),NULL,cast(i.id AS TEXT),o.party_name,i.amount_cents,
    json_object('obligationId',o.id,'reason',i.reason),'posted',o.due_date,0,0 FROM fin_interest i
    JOIN fin_obligations o ON o.id=i.obligation_id JOIN fin_vouchers v ON v.id=i.voucher_id WHERE v.status='posted'
  UNION ALL
  SELECT CASE WHEN d.kind='received' THEN 'depositIncome' ELSE 'depositExpense' END,
    d.id,d.date,substr(d.date,1,7),NULL,cast(d.id AS TEXT),d.party_name,d.amount_cents,
    json_object('description',d.description),'posted',NULL,0,0 FROM fin_deposits d
    JOIN fin_vouchers v ON v.id=d.voucher_id WHERE v.status='posted'
  UNION ALL
  SELECT CASE WHEN d.kind='paid' THEN 'depositIncome' ELSE 'depositExpense' END,
    a.id,a.date,substr(d.date,1,7),NULL,cast(a.id AS TEXT),d.party_name,a.amount_cents,
    json_object('depositId',d.id,'actionId',a.id),'posted',NULL,0,0 FROM fin_deposit_actions a
    JOIN fin_deposits d ON d.id=a.deposit_id JOIN fin_vouchers v ON v.id=a.voucher_id WHERE v.status='posted' AND a.kind='refund'
  UNION ALL
  SELECT 'ordered',id,order_date,substr(order_date,1,7),cast(id AS TEXT),number,customer_name,total_cents,
    json_object('orderId',id),status,NULL,0,0 FROM orders WHERE status<>'已取消'`;
const unsyncedSql = `SELECT CASE WHEN json_extract(u.value,'$.source_kind')='delivery' THEN 'theoreticalIncome' ELSE 'theoreticalExpense' END,
  json_extract(u.value,'$.id'),json_extract(u.value,'$.date'),substr(json_extract(u.value,'$.date'),1,7),
  json_extract(u.value,'$.source_id'),coalesce(json_extract(u.value,'$.snapshot.doc.number'),json_extract(u.value,'$.snapshot.doc.reference'),json_extract(u.value,'$.source_id')),
  coalesce(json_extract(u.value,'$.snapshot.doc.customerName'),json_extract(u.value,'$.snapshot.doc.supplierName')),
  json_extract(u.value,'$.theoretical'),json_extract(u.value,'$.snapshot'),json_extract(u.value,'$.status'),NULL,0,
  EXISTS(SELECT 1 FROM json_each(u.value,'$.missing') WHERE value='tax') FROM json_each(?) u`;
const all = `${eventSql} UNION ALL ${unsyncedSql} UNION ALL ${allocationRows} UNION ALL ${cashSql} UNION ALL ${ledgerCash} UNION ALL ${supplementary}`;
const observed = `${eventSql} UNION ALL ${allocationRows} UNION ALL ${cashSql} UNION ALL ${ledgerCash} UNION ALL ${supplementary}`;
const replacedEvents = (pending: { id: number | null }[]) =>
  JSON.stringify(pending.flatMap((row) => row.id === null ? [] : [row.id]));
type Aggregate = { metric: string; source_month: string; amount: number | null; missing: number; count: number; missing_tax: number };
type Due = { kind: string; party_id: string; party_name: string; due: number; settled: number; outstanding: number };

export class FinanceMonthly {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  detail(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = filters.parse(raw);
    const pending = new FinanceEvents(this.store).unsynced(actor, q.period);
    const sql = `SELECT * FROM (${all}) WHERE date BETWEEN ? AND ?
      AND (? IS NULL OR metric=?) AND (? IS NULL OR source_month=?)
      AND (? IS NULL OR missing_tax=?) AND (amount IS NULL OR amount<>0)`;
    const data = pageSql(
      this.db,
      sql,
      [
        replacedEvents(pending),
        JSON.stringify(pending),
        q.period + '-01',
        endOfMonth(q.period),
        q.metric ?? null,
        q.metric ?? null,
        q.sourceMonth ?? null,
        q.sourceMonth ?? null,
        q.missingTax ?? null,
        Number(q.missingTax ?? 0),
      ],
      raw,
      'date',
    );
    return {
      ...data,
      rows: data.rows.map((row) => ({
        ...row,
        amount: row.amount,
        detail: JSON.parse(String(row.detail)) as unknown,
      })),
    };
  }
  get(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = filters.parse(raw);
    return this.range(actor, period, period, 1)[0];
  }
  private range(actor: Actor | null, first: string, last: string, months: number) {
    const pending = new FinanceEvents(this.store).unsynced(actor, first, last);
    const from = first + '-01', to = endOfMonth(last);
    const aggregates = this.db
      .prepare(
        `SELECT substr(date,1,7) AS period,metric,source_month,sum(amount) AS amount,
      sum(amount IS NULL) AS missing,count(*) AS count,sum(missing_tax) AS missing_tax
      FROM (${observed}) WHERE date BETWEEN ? AND ? GROUP BY period,metric,source_month`,
      )
      .all(replacedEvents(pending), from, to) as unknown as (Aggregate & { period: string })[];
    const byMonth = new Map<string, Map<string, Aggregate>>();
    const monthRows = (period: string) => {
      let rows = byMonth.get(period);
      if (!rows) byMonth.set(period, rows = new Map());
      return rows;
    };
    for (const { period, ...row } of aggregates) monthRows(period).set(JSON.stringify([row.metric, row.source_month]), row);
    for (const row of pending) {
      const period = row.date.slice(0, 7);
      const metric = row.source_kind === 'delivery' ? 'theoreticalIncome' : 'theoreticalExpense';
      const rows = monthRows(period);
      const key = JSON.stringify([metric, period]);
      const group = rows.get(key) ?? { metric, source_month: period, amount: null, count: 0, missing: 0, missing_tax: 0 };
      if (row.theoretical !== null) group.amount = (group.amount ?? 0) + row.theoretical;
      else group.missing++;
      group.count++;
      if (row.missing.includes('tax')) group.missing_tax++;
      rows.set(key, group);
    }
    const cutoff = "date(o.due_date,'start of month','+1 month','-1 day')";
    const due = this.db
      .prepare(
        `SELECT substr(o.due_date,1,7) AS period,o.kind,o.party_id,max(o.party_name) AS party_name,sum(o.amount_cents) AS due,
      sum(${allocationSum('a.obligation_id=o.id AND a.date<=' + cutoff, true)}) AS settled,
      sum(o.amount_cents-${allocationSum('a.obligation_id=o.id AND a.date<=' + cutoff, true)}) AS outstanding
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE due_date BETWEEN ? AND ?
      AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')
      GROUP BY period,o.kind,o.party_id`,
      )
      .all(from, to) as unknown as (Due & { period: string })[];
    const dueByMonth = new Map<string, Due[]>();
    for (const { period, ...row } of due) {
      const rows = dueByMonth.get(period);
      if (rows) rows.push(row);
      else dueByMonth.set(period, [row]);
    }
    return Array.from({ length: months }, (_, index) => {
      const period = adjacentPeriod(first, index);
      return this.result(period, [...monthRows(period).values()], dueByMonth.get(period) ?? []);
    });
  }
  private result(period: string, rows: Aggregate[], due: Due[]) {
    const totals = Object.fromEntries(
      metrics.map((metric) => [
        metric,
        rows.filter((r) => r.metric === metric).reduce((n, r) => n + Number(r.amount), 0),
      ]),
    ) as Record<(typeof metrics)[number], number>;
    return {
      period,
      ...totals,
      theoreticalProfit: totals.theoreticalIncome - totals.theoreticalExpense,
      actualProfit: totals.actualIncome - totals.actualExpense,
      missingPrice: rows.reduce((n, r) => n + Number(r.missing), 0),
      missingTax: rows.reduce((n, r) => n + Number(r.missing_tax), 0),
      sources: rows.filter(
        (r) =>
          ['actualIncome', 'actualExpense'].includes(String(r.metric)) && Number(r.amount) !== 0,
      ),
      due,
    };
  }
  trend(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        period: periodSchema.default(() => today().slice(0, 7)),
        months: z.coerce.number().int().min(1).max(24).default(12),
      })
      .parse(raw);
    return this.range(actor, adjacentPeriod(q.period, 1 - q.months), q.period, q.months);
  }
}
