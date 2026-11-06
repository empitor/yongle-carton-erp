import { z } from 'zod';
import { today, dateSchema } from '../../shared/domain.js';
import { periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { financeActor } from './core.js';
import { FinanceMonthly } from './monthly.js';
import { dueItems } from './due.js';
import { allocationSum } from './settlements.js';
import { endOfMonth, id, pageSql } from './query.js';

export class FinanceOverview {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  summary(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ date: dateSchema.default(() => today()) }).parse(raw);
    const stats = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM fin_events
      WHERE status IN ('ready','info_pending','difference','source_deleted','cost_pending','waiting_invoice','awaiting_allocation_reversal')) AS events,
      (SELECT count(*) FROM fin_vouchers WHERE status='pending') AS pendingApproval`,
      )
      .get()!;
    const overdue = this.db
      .prepare(
        `SELECT kind,count(*) AS count,sum(balance) AS amount FROM (${dueItems})
      WHERE date<=? AND due_date<? AND balance>0 GROUP BY kind`,
      )
      .all(q.date, q.date);
    const accounts = this.db
      .prepare(
        `SELECT a.id,a.name,a.kind,a.last_four,a.account_code,coalesce((
      SELECT sum(debit-credit) FROM fin_opening WHERE account_code=a.account_code AND auxiliary_id IS NULL),0)+coalesce((
      SELECT sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END))
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.date<=?
      AND e.account_code=a.account_code),0) AS balance FROM fin_cash_accounts a ORDER BY a.id`,
      )
      .all(q.date);
    const period = q.date.slice(0, 7);
    const current = this.db.prepare('SELECT * FROM fin_periods WHERE period=?').get(period) ?? null;
    const latestClosed =
      this.db.prepare("SELECT max(period) AS period FROM fin_periods WHERE status='closed'").get()
        ?.period ?? null;
    return { ...stats, overdue, accounts, period, current, latestClosed };
  }
  related(actor: Actor | null, rawKind: unknown, rawId: unknown, raw: unknown) {
    financeActor(actor);
    const kind = z.enum(['orders', 'delivery']).parse(rawKind),
      key = id.parse(rawId);
    return pageSql(
      this.db,
      `SELECT e.id,e.source_id,e.date,e.status,e.voucher_id,e.problem,e.amount_cents,
      o.id AS obligation_id,o.amount_cents AS obligation_amount,o.due_date,
      ${allocationSum('a.obligation_id=o.id', true)} AS paid,
      (SELECT json_group_array(json_object('cashId',a.cash_id,'amount',a.amount_cents,'date',a.date))
        FROM fin_allocations a JOIN fin_vouchers v ON v.id=a.voucher_id
        WHERE a.obligation_id=o.id AND v.status='posted' AND a.status IN ('active','reversing')) AS receipts
      FROM fin_events e LEFT JOIN fin_obligations o ON o.event_id=e.id AND o.tax_status<>'superseded'
      WHERE e.source_kind='delivery' AND (${
        kind === 'delivery'
          ? 'e.source_id=?'
          : "EXISTS(SELECT 1 FROM json_each(e.snapshot,'$.doc.lines') l WHERE json_extract(l.value,'$.orderId')=?)"
      })`,
      [kind === 'delivery' ? String(key) : key],
      raw,
      'date',
    );
  }
  flow(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    const monthly = new FinanceMonthly(this.store),
      m = monthly.get(actor, { period });
    const sums = this.db
      .prepare(
        `SELECT kind,sum(o.amount_cents) AS amount,
      sum(${allocationSum('a.obligation_id=o.id AND a.date<=?', true)}) AS paid
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.date BETWEEN ? AND ? AND (o.voucher_id IS NULL OR v.status<>'void') AND tax_status<>'superseded' GROUP BY kind`,
      )
      .all(endOfMonth(period), period + '-01', endOfMonth(period));
    const value = (kind: string) => sums.find((s) => s.kind === kind);
    const ar = value('receivable'),
      ap = value('payable');
    return {
      ...monthly.detail(actor, raw),
      summary: {
        ...m,
        receivable: ar?.amount ?? 0,
        receivablePaid: ar?.paid ?? 0,
        receivableRemaining: Number(ar?.amount ?? 0) - Number(ar?.paid ?? 0),
        payable: ap?.amount ?? 0,
        payablePaid: ap?.paid ?? 0,
        payableRemaining: Number(ap?.amount ?? 0) - Number(ap?.paid ?? 0),
      },
    };
  }
}
