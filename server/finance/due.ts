import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, today, dateSchema, previewDigestSchema } from '../../shared/core/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { assertPreviewCurrent, clampPage, many, previewDigest, rows } from '../core/index.js';
import { financeActor, financeWrite, financeError, financeAudit, checkVersion } from './core.js';
import { edit, id, label, pageSql, partyKind, partyId, request, row } from './query.js';
import { dueDate, discount, installments, partyTerms, snapshotOptions, termsSnapshotText } from './terms.js';
import { DAYS_PER_YEAR, shiftDays } from './days.js';
import { dueItems, openItems } from './obligation-sql.js';
import { dueItemRow, openItemRow } from './finance-rows.js';
import { heldByParty, paymentPlan } from './due-summary.js';

const selected = z.object({ kind: partyKind, partyId });
/** 到期提醒默认往后看几天 */
const DUE_SOON_DAYS = 7;

/** 已有分期里还欠着的一期 */
const installmentDue = rows.fin_installments
  .pick({ id: true, obligation_id: true, position: true, version: true, due_date: true })
  .extend({ balance: z.number() });
/** 重算到期日改了几笔往来、几期分期 */
const recalculated = z.object({ updated: z.number(), updatedInstallments: z.number() });
/** 到期提醒一行：到期日一定有 */
const soonRow = dueItemRow.extend({ due_date: z.string(), days_to_due: z.number() });

/** 到期日记在哪张表：往来或分期 */
type DueTable = 'fin_obligations' | 'fin_installments';
/** 改一笔往来或一期分期的到期日 */
type DueUpdate<T extends DueTable> = {
  table: T;
  key: number;
  date: string | null;
  reason: string;
  /** 往来跟着记下这次按的账期（重算到期日时） */
  snapshot: string | null;
};

export class FinanceDue {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }

  preview(actor: Actor | null, raw: unknown) {
    financeActor(actor, 'finance:edit');
    const q = selected.parse(raw);
    const terms = partyTerms(this.db, q.kind === 'receivable' ? 'customer' : 'supplier', q.partyId);
    if (!terms) financeError('该往来单位尚未设账期。');
    const obligations = many(
      this.db,
      openItemRow,
      'SELECT * FROM (' + openItems + ') WHERE kind=? AND party_id=? AND balance>0 ORDER BY id',
      q.kind,
      q.partyId,
    );
    const rows = obligations
      .map((item) => ({
        id: item.id,
        before: item.due_date,
        dueDate: dueDate(item.base_date, terms),
        version: item.version,
        balance: item.balance,
      }))
      .filter((item) => item.before !== item.dueDate);
    const existing = many(
      this.db,
      installmentDue,
      `SELECT p.id,p.obligation_id,p.position,p.version,p.due_date,items.balance
      FROM (${dueItems}) items JOIN fin_installments p ON p.id=items.installment_id
      WHERE items.kind=? AND items.party_id=? AND items.balance>0 ORDER BY p.obligation_id,p.position`,
      q.kind,
      q.partyId,
    );
    const proposed = new Map(
      obligations.map((o) => [
        o.id,
        new Map(installments(o.amount_cents, o.base_date, terms).map((i) => [i.position, i.due])),
      ]),
    );
    const installmentChanges = existing.flatMap((item) => {
      const dueDate = proposed.get(item.obligation_id)?.get(item.position);
      return dueDate != null && dueDate !== item.due_date
        ? [
            {
              id: item.id,
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
      digest: previewDigest({ q, terms, rows, installmentChanges }),
    };
  }

  recalculate(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({ ...selected.shape, digest: previewDigestSchema, reason: label })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'due.recalculate', input: v, result: recalculated }, () => {
      const plan = this.preview(user, v);
      assertPreviewCurrent(v.digest, plan.digest);
      const snapshot = termsSnapshotText(plan.terms);
      for (const item of plan.rows)
        this.update(user, { table: 'fin_obligations', key: item.id, date: item.dueDate, reason: v.reason, snapshot });
      for (const item of plan.installments)
        this.update(user, { table: 'fin_installments', key: item.id, date: item.dueDate, reason: v.reason, snapshot: null });
      return { updated: plan.rows.length, updatedInstallments: plan.installments.length };
    });
  }

  /** 改一笔往来的到期日 */
  change(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ dueDate: dateSchema.nullable(), reason: label }).parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'due.change', input, result: rows.fin_obligations }, () => {
      const before = row(this.db, 'fin_obligations', key);
      checkVersion(before, v.version);
      if (v.dueDate && v.dueDate < before.date) financeError('到期日不可早于单据日期。');
      return this.update(user, { table: 'fin_obligations', key, date: v.dueDate, reason: v.reason, snapshot: null });
    });
  }

  private update<T extends DueTable>(user: Actor, change: DueUpdate<T>) {
    const { table, key, date, reason, snapshot } = change;
    const before = row(this.db, table, key);
    if (table === 'fin_obligations' && snapshot)
      this.db.prepare('UPDATE fin_obligations SET terms_snapshot=? WHERE id=?').run(snapshot, key);
    this.db
      .prepare(
        table === 'fin_obligations'
          ? 'UPDATE fin_obligations SET due_date=?,version=version+1 WHERE id=?'
          : 'UPDATE fin_installments SET due_date=?,version=version+1 WHERE id=?',
      )
      .run(date, key);
    const after = row(this.db, table, key);
    financeAudit(this.store, user, { action: 'due_change', entity: table, id: key, before, after: { ...after, reason } });
    return after;
  }

  /** 按单位的应收应付（见 due-summary.ts） */
  held(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    return heldByParty(this.db, raw);
  }

  /** 收付计划（见 due-summary.ts） */
  plan(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    return paymentPlan(this.db, raw);
  }

  soon(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        date: dateSchema.default(() => today()),
        days: z.coerce.number().int().min(0).max(DAYS_PER_YEAR).default(DUE_SOON_DAYS),
      })
      .parse(raw);
    return pageSql(
      this.db,
      {
        schema: soonRow,
        sql: `SELECT *,cast(julianday(due_date)-julianday(?) AS INTEGER) AS days_to_due
      FROM (${dueItems}) WHERE balance>0 AND date<=? AND due_date<=?`,
        values: [q.date, q.date, shiftDays(q.date, q.days)],
        order: 'due_date',
      },
      raw,
    );
  }

  discounts(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ date: dateSchema.default(() => today()), kind: partyKind.optional() })
      .parse(raw);
    const rows = many(
      this.db,
      openItemRow,
      `SELECT * FROM (${openItems}) WHERE balance>0 AND date<=?
      AND (? IS NULL OR kind=?) AND json_array_length(json_extract(terms_snapshot,'$.options.discounts'))>0
      ORDER BY date,id`.replace(
        "json_extract(terms_snapshot,'$.options.discounts')",
        "json_extract(json_extract(terms_snapshot,'$.options'),'$.discounts')",
      ),
      q.date,
      q.kind ?? null,
      q.kind ?? null,
    ).flatMap((o) => {
      const options = snapshotOptions(o.terms_snapshot, `fin_obligations.terms_snapshot（往来 ${o.id}）`);
      const offer = discount(o.base_date, o.due_date, q.date, o.balance, options);
      return offer ? [{ ...o, offer }] : [];
    });
    // 现结优惠机会是读出来逐笔算的，在这里分页（一页最多、默认几条和别的财务列表一样）
    const paging = z
      .object({ page: id.default(1), pageSize: id.max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE) })
      .parse(raw);
    const page = clampPage(paging.page, paging.pageSize, rows.length);
    return {
      rows: rows.slice((page - 1) * paging.pageSize, page * paging.pageSize),
      page,
      pageSize: paging.pageSize,
      filteredRecords: rows.length,
    };
  }
}