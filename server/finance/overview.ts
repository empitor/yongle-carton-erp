import { z } from 'zod';
import { today, dateSchema } from '../../shared/core/index.js';
import { periodSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { count, many, one, rows } from '../core/index.js';
import { financeActor } from './core.js';
import { periodOf } from './days.js';
import { FinanceMonthly } from './monthly.js';
import { id, pageSql } from './query.js';
import { isRerecorded, reversalState } from './reversal-pairs.js';
import { allocationSum, dueItems } from './obligation-sql.js';
import { snapshotLines } from './source-snapshot.js';
import { endOfMonth } from './periods.js';

/** 一张单据（或一张订单下的单据）的财务记录一行：财务事件，和它挂的往来、已收付、冲销关系、收付款（JSON 文字） */
const relatedRow = z.object({
  id: z.number(),
  source_id: z.string(),
  date: z.string(),
  status: z.string(),
  voucher_id: z.number().nullable(),
  problem: z.string().nullable(),
  amount_cents: z.number().nullable(),
  obligation_id: z.number().nullable(),
  obligation_amount: z.number().nullable(),
  due_date: z.string().nullable(),
  obligation_date: z.string().nullable(),
  rerecorded: z.number(),
  paid: z.number(),
  reversal_state: z.string().nullable(),
  receipts: z.string(),
});
const obligationKind = rows.fin_obligations.shape.kind;
/** 已过期还没收（付）的，按应收、应付合计 */
const overdueRow = z.object({ kind: obligationKind, count: z.number(), amount: z.number() });
/** 资金账户一行：账户加截至那天的余额（期初加已记账发生额） */
const account = rows.fin_cash_accounts.shape;
const cashAccountRow = z.object({
  id: account.id,
  name: account.name,
  kind: account.kind,
  last_four: account.last_four,
  account_code: account.account_code,
  balance: z.number(),
});
const latestPeriod = z.object({ period: z.string().nullable() });
/** 这个月的往来按应收、应付合计：金额和截至月底已收付 */
const monthSum = z.object({ kind: obligationKind, amount: z.number(), paid: z.number() });

export class FinanceOverview {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  summary(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ date: dateSchema.default(() => today()) }).parse(raw);
    const events = count(
      this.db,
      `SELECT count(*) FROM fin_events
      WHERE status IN ('ready','info_pending','difference','source_deleted','cost_pending','waiting_invoice','awaiting_allocation_reversal')`,
    );
    const pendingApproval = count(this.db, "SELECT count(*) FROM fin_vouchers WHERE status='pending'");
    const overdue = many(
      this.db,
      overdueRow,
      `SELECT kind,count(*) AS count,sum(balance) AS amount FROM (${dueItems})
      WHERE date<=? AND due_date<? AND balance>0 GROUP BY kind`,
      q.date,
      q.date,
    );
    const accounts = many(
      this.db,
      cashAccountRow,
      `SELECT a.id,a.name,a.kind,a.last_four,a.account_code,coalesce((
      SELECT sum(debit-credit) FROM fin_opening WHERE account_code=a.account_code AND auxiliary_id IS NULL),0)+coalesce((
      SELECT sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END))
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.date<=?
      AND e.account_code=a.account_code),0) AS balance FROM fin_cash_accounts a ORDER BY a.id`,
      q.date,
    );
    const period = periodOf(q.date);
    const current = one(this.db, rows.fin_periods, 'SELECT * FROM fin_periods WHERE period=?', period) ?? null;
    const latestClosed =
      one(this.db, latestPeriod, "SELECT max(period) AS period FROM fin_periods WHERE status='closed'")?.period ?? null;
    return { events, pendingApproval, overdue, accounts, period, current, latestClosed };
  }
  related(actor: Actor | null, rawKind: unknown, rawId: unknown, raw: unknown) {
    financeActor(actor);
    const kind = z.enum(['orders', 'delivery', 'arrival']).parse(rawKind),
      key = id.parse(rawId);
    return pageSql(
      this.db,
      {
        schema: relatedRow,
        sql: `SELECT e.id,e.source_id,e.date,e.status,e.voucher_id,e.problem,e.amount_cents,
      o.id AS obligation_id,o.amount_cents AS obligation_amount,o.due_date,
      -- 往来自己的日期：红字冲销、重记的那笔是冲销、重记那天，不是原单日期（e.date 只用来排序）
      o.date AS obligation_date,${isRerecorded('o')} AS rerecorded,
      ${allocationSum('a.obligation_id=o.id', true)} AS paid,${reversalState('o')} AS reversal_state,
      (SELECT json_group_array(json_object('cashId',a.cash_id,'amount',a.amount_cents,'date',a.date))
        FROM fin_allocations a JOIN fin_vouchers v ON v.id=a.voucher_id
        WHERE a.obligation_id=o.id AND v.status='posted' AND a.status IN ('active','reversing')) AS receipts
      FROM fin_events e LEFT JOIN fin_obligations o ON o.event_id=e.id AND o.tax_status<>'superseded'
        AND (o.reversal_of IS NULL OR EXISTS(SELECT 1 FROM fin_vouchers rv WHERE rv.id=o.voucher_id AND rv.status<>'void'))
      WHERE e.source_kind=? AND e.status<>'superseded' AND (${
        kind === 'orders'
          ? `EXISTS(SELECT 1 FROM ${snapshotLines('e.snapshot')} l WHERE json_extract(l.value,'$.orderId')=?)`
          : 'e.source_id=?'
      })`,
        values: [kind === 'arrival' ? 'arrival' : 'delivery', kind === 'orders' ? key : String(key)],
        order: 'date,id,obligation_id',
      },
      // 按先后排：原来那笔、红字冲销、重记的那笔依次往下
      { ...(raw && typeof raw === 'object' ? raw : {}), sort: 'oldest' },
    );
  }
  monthlyLedger(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    const monthly = new FinanceMonthly(this.store),
      m = monthly.get(actor, { period });
    const sums = many(
      this.db,
      monthSum,
      `SELECT kind,sum(o.amount_cents) AS amount,
      sum(${allocationSum('a.obligation_id=o.id AND a.date<=?', true)}) AS paid
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.date BETWEEN ? AND ? AND (o.voucher_id IS NULL OR v.status<>'void') AND tax_status<>'superseded' GROUP BY kind`,
      endOfMonth(period),
      period + '-01',
      endOfMonth(period),
    );
    const value = (kind: string) => sums.find((s) => s.kind === kind);
    const ar = value('receivable'),
      ap = value('payable');
    return {
      ...monthly.detail(actor, raw),
      summary: {
        ...m,
        receivable: ar?.amount ?? 0,
        receivablePaid: ar?.paid ?? 0,
        receivableRemaining: (ar?.amount ?? 0) - (ar?.paid ?? 0),
        payable: ap?.amount ?? 0,
        payablePaid: ap?.paid ?? 0,
        payableRemaining: (ap?.amount ?? 0) - (ap?.paid ?? 0),
      },
    };
  }
}
