import { z } from 'zod';
import { dateSchema } from '../../shared/domain.js';
import { accountCodeSchema, centsSchema, periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import {
  edit,
  endOfMonth,
  entry,
  id,
  label,
  money,
  pageSql,
  partyKind,
  request,
  row,
} from './query.js';
import { dayDistance, percentCents, shiftDays, termOptions } from './terms.js';
import { openItems } from './due.js';

export class FinanceTermOperations {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }
  private template(name: string, key: string) {
    const mapping = this.db.prepare('SELECT mapping FROM fin_templates WHERE name=?').get(name);
    return accountCodeSchema.parse(JSON.parse(String(mapping?.mapping))[key]);
  }
  private bank(key: number) {
    const a = row(this.db, 'fin_cash_accounts', key);
    if (!a.enabled) financeError('资金账户已停用。');
    return String(a.account_code);
  }
  deposits(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ kind: z.enum(['paid', 'received']).optional(), partyId: id.optional() })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT d.*,d.amount_cents-coalesce((SELECT sum(a.amount_cents)
      FROM fin_deposit_actions a WHERE a.deposit_id=d.id),0) AS balance
      FROM fin_deposits d WHERE (? IS NULL OR d.kind=?) AND (? IS NULL OR d.party_id=?)`,
      [q.kind ?? null, q.kind ?? null, q.partyId ?? null, String(q.partyId ?? '')],
      raw,
      'date',
    );
  }
  deposit(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash');
    const v = request
      .extend({
        kind: z.enum(['paid', 'received']),
        partyKind: z.enum(['customer', 'supplier']),
        partyId: id,
        accountId: id,
        date: dateSchema,
        amount: money,
        description: label,
      })
      .parse(raw);
    return financeWrite(this.store, user, 'deposit.create', v, () => {
      const party = row(this.db, v.partyKind === 'customer' ? 'customers' : 'suppliers', v.partyId);
      const key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_deposits(kind,party_kind,party_id,party_name,date,amount_cents,description)
        VALUES(?,?,?,?,?,?,?)`,
          )
          .run(v.kind, v.partyKind, String(v.partyId), party.name, v.date, v.amount, v.description)
          .lastInsertRowid,
      );
      const bank = this.bank(v.accountId),
        counter = this.template('deposit', v.kind);
      const entries =
        v.kind === 'paid'
          ? [entry(counter, v.amount, 0), entry(bank, 0, v.amount, null, '保证金支付')]
          : [entry(bank, v.amount, 0, null, '保证金收取'), entry(counter, 0, v.amount)];
      const voucher = this.ledger.createLinked(
        user,
        'deposit',
        key,
        { date: v.date, description: v.description, entries, requestId: v.requestId },
        'finance:cash',
      );
      this.db
        .prepare('UPDATE fin_deposits SET voucher_id=? WHERE id=?')
        .run(voucher.header.id, key);
      const after = row(this.db, 'fin_deposits', key);
      financeAudit(this.store, user, 'create', 'fin_deposits', key, null, after);
      return after;
    });
  }
  depositAction(actor: Actor | null, rawId: unknown, raw: unknown) {
    const key = id.parse(rawId);
    const v = edit
      .extend({
        kind: z.enum(['refund', 'apply']),
        date: dateSchema,
        amount: money,
        reason: label,
        accountId: id.optional(),
        obligationId: id.optional(),
      })
      .parse(raw);
    const permission = v.kind === 'refund' ? 'finance:cash' : 'finance:edit';
    const user = financeActor(actor, permission);
    return financeWrite(this.store, user, 'deposit.action', { ...v, key }, () => {
      const before = row(this.db, 'fin_deposits', key);
      checkVersion(before, v.version);
      if (
        this.ledger.get(user, before.voucher_id).header.status !== 'posted' ||
        v.date < String(before.date)
      )
        financeError('保证金须先记账且操作日期不得早于收付日。');
      const left =
        Number(before.amount_cents) -
        Number(
          this.db
            .prepare(
              'SELECT coalesce(sum(amount_cents),0) AS n FROM fin_deposit_actions WHERE deposit_id=?',
            )
            .get(key)?.n,
        );
      if (v.amount > left) financeError('保证金余额不足。');
      const paid = before.kind === 'paid',
        counter = this.template('deposit', String(before.kind));
      let entries: ReturnType<typeof entry>[];
      if (v.kind === 'refund') {
        if (!v.accountId) financeError('请选择退回资金账户。');
        const bank = this.bank(v.accountId);
        entries = paid
          ? [entry(bank, v.amount, 0, null, '保证金退回'), entry(counter, 0, v.amount)]
          : [entry(counter, v.amount, 0), entry(bank, 0, v.amount, null, '保证金退回')];
      } else {
        if (!v.obligationId) financeError('请选择转抵的往来单。');
        const o = this.db
          .prepare('SELECT * FROM (' + openItems + ') WHERE id=?')
          .get(v.obligationId);
        if (
          !o ||
          o.party_id !== before.party_id ||
          before.party_kind !== (paid ? 'supplier' : 'customer') ||
          o.kind !== (paid ? 'payable' : 'receivable') ||
          v.amount > Number(o.balance) ||
          v.date < String(o.date)
        )
          financeError('转抵单方向、往来单位、金额或日期不符。');
        const aux = {
          kind: paid ? ('supplier' as const) : ('customer' as const),
          id: String(o.party_id),
          name: String(o.party_name),
        };
        entries = paid
          ? [entry('2202', v.amount, 0, aux), entry(counter, 0, v.amount)]
          : [entry(counter, v.amount, 0), entry('1122', 0, v.amount, aux)];
        this.db
          .prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?')
          .run(v.obligationId);
      }
      const voucher = this.ledger.createLinked(
        user,
        'deposit',
        key,
        { date: v.date, description: v.reason, entries, requestId: v.requestId },
        permission,
      );
      const actionId = Number(
        this.db
          .prepare(
            'INSERT INTO fin_deposit_actions(deposit_id,kind,date,amount_cents,obligation_id,voucher_id) VALUES(?,?,?,?,?,?)',
          )
          .run(key, v.kind, v.date, v.amount, v.obligationId ?? null, voucher.header.id)
          .lastInsertRowid,
      );
      this.db.prepare('UPDATE fin_deposits SET version=version+1 WHERE id=?').run(key);
      const action = row(this.db, 'fin_deposit_actions', actionId);
      financeAudit(this.store, user, v.kind, 'fin_deposits', key, before, {
        ...row(this.db, 'fin_deposits', key),
        action,
        reason: v.reason,
      });
      return action;
    });
  }
  private estimate(o: Record<string, unknown>, period: string) {
    const snapshot = JSON.parse(String(o.terms_snapshot ?? 'null'));
    const terms = termOptions.parse(JSON.parse(snapshot?.options ?? '{}')).interest;
    if (!terms) return null;
    const base = terms.basis === 'document' ? String(o.date) : (o.due_date as string | null);
    if (!base) return null;
    const begins = shiftDays(base, terms.freeDays);
    const end = endOfMonth(period),
      start = period + '-01';
    const days = Math.max(0, dayDistance(begins < start ? shiftDays(start, -1) : begins, end));
    const amount = percentCents(
      Number(o.balance),
      terms.rate,
      days * (terms.unit === 'monthly' ? 12 : 1),
      365,
    );
    return {
      amount,
      begins,
      days,
      balance: o.balance,
      rate: terms.rate,
      unit: terms.unit,
      basis: terms.basis,
    };
  }
  interest(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ period: periodSchema, kind: partyKind }).parse(raw);
    const items = pageSql(
      this.db,
      `SELECT o.*,i.id AS interest_id,i.amount_cents AS confirmed,i.voucher_id AS interest_voucher_id
      FROM (${openItems}) o LEFT JOIN fin_interest i ON i.obligation_id=o.id AND i.period=?
      WHERE o.kind=? AND o.date<=? AND o.balance>0
      AND json_type(json_extract(o.terms_snapshot,'$.options'),'$.interest')='object'`,
      [q.period, q.kind, endOfMonth(q.period)],
      raw,
      'date',
    );
    return {
      ...items,
      rows: items.rows.map((o) => ({ ...o, estimate: this.estimate(o, q.period) })),
    };
  }
  confirmInterest(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        period: periodSchema,
        obligationId: id,
        version: z.number().int().positive(),
        amount: centsSchema.optional(),
        reason: label.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'interest.confirm', v, () => {
      const o = this.db.prepare('SELECT * FROM (' + openItems + ') WHERE id=?').get(v.obligationId);
      if (!o || Number(o.balance) <= 0) financeError('没有可计息余额。');
      checkVersion(o, v.version);
      if (
        this.db
          .prepare('SELECT 1 FROM fin_interest WHERE obligation_id=? AND period=?')
          .get(v.obligationId, v.period)
      )
        financeError('本期间利息已处理。', 409);
      const suggestion = this.estimate(o, v.period),
        amount = v.amount ?? suggestion?.amount ?? 0;
      if ((!suggestion || amount !== suggestion.amount || !amount) && !v.reason)
        financeError('调整或免除利息须填原因。');
      const date = endOfMonth(v.period),
        ar = o.kind === 'receivable';
      this.ledger.openPeriod(user, date);
      const key = Number(
        this.db
          .prepare(
            'INSERT INTO fin_interest(obligation_id,period,date,amount_cents,reason) VALUES(?,?,?,?,?)',
          )
          .run(v.obligationId, v.period, date, amount, v.reason ?? '按规则计息').lastInsertRowid,
      );
      if (amount) {
        const fee = this.template('interest', 'fee'),
          aux = {
            kind: ar ? ('customer' as const) : ('supplier' as const),
            id: String(o.party_id),
            name: String(o.party_name),
          };
        const entries = ar
          ? [entry('1122', amount, 0, aux), entry(fee, 0, amount)]
          : [entry(fee, amount, 0), entry('2202', 0, amount, aux)];
        const voucher = this.ledger.createLinked(user, 'interest', key, {
          date,
          description: '压款利息',
          entries,
          requestId: v.requestId,
        });
        this.db
          .prepare('UPDATE fin_interest SET voucher_id=? WHERE id=?')
          .run(voucher.header.id, key);
        const ob = Number(
          this.db
            .prepare(
              `INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description,voucher_id)
          VALUES(?,?,?,?,?,'压款利息',?)`,
            )
            .run(o.kind, o.party_id, o.party_name, date, amount, voucher.header.id).lastInsertRowid,
        );
        financeAudit(
          this.store,
          user,
          'interest',
          'fin_obligations',
          ob,
          null,
          row(this.db, 'fin_obligations', ob),
        );
      }
      const after = row(this.db, 'fin_interest', key);
      financeAudit(this.store, user, 'confirm', 'fin_interest', key, null, {
        ...after,
        suggestion,
      });
      return after;
    });
  }
}
