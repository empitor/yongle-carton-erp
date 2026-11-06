import { createHash } from 'node:crypto';
import { z } from 'zod';
import { today, dateSchema } from '../../shared/domain.js';
import { periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { financeActor, financeWrite, financeError, financeAudit, checkVersion } from './core.js';
import { allocationSum } from './settlements.js';
import {
  adjacentPeriod,
  edit,
  id,
  label,
  pageSql,
  partyKind,
  partyId,
  request,
  row,
} from './query.js';
import { dueDate, shiftDays, discount, installments } from './terms.js';

export const openItems = `SELECT o.*,o.amount_cents-${allocationSum('a.obligation_id=o.id')} AS balance
  FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
  WHERE o.amount_cents>0 AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')
  AND o.id NOT IN (SELECT r.reversal_of FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
    WHERE r.reversal_of IS NOT NULL AND rv.status<>'void')`;
export const dueItems = `WITH items AS (${openItems}),
  plans AS (SELECT p.*,sum(p.amount_cents) OVER(PARTITION BY p.obligation_id ORDER BY p.due_date,p.position
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative FROM fin_installments p)
  SELECT o.id,o.kind,o.party_id,o.party_name,o.date,coalesce(p.id,0) AS installment_id,
    CASE WHEN p.id IS NULL THEN o.due_date ELSE p.due_date END AS due_date,
    CASE WHEN p.id IS NULL THEN o.balance ELSE min(p.amount_cents,max(0,p.cumulative-(o.amount_cents-o.balance))) END AS balance
  FROM items o LEFT JOIN plans p ON p.obligation_id=o.id`;
const selected = z.object({ kind: partyKind, partyId });

export class FinanceDue {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }

  preview(actor: Actor | null, raw: unknown) {
    financeActor(actor, 'finance:edit');
    const q = selected.parse(raw);
    const terms = this.db
      .prepare('SELECT * FROM fin_party_terms WHERE kind=? AND party_id=?')
      .get(q.kind === 'receivable' ? 'customer' : 'supplier', q.partyId);
    if (!terms) financeError('该往来单位尚未设账期。');
    const obligations = this.db
      .prepare(
        'SELECT * FROM (' + openItems + ') WHERE kind=? AND party_id=? AND balance>0 ORDER BY id',
      )
      .all(q.kind, q.partyId);
    const rows = obligations
      .map((item) => ({
        id: Number(item.id),
        before: item.due_date,
        dueDate: dueDate(String(item.date), terms),
        version: Number(item.version),
        balance: Number(item.balance),
      }))
      .filter((item) => item.before !== item.dueDate);
    const existing = this.db
      .prepare(
        `SELECT p.id,p.obligation_id,p.position,p.version,p.due_date,items.balance
      FROM (${dueItems}) items JOIN fin_installments p ON p.id=items.installment_id
      WHERE items.kind=? AND items.party_id=? AND items.balance>0 ORDER BY p.obligation_id,p.position`,
      )
      .all(q.kind, q.partyId);
    const proposed = new Map(
      obligations.map((o) => [
        o.id,
        new Map(
          installments(Number(o.amount_cents), String(o.date), terms).map((i) => [
            i.position,
            i.due,
          ]),
        ),
      ]),
    );
    const installmentChanges = existing.flatMap((item) => {
      const dueDate = proposed.get(item.obligation_id)?.get(Number(item.position));
      return dueDate != null && dueDate !== item.due_date
        ? [
            {
              id: Number(item.id),
              version: item.version,
              dueDate,
              before: item.due_date,
              obligationId: item.obligation_id,
              balance: item.balance,
            },
          ]
        : [];
    });
    return {
      rows,
      installments: installmentChanges,
      terms,
      digest: createHash('sha256')
        .update(JSON.stringify({ q, terms, rows, installmentChanges }))
        .digest('hex'),
    };
  }

  recalculate(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({ ...selected.shape, digest: z.string().length(64), reason: label })
      .parse(raw);
    return financeWrite(this.store, user, 'due.recalculate', v, () => {
      const plan = this.preview(user, v);
      if (plan.digest !== v.digest) financeError('规则或余额已变，请重新预览。', 409);
      for (const item of plan.rows)
        this.update(
          user,
          'fin_obligations',
          item.id,
          item.dueDate,
          v.reason,
          JSON.stringify(plan.terms),
        );
      for (const item of plan.installments)
        this.update(user, 'fin_installments', item.id, item.dueDate, v.reason, null);
      return { updated: plan.rows.length, updatedInstallments: plan.installments.length };
    });
  }

  change(actor: Actor | null, rawId: unknown, raw: unknown, installment = false) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ dueDate: dateSchema.nullable(), reason: label }).parse(raw);
    const table = installment ? 'fin_installments' : 'fin_obligations';
    return financeWrite(this.store, user, 'due.change', { ...v, key, installment }, () => {
      const before = row(this.db, table, key);
      checkVersion(before, v.version);
      const obligation = installment
        ? row(this.db, 'fin_obligations', Number(before.obligation_id))
        : before;
      if (v.dueDate && v.dueDate < String(obligation.date))
        financeError('到期日不可早于单据日期。');
      return this.update(user, table, key, v.dueDate, v.reason, null);
    });
  }

  private update(
    user: Actor,
    table: string,
    key: number,
    date: string | null,
    reason: string,
    snapshot: string | null,
  ) {
    const before = row(this.db, table, key);
    if (table === 'fin_obligations' && snapshot)
      this.db.prepare('UPDATE fin_obligations SET terms_snapshot=? WHERE id=?').run(snapshot, key);
    this.db
      .prepare('UPDATE ' + table + ' SET due_date=?,version=version+1 WHERE id=?')
      .run(date, key);
    const after = row(this.db, table, key);
    financeAudit(this.store, user, 'due_change', table, key, before, { ...after, reason });
    return after;
  }

  held(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ kind: partyKind, date: dateSchema.default(() => today()) }).parse(raw);
    return pageSql(
      this.db,
      `SELECT i.party_id,max(i.party_name) AS party_name,
      sum(CASE WHEN due_date>? THEN balance ELSE 0 END) AS held,sum(CASE WHEN due_date<=? THEN balance ELSE 0 END) AS due,
      sum(CASE WHEN due_date IS NULL THEN balance ELSE 0 END) AS no_terms,min(due_date) AS earliest_due,
      t.term_type,t.term_days,t.term_months,t.payment_day,t.cutoff_day,t.credit_limit,
      CASE WHEN t.credit_limit IS NULL THEN 0 ELSE max(sum(balance)-t.credit_limit,0) END AS over_limit
      FROM (${dueItems}) i LEFT JOIN fin_party_terms t ON t.party_id=i.party_id AND t.kind=?
      WHERE i.kind=? AND i.balance>0 AND i.date<=? GROUP BY i.party_id`,
      [q.date, q.date, q.kind === 'receivable' ? 'customer' : 'supplier', q.kind, q.date],
      raw,
      'party_id',
    );
  }

  soon(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        date: dateSchema.default(() => today()),
        days: z.coerce.number().int().min(0).max(365).default(7),
      })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT *,cast(julianday(due_date)-julianday(?) AS INTEGER) AS days_to_due
      FROM (${dueItems}) WHERE balance>0 AND date<=? AND due_date<=?`,
      [q.date, q.date, shiftDays(q.date, q.days)],
      raw,
      'due_date',
    );
  }

  plan(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        date: dateSchema.default(() => today()),
        months: z.coerce.number().int().min(1).max(24).default(6),
        dueMonth: periodSchema.optional(),
        partyId: partyId.optional(),
      })
      .parse(raw);
    const start = q.date.slice(0, 7),
      end = adjacentPeriod(start, q.months);
    const sums = this.db
      .prepare(
        `SELECT substr(due_date,1,7) AS period,kind,sum(balance) AS amount
      FROM (${dueItems}) WHERE balance>0 AND date<=? AND (due_date IS NULL OR due_date<?) GROUP BY period,kind`,
      )
      .all(q.date, end);
    const values = (period: string | null, kind: string) =>
      sums
        .filter(
          (r) =>
            r.kind === kind &&
            (period === 'overdue'
              ? r.period !== null && String(r.period) < start
              : r.period === period),
        )
        .reduce((n, r) => n + Number(r.amount), 0);
    let cash = Number(
      this.db
        .prepare(
          `SELECT coalesce((SELECT sum(debit-credit) FROM fin_opening o
      JOIN fin_cash_accounts a ON a.account_code=o.account_code WHERE auxiliary_id IS NULL),0)+coalesce((
      SELECT sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END))
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_cash_accounts a ON a.account_code=e.account_code
      WHERE v.status='posted' AND v.date<=?),0) AS n`,
        )
        .get(q.date)?.n,
    );
    const openingCash = cash;
    const rowFor = (period: string | null) => ({
      period,
      receivable: values(period, 'receivable'),
      payable: values(period, 'payable'),
    });
    const forecast = [
      'overdue',
      ...Array.from({ length: q.months }, (_, i) => adjacentPeriod(start, i)),
    ].map((period) => {
      const r = rowFor(period);
      cash += r.receivable - r.payable;
      return { ...r, forecastCash: cash };
    });
    const deposits = this.db
      .prepare(
        `SELECT d.kind,sum(d.amount_cents-coalesce((SELECT sum(a.amount_cents)
      FROM fin_deposit_actions a JOIN fin_vouchers v ON v.id=a.voucher_id
      WHERE a.deposit_id=d.id AND a.date<=? AND v.status='posted'),0)) AS balance
      FROM fin_deposits d JOIN fin_vouchers v ON v.id=d.voucher_id WHERE v.status='posted' AND d.date<=? GROUP BY d.kind`,
      )
      .all(q.date, q.date);
    return {
      openingCash,
      forecast,
      noTerms: rowFor(null),
      deposits,
      detail: pageSql(
        this.db,
        `SELECT * FROM (${dueItems})
      WHERE balance>0 AND date<=? AND (due_date IS NULL OR due_date<?) AND (? IS NULL OR substr(due_date,1,7)=?)
      AND (? IS NULL OR party_id=?)`,
        [q.date, end, q.dueMonth ?? null, q.dueMonth ?? null, q.partyId ?? null, q.partyId ?? null],
        raw,
        'due_date',
      ),
    };
  }

  discounts(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ date: dateSchema.default(() => today()), kind: partyKind.optional() })
      .parse(raw);
    const rows = this.db
      .prepare(
        `SELECT * FROM (${openItems}) WHERE balance>0 AND date<=?
      AND (? IS NULL OR kind=?) AND json_array_length(json_extract(terms_snapshot,'$.options.discounts'))>0
      ORDER BY date,id`.replace(
          "json_extract(terms_snapshot,'$.options.discounts')",
          "json_extract(json_extract(terms_snapshot,'$.options'),'$.discounts')",
        ),
      )
      .all(q.date, q.kind ?? null, q.kind ?? null)
      .flatMap((o) => {
        const snapshot = JSON.parse(String(o.terms_snapshot));
        const offer = discount(
          String(o.date),
          o.due_date as string | null,
          q.date,
          Number(o.balance),
          JSON.parse(snapshot.options),
        );
        return offer ? [{ ...o, offer }] : [];
      });
    const paging = z.object({ page: id.default(1), pageSize: id.max(200).default(50) }).parse(raw);
    const page = Math.min(paging.page, Math.max(1, Math.ceil(rows.length / paging.pageSize)));
    return {
      rows: rows.slice((page - 1) * paging.pageSize, page * paging.pageSize),
      page,
      pageSize: paging.pageSize,
      filteredRecords: rows.length,
    };
  }
}
