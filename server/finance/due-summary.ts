/**
 * 应收应付按单位的汇总（还没到期、已到期、没有账期、预收、还欠、超授信）和收付计划（按到期月份预测资金）。
 * FinanceDue.held、FinanceDue.plan 查完权限调这里。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { today, dateSchema } from '../../shared/core/index.js';
import { periodSchema } from '../../shared/finance/index.js';
import { many, one, rows } from '../core/index.js';
import { pageSql, partyKind, partyId } from './query.js';
import { periodOf } from './days.js';
import { dueItems, partyBalances } from './obligation-sql.js';
import { adjacentPeriod } from './periods.js';
import { redReleasedByObligation } from './red-invoices.js';
import { isReversed } from './reversal-pairs.js';
import { dueItemRow, expectRow, sumOf } from './finance-rows.js';

/** 收付计划默认看几个月、最多几个月 */
const PLAN_MONTHS = 6;
const PLAN_MAX_MONTHS = 24;

/** 按单位的应收应付一行：还没到期、已到期、没有账期、预收、还欠，账期几列、超授信 */
const heldRow = z.object({
  party_id: z.string(),
  party_name: z.string().nullable(),
  held: z.number(),
  due: z.number(),
  no_terms: z.number(),
  earliest_due: z.string().nullable(),
  advance: z.number(),
  net: z.number(),
  term_type: z.string().nullable(),
  term_days: z.number().nullable(),
  term_months: z.number().nullable(),
  payment_day: z.number().nullable(),
  cutoff_day: z.number().nullable(),
  credit_limit: z.number().nullable(),
  over_limit: z.number(),
});
const heldTotals = z.object({ held: z.number(), due: z.number(), no_terms: z.number(), advance: z.number(), net: z.number() });
/** 收付计划按月份和方向的合计；period 是“overdue”、到期月份，或没有账期的 null */
const planSum = z.object({ period: z.string().nullable(), kind: z.string(), amount: z.number() });
const depositBalance = z.object({ kind: z.string(), balance: z.number() });

/** 按单位的应收应付（一页）和全部单位的合计 */
export function heldByParty(db: DatabaseSync, raw: unknown) {
  // partyId：只看一个单位（助手的应收应付读工具按单位查时用）；页面不传，列全部单位
  const q = z
    .object({ kind: partyKind, date: dateSchema.default(() => today()), partyId: partyId.optional() })
    .parse(raw);
  // 还没到期、已到期、没有账期按欠款单子算（凭证没记账的单据也算、红字冲销一做就扣）；
  // 预收款（预付款）和还欠按总账算，和对账单期末同一个算法（partyBalances），还欠已扣掉预收（预付）。
  // 只有预收、没有欠款单子的单位也列出来。超授信按还欠（净额，已扣预收、预付）算，和“还欠”同一口径：
  // 对方先付的预收款抵得了授信；只付了预付款、还欠是负数的单位不算超。
  const balances = partyBalances(q.kind, q.date, false, null);
  const sql = `WITH debts AS (SELECT i.party_id,max(i.party_name) AS party_name,
    sum(CASE WHEN due_date>? THEN balance ELSE 0 END) AS held,sum(CASE WHEN due_date<=? THEN balance ELSE 0 END) AS due,
    sum(CASE WHEN due_date IS NULL THEN balance ELSE 0 END) AS no_terms,min(due_date) AS earliest_due
    FROM (${dueItems}) i WHERE i.kind=? AND i.balance>0 AND i.date<=? GROUP BY i.party_id),
    bal AS (${balances.sql})
    SELECT p.party_id,coalesce(i.party_name,b.party_name) AS party_name,
    coalesce(i.held,0) AS held,coalesce(i.due,0) AS due,coalesce(i.no_terms,0) AS no_terms,i.earliest_due,
    coalesce(b.advance,0) AS advance,coalesce(b.amount,0) AS net,
    t.term_type,t.term_days,t.term_months,t.payment_day,t.cutoff_day,t.credit_limit,
    CASE WHEN t.credit_limit IS NULL THEN 0 ELSE max(coalesce(b.amount,0)-t.credit_limit,0) END AS over_limit
    FROM (SELECT party_id FROM debts UNION SELECT party_id FROM bal WHERE amount<>0 OR advance<>0) p
    LEFT JOIN debts i ON i.party_id=p.party_id LEFT JOIN bal b ON b.party_id=p.party_id
    LEFT JOIN fin_party_terms t ON t.party_id=p.party_id AND t.kind=?
    WHERE ? IS NULL OR p.party_id=?`;
  const party = q.partyId == null ? null : String(q.partyId);
  const args = [q.date, q.date, q.kind, q.date, ...balances.args, q.kind === 'receivable' ? 'customer' : 'supplier', party, party];
  // 页顶的合计按全部单位算，不能只加当前这一页。
  const totals = expectRow(
    one(
      db,
      heldTotals,
      `SELECT coalesce(sum(held),0) AS held,coalesce(sum(due),0) AS due,
      coalesce(sum(no_terms),0) AS no_terms,coalesce(sum(advance),0) AS advance,coalesce(sum(net),0) AS net FROM (${sql})`,
      ...args,
    ),
    '应收应付合计',
  );
  // 核对往来和总账：开票确认收入没开票的部分在前三列里、不在还欠里，单独列出来（见 uninvoicedByParty）
  const uninvoiced = q.kind === 'receivable' ? uninvoicedByParty(db, q.date, party) : new Map<string, number>();
  const page = pageSql(db, { schema: heldRow, sql, values: args, order: 'party_id' }, raw);
  return {
    ...page,
    rows: page.rows.map((r) => ({ ...r, uninvoiced: uninvoiced.get(r.party_id) ?? 0 })),
    totals: {
      held: totals.held,
      due: totals.due,
      no_terms: totals.no_terms,
      advance: totals.advance,
      uninvoiced: [...uninvoiced.values()].reduce((n, v) => n + v, 0),
      net: totals.net,
    },
  };
}

/** 期初资金加截至那天已记账的资金发生额（收付计划从这个数往后滚） */
function cashBalance(db: DatabaseSync, date: string) {
  return sumOf(
    db,
    `SELECT coalesce((SELECT sum(debit-credit) FROM fin_opening o
    JOIN fin_cash_accounts a ON a.account_code=o.account_code WHERE auxiliary_id IS NULL),0)+coalesce((
    SELECT sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END))
    FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_cash_accounts a ON a.account_code=e.account_code
    WHERE v.status='posted' AND v.date<=?),0) AS n`,
    date,
  );
}

/** 还没退回、转抵的保证金（按收、付分） */
function depositBalances(db: DatabaseSync, date: string) {
  return many(
    db,
    depositBalance,
    `SELECT d.kind,sum(d.amount_cents-coalesce((SELECT sum(a.amount_cents)
    FROM fin_deposit_actions a JOIN fin_vouchers v ON v.id=a.voucher_id
    WHERE a.deposit_id=d.id AND a.date<=? AND v.status='posted'),0)) AS balance
    FROM fin_deposits d JOIN fin_vouchers v ON v.id=d.voucher_id WHERE v.status='posted' AND d.date<=? GROUP BY d.kind`,
    date,
    date,
  );
}

/** 收付计划：已逾期一行加往后几个月按到期月份的应收应付和滚出来的资金，没有账期的另列，带一页明细 */
export function paymentPlan(db: DatabaseSync, raw: unknown) {
  const q = z
    .object({
      date: dateSchema.default(() => today()),
      months: z.coerce.number().int().min(1).max(PLAN_MAX_MONTHS).default(PLAN_MONTHS),
      // 点“已逾期”一行看明细时传 overdue
      dueMonth: z.union([periodSchema, z.literal('overdue')]).optional(),
      partyId: partyId.optional(),
    })
    .parse(raw);
  const start = periodOf(q.date),
    end = adjacentPeriod(start, q.months);
  // 到期日早于今天的都算“已逾期”（和到期提醒的“逾期 N 天”同一口径），本月里已经过了到期日的也进这一行，
  // 不再算进本月；今天到期的还不算逾期，进本月。没有账期的（到期日空）单独给 noTerms，不进预测。
  const sums = many(
    db,
    planSum,
    `SELECT CASE WHEN due_date<? THEN 'overdue' ELSE substr(due_date,1,7) END AS period,kind,sum(balance) AS amount
    FROM (${dueItems}) WHERE balance>0 AND date<=? AND (due_date IS NULL OR due_date<?) GROUP BY 1,kind`,
    q.date,
    q.date,
    end,
  );
  const values = (period: string | null, kind: string) =>
    sums.filter((r) => r.kind === kind && r.period === period).reduce((n, r) => n + r.amount, 0);
  const openingCash = cashBalance(db, q.date);
  let cash = openingCash;
  const rowFor = <P extends string | null>(period: P) => ({
    period,
    receivable: values(period, 'receivable'),
    payable: values(period, 'payable'),
  });
  const forecast = ['overdue', ...Array.from({ length: q.months }, (_, i) => adjacentPeriod(start, i))].map((period) => {
    const r = rowFor(period);
    cash += r.receivable - r.payable;
    return { ...r, forecastCash: cash };
  });
  const month = q.dueMonth ?? null,
    party = q.partyId ?? null;
  return {
    openingCash,
    forecast,
    noTerms: rowFor(null),
    deposits: depositBalances(db, q.date),
    detail: pageSql(
      db,
      {
        schema: dueItemRow,
        sql: `SELECT * FROM (${dueItems})
    WHERE balance>0 AND date<=? AND (due_date IS NULL OR due_date<?)
    AND (? IS NULL OR (?='overdue' AND due_date<?) OR (substr(due_date,1,7)=? AND due_date>=?))
    AND (? IS NULL OR party_id=?)`,
        values: [q.date, end, month, month, q.date, month, q.date, party, party],
        order: 'due_date',
      },
      raw,
    ),
  };
}

const invoicedRow = rows.fin_obligations
  .pick({ id: true, party_id: true, amount_cents: true })
  .extend({ invoiced: z.number() });

/**
 * 已送货未开票：往来（按单位的前三列）和总账应收（还欠）之间的一项差额。
 * 开票确认收入的送货，往来按送货全额挂着、照样算客户欠款；总账应收只记了已开票的部分（发票凭证记的），
 * 没开票的那部分就是这个数。核对时写成：前三列 - 预收 - 已送货未开票 = 还欠（凭证都记账以后）。
 * 只算凭证已记账的：还没开票的送货（没有凭证）、凭证待记账的，按单位的还欠本来就整笔算进去，没有差额。
 * 开了多少按现在确认过的蓝票算，红票冲掉的扣回（和开票对比同一口径）；冲销掉的往来不算。
 * 应付没有这一项：到货按暂估全额进应付。
 */
function uninvoicedByParty(db: DatabaseSync, date: string, partyId: string | null) {
  const list = many(
    db,
    invoicedRow,
    `SELECT o.id,o.party_id,o.amount_cents,coalesce((SELECT sum(l.amount_cents) FROM fin_invoice_links l
        JOIN fin_invoices i ON i.id=l.invoice_id WHERE l.obligation_id=o.id AND i.status NOT IN ('draft','void')),0) AS invoiced
      FROM fin_obligations o JOIN fin_vouchers v ON v.id=o.voucher_id JOIN fin_events e ON e.id=o.event_id
      WHERE o.kind='receivable' AND e.revenue_recognition='invoice' AND v.status='posted' AND v.date<=? AND o.date<=?
        AND o.reversal_of IS NULL AND o.amount_cents>0 AND o.tax_status<>'superseded'
        AND NOT ${isReversed('o', " AND rv.status='posted' AND r.date<=?")} AND (? IS NULL OR o.party_id=?)`,
    date,
    date,
    date,
    partyId,
    partyId,
  );
  const released = redReleasedByObligation(db, list.map((r) => r.id));
  const out = new Map<string, number>();
  for (const r of list) {
    const rest = r.amount_cents - (r.invoiced - (released.get(r.id) || 0));
    if (rest) out.set(r.party_id, (out.get(r.party_id) || 0) + rest);
  }
  return out;
}
