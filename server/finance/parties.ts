import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import {
  accountCodeSchema,
  centsSchema,
  requestIdSchema,
  versionSchema,
} from '../../shared/finance.js';
import { dateSchema, today } from '../../shared/domain.js';
import { FinanceLedger } from './ledger.js';
import { allocationSum } from './settlements.js';
import { dueDate, installments, termOptions } from './terms.js';
import { edit, entry, id, label, money, pageSql, request, row } from './query.js';
import { openItems } from './due.js';
import { clampPage, parsePaging } from '../paging.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';

const partyKind = z.enum(['customer', 'supplier']);
const kind = z.enum(['receivable', 'payable']);
const terms = z
  .strictObject({
    kind: partyKind,
    partyId: z.number().int().positive(),
    termType: z.enum(['days', 'monthly']).default('days'),
    termDays: z.number().int().min(0).max(3650).optional(),
    termMonths: z.number().int().min(0).max(120).optional(),
    paymentDay: z.number().int().min(1).max(31).optional(),
    cutoffDay: z.number().int().min(1).max(31).nullable().default(null),
    options: termOptions.optional(),
    creditLimit: centsSchema.nullable().default(null),
    taxRate: z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,6})?%?$/)
      .refine((v) => Number(v.replace(/%$/, '')) <= 100)
      .nullable()
      .optional(),
    taxMode: z.enum(['含税', '未税', '不含税']).nullable().optional(),
    version: versionSchema.optional(),
    requestId: requestIdSchema,
  })
  .refine(
    (v) =>
      v.termType === 'days'
        ? v.termDays !== undefined
        : v.termMonths !== undefined && v.paymentDay !== undefined,
    '请完整填写按天或月结账期。',
  );

export class FinanceParties {
  constructor(private readonly store: Store) {}
  badDebt(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        kind: z.enum(['writeoff', 'provision']),
        date: dateSchema,
        amount: money,
        reason: label,
        counterAccount: accountCodeSchema.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'bad-debt', { ...v, key }, () => {
      const db = this.store.db;
      const before = db
        .prepare('SELECT * FROM (' + openItems + ") WHERE id=? AND kind='receivable'")
        .get(key);
      if (
        !before ||
        Number(before.balance) < v.amount ||
        v.date < String(before.date) ||
        !before.voucher_id
      )
        financeError('坏账须对应有效往来单及可核销余额。');
      checkVersion(before, v.version);
      const ledger = new FinanceLedger(this.store);
      if (ledger.get(user, before.voucher_id).header.status !== 'posted')
        financeError('往来凭证尚未记账。');
      if (v.kind === 'provision' && !v.counterAccount) financeError('计提坏账须明确备抵科目。');
      const fee = JSON.parse(
        String(
          db.prepare("SELECT mapping FROM fin_templates WHERE name='bad_debt'").get()!.mapping,
        ),
      ).expense;
      const aux = {
        kind: 'customer' as const,
        id: String(before.party_id),
        name: String(before.party_name),
      };
      const entries =
        v.kind === 'provision'
          ? [entry(fee, v.amount, 0), entry(v.counterAccount!, 0, v.amount)]
          : [entry(v.counterAccount ?? fee, v.amount, 0), entry('1122', 0, v.amount, aux)];
      const voucher = ledger.createLinked(user, 'bad_debt', key, {
        requestId: v.requestId,
        date: v.date,
        description: v.reason,
        entries,
      });
      const adjustment = Number(
        db
          .prepare(
            'INSERT INTO fin_bad_debts(obligation_id,kind,date,amount_cents,reason,voucher_id) VALUES(?,?,?,?,?,?)',
          )
          .run(key, v.kind, v.date, v.amount, v.reason, voucher.header.id).lastInsertRowid,
      );
      db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(key);
      const after = row(db, 'fin_bad_debts', adjustment);
      financeAudit(this.store, user, v.kind, 'fin_bad_debts', adjustment, null, after);
      return after;
    });
  }
  getTerms(actor: Actor | null, rawKind: unknown, rawId: unknown) {
    financeActor(actor);
    const found = this.store.db
      .prepare('SELECT * FROM fin_party_terms WHERE kind=? AND party_id=?')
      .get(partyKind.parse(rawKind), String(id.parse(rawId)));
    return found
      ? { ...found, options: termOptions.parse(JSON.parse(String(found.options))) }
      : null;
  }

  terms(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ kind: partyKind.optional(), partyId: z.string().max(100).optional() })
      .parse(raw);
    return pageSql(
      this.store.db,
      `SELECT t.*,coalesce((SELECT sum(o.amount_cents-${allocationSum('a.obligation_id=o.id', true)})
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind='receivable' AND o.party_id=t.party_id AND (o.opening_id IS NOT NULL OR v.status='posted')),0) AS receivable
      FROM fin_party_terms t WHERE (? IS NULL OR t.kind=?) AND (? IS NULL OR t.party_id=?)`,
      [q.kind ?? null, q.kind ?? null, q.partyId ?? null, q.partyId ?? null],
      raw,
      'party_id',
    );
  }

  create(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        kind,
        partyId: id,
        date: dateSchema,
        dueDate: dateSchema.nullable().optional(),
        amount: money,
        description: label,
        counterAccount: accountCodeSchema,
      })
      .parse(raw);
    if (v.dueDate && v.dueDate < v.date) financeError('到期日不得早于单据日期。');
    return financeWrite(this.store, user, 'obligations.create', v, () => {
      const db = this.store.db,
        ar = v.kind === 'receivable';
      const party = row(db, ar ? 'customers' : 'suppliers', v.partyId);
      const terms = db
        .prepare('SELECT * FROM fin_party_terms WHERE kind=? AND party_id=?')
        .get(ar ? 'customer' : 'supplier', String(v.partyId));
      const due = v.dueDate === undefined ? dueDate(v.date, terms) : v.dueDate;
      const name = String(party.name),
        account = ar ? '1122' : '2202';
      if (v.counterAccount.startsWith(account)) financeError('对方科目须与往来科目不同。');
      const aux = {
        kind: ar ? ('customer' as const) : ('supplier' as const),
        id: String(v.partyId),
        name,
      };
      const key = Number(
        db
          .prepare(
            `INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,amount_cents,description,terms_snapshot)
        VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            v.kind,
            aux.id,
            name,
            v.date,
            due,
            v.amount,
            v.description,
            terms ? JSON.stringify(terms) : null,
          ).lastInsertRowid,
      );
      for (const item of installments(v.amount, v.date, terms))
        db.prepare(
          'INSERT INTO fin_installments(obligation_id,position,due_date,amount_cents) VALUES(?,?,?,?)',
        ).run(key, item.position, item.due, item.amount);
      const entries = ar
        ? [entry(account, v.amount, 0, aux), entry(v.counterAccount, 0, v.amount)]
        : [entry(v.counterAccount, v.amount, 0), entry(account, 0, v.amount, aux)];
      const voucher = new FinanceLedger(this.store).createLinked(user, 'obligation', key, {
        entries,
        date: v.date,
        description: v.description,
        requestId: v.requestId,
      });
      db.prepare('UPDATE fin_obligations SET voucher_id=? WHERE id=?').run(voucher.header.id, key);
      const after = row(db, 'fin_obligations', key);
      financeAudit(this.store, user, 'create', 'fin_obligations', key, null, after);
      return after;
    });
  }

  aging(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        kind,
        date: dateSchema.default(() => today()),
        overdue: z.enum(['1', '0']).optional(),
        basis: z.enum(['document', 'due']).default('document'),
      })
      .parse(raw);
    const db = this.store.db,
      bands = JSON.parse(
        String(db.prepare('SELECT aging_days FROM fin_settings WHERE id=1').get()!.aging_days),
      ) as number[];
    const sql = `SELECT o.*, o.amount_cents-${allocationSum('a.obligation_id=o.id AND a.date<=?', true)} AS balance,
      CAST(julianday(?) - julianday(${q.basis === 'due' ? 'coalesce(o.due_date,o.date)' : 'o.date'}) AS INTEGER) AS days,
      CAST(julianday(o.due_date)-julianday(?) AS INTEGER) AS days_to_due FROM fin_obligations o
      LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE o.date<=? AND o.kind=?
      AND o.amount_cents>0 AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status='posted')
      AND o.id NOT IN (SELECT r.reversal_of FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
        WHERE r.reversal_of IS NOT NULL AND rv.status='posted' AND r.date<=?)`;
    const args = [q.date, q.date, q.date, q.date, q.kind, q.date];
    const filtered =
      `SELECT * FROM (${sql}) WHERE balance>0` + (q.overdue === '1' ? ' AND days_to_due<0' : '');
    const data = pageSql(db, filtered, args, raw, 'due_date');
    const bucket =
      'CASE WHEN days<=0 THEN 0 ' +
      bands.map((_, i) => 'WHEN days<=? THEN ' + (i + 1)).join(' ') +
      ' ELSE ' +
      (bands.length + 1) +
      ' END';
    const totals = db
      .prepare(
        'SELECT ' +
          bucket +
          ' AS bucket,sum(balance) AS balance,count(*) AS count FROM (' +
          filtered +
          ') GROUP BY bucket',
      )
      .all(...bands, ...args);
    return {
      ...data,
      bands,
      totals,
      rows: data.rows.map((r) => ({
        ...r,
        bucket:
          Number(r.days) <= 0
            ? 0
            : bands.findIndex((b) => Number(r.days) <= b) < 0
              ? bands.length + 1
              : bands.findIndex((b) => Number(r.days) <= b) + 1,
      })),
    };
  }

  saveTerms(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      input = terms.parse(raw);
    return financeWrite(this.store, user, 'terms.save', input, () => {
      const db = this.store.db;
      const table = input.kind === 'customer' ? 'customers' : 'suppliers';
      const party = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(input.partyId);
      if (!party) financeError('往来单位不存在。', 404);
      const find = db.prepare('SELECT * FROM fin_party_terms WHERE kind=? AND party_id=?');
      const id = String(input.partyId),
        before = find.get(input.kind, id);
      if (before) {
        if (input.version === undefined) financeError('账期设置已存在。', 409);
        checkVersion(before, input.version);
        db.prepare(
          `UPDATE fin_party_terms SET term_days=?,credit_limit=?,party_name=?,tax_rate=?,tax_mode=?,
          term_type=?,term_months=?,payment_day=?,cutoff_day=?,options=?,version=version+1
          WHERE kind=? AND party_id=?`,
        ).run(
          input.termDays ?? 0,
          input.creditLimit,
          party.name,
          input.taxRate === undefined ? before.tax_rate : input.taxRate,
          input.taxMode === undefined ? before.tax_mode : input.taxMode,
          input.termType,
          input.termMonths ?? null,
          input.paymentDay ?? null,
          input.cutoffDay,
          input.options ? JSON.stringify(input.options) : before.options,
          input.kind,
          id,
        );
      } else {
        if (input.version !== undefined) financeError('账期设置不存在。', 404);
        db.prepare(
          `INSERT INTO fin_party_terms(kind,party_id,party_name,term_days,credit_limit,tax_rate,tax_mode,
            term_type,term_months,payment_day,cutoff_day,options) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          input.kind,
          id,
          party.name,
          input.termDays ?? 0,
          input.creditLimit,
          input.taxRate ?? null,
          input.taxMode ?? null,
          input.termType,
          input.termMonths ?? null,
          input.paymentDay ?? null,
          input.cutoffDay,
          JSON.stringify(input.options ?? {}),
        );
      }
      const after = { ...find.get(input.kind, id)! };
      financeAudit(
        this.store,
        user,
        'save',
        'fin_party_terms',
        input.partyId,
        before ?? null,
        after,
      );
      return after;
    });
  }

  obligations(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { page: requested, pageSize } = parsePaging(raw);
    const input = z.object({ kind, partyId: z.string().max(100).optional() }).parse(raw);
    const args = [input.kind, input.partyId ?? null, input.partyId ?? null];
    const where = `FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind=? AND (? IS NULL OR o.party_id=?) AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')`;
    const db = this.store.db,
      total = Number(db.prepare('SELECT count(*) AS n ' + where).get(...args)?.n);
    const page = clampPage(requested ?? 1, pageSize, total);
    return {
      rows: db
        .prepare(
          `SELECT o.*,v.status AS voucher_status,(SELECT coalesce(json_extract(e.snapshot,'$.doc.number'),json_extract(e.snapshot,'$.doc.reference')) FROM fin_events e WHERE e.id=o.event_id) AS source_number,${allocationSum('a.obligation_id=o.id')} AS allocated,
            o.amount_cents-${allocationSum('a.obligation_id=o.id')} AS balance,
            CAST(julianday(o.due_date)-julianday(date('now','+8 hours')) AS INTEGER) AS days_to_due,
            coalesce((SELECT sum(l.amount_cents) FROM fin_invoice_links l WHERE l.obligation_id=o.id),0) AS invoiced ` +
            where +
            ' ORDER BY o.date DESC,o.id DESC LIMIT ? OFFSET ?',
        )
        .all(...args, pageSize, (page - 1) * pageSize),
      filteredRecords: total,
      page,
      pageSize,
    };
  }
}
