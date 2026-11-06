import { z } from 'zod';
import { dateSchema, today } from '../../shared/domain.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { edit, entry, id, label, money, pageSql, partyKind, request, row } from './query.js';
import { shiftDays } from './terms.js';
import { accountCodeSchema } from '../../shared/finance.js';

const states = z.enum(['held', 'endorsed', 'discounted', 'matured', 'returned']);
export class FinanceNotes {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        kind: partyKind.optional(),
        status: states.optional(),
        dueDays: z.coerce.number().int().min(0).max(365).optional(),
        date: dateSchema.default(() => today()),
      })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT * FROM fin_notes WHERE (? IS NULL OR kind=?) AND (? IS NULL OR status=?)
      AND (? IS NULL OR (status='held' AND due_date<=?))`,
      [
        q.kind ?? null,
        q.kind ?? null,
        q.status ?? null,
        q.status ?? null,
        q.dueDays ?? null,
        shiftDays(q.date, q.dueDays ?? 0),
      ],
      raw,
      'due_date',
    );
  }
  add(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash');
    const v = request
      .extend({
        kind: partyKind,
        partyId: id,
        number: label,
        bank: label,
        date: dateSchema,
        dueDate: dateSchema,
        amount: money,
      })
      .parse(raw);
    if (v.dueDate < v.date) financeError('票据到期日不可早于出票日期。');
    return financeWrite(this.store, user, 'notes.create', v, () => {
      const ar = v.kind === 'receivable',
        party = row(this.db, ar ? 'customers' : 'suppliers', v.partyId);
      if (
        this.db.prepare('SELECT 1 FROM fin_notes WHERE kind=? AND number=?').get(v.kind, v.number)
      )
        financeError('票号重复。', 409);
      const key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_notes(kind,party_id,party_name,number,bank,date,due_date,amount_cents,status)
        VALUES(?,?,?,?,?,?,?,?,'held')`,
          )
          .run(v.kind, String(v.partyId), party.name, v.number, v.bank, v.date, v.dueDate, v.amount)
          .lastInsertRowid,
      );
      const aux = {
        kind: ar ? ('customer' as const) : ('supplier' as const),
        id: String(v.partyId),
        name: String(party.name),
      };
      const mapping = JSON.parse(
        String(
          this.db.prepare("SELECT mapping FROM fin_templates WHERE name='notes'").get()!.mapping,
        ),
      );
      const entries = ar
        ? [entry(mapping.receivable, v.amount, 0), entry('1122', 0, v.amount, aux)]
        : [entry('2202', v.amount, 0, aux), entry(mapping.payable, 0, v.amount)];
      const voucher = new FinanceLedger(this.store).createLinked(
        user,
        'note',
        key,
        { date: v.date, description: '承兑票据 ' + v.number, requestId: v.requestId, entries },
        'finance:cash',
      );
      this.db.prepare('UPDATE fin_notes SET voucher_id=? WHERE id=?').run(voucher.header.id, key);
      const after = row(this.db, 'fin_notes', key);
      financeAudit(this.store, user, 'create', 'fin_notes', key, null, after);
      return after;
    });
  }
  change(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        status: states.exclude(['held']),
        date: dateSchema,
        reason: label,
        accountId: id.optional(),
        counterAccount: accountCodeSchema.optional(),
        counterPartyId: id.optional(),
        proceeds: money.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'notes.change', { ...v, key }, () => {
      const before = row(this.db, 'fin_notes', key),
        ledger = new FinanceLedger(this.store);
      checkVersion(before, v.version);
      if (
        before.status !== 'held' ||
        v.date < String(before.date) ||
        ledger.get(user, before.voucher_id).header.status !== 'posted'
      )
        financeError('只有已记账的持有票据可变更。');
      const ar = before.kind === 'receivable',
        amount = Number(before.amount_cents);
      const mapping = JSON.parse(
        String(
          this.db.prepare("SELECT mapping FROM fin_templates WHERE name='notes'").get()!.mapping,
        ),
      );
      const note = String(mapping[String(before.kind)]);
      let entries: ReturnType<typeof entry>[];
      if (v.status === 'returned') {
        const aux = {
          kind: ar ? ('customer' as const) : ('supplier' as const),
          id: String(before.party_id),
          name: String(before.party_name),
        };
        entries = ar
          ? [entry('1122', amount, 0, aux), entry(note, 0, amount)]
          : [entry(note, amount, 0), entry('2202', 0, amount, aux)];
      } else if (v.status === 'endorsed') {
        if (!ar || !v.counterPartyId) financeError('应收票据背书须指定供应商。');
        const supplier = row(this.db, 'suppliers', v.counterPartyId);
        entries = [
          entry('2202', amount, 0, {
            kind: 'supplier',
            id: String(v.counterPartyId),
            name: String(supplier.name),
          }),
          entry(note, 0, amount),
        ];
      } else {
        if (!v.accountId || (!ar && v.status === 'discounted'))
          financeError('请选择资金账户及合法票据操作。');
        const cash = row(this.db, 'fin_cash_accounts', v.accountId),
          bank = String(cash.account_code);
        if (!cash.enabled) financeError('资金账户已停用。');
        const proceeds = v.status === 'discounted' ? (v.proceeds ?? 0) : amount;
        if (!proceeds || proceeds > amount) financeError('贴现实收金额不合法。');
        const fee = amount - proceeds;
        entries = ar
          ? [
              entry(bank, proceeds, 0, null, '销售商品收到的现金'),
              entry(note, 0, amount),
              ...(fee ? [entry(v.counterAccount ?? '5603', fee, 0)] : []),
            ]
          : [entry(note, amount, 0), entry(bank, 0, amount, null, '购买商品支付的现金')];
      }
      const voucher = ledger.createLinked(
        user,
        'note',
        key,
        { date: v.date, requestId: v.requestId, description: v.reason, entries },
        'finance:cash',
      );
      this.db
        .prepare('UPDATE fin_notes SET status=?,voucher_id=?,version=version+1 WHERE id=?')
        .run(v.status, voucher.header.id, key);
      const after = row(this.db, 'fin_notes', key);
      financeAudit(this.store, user, 'change', 'fin_notes', key, before, {
        ...after,
        reason: v.reason,
      });
      return after;
    });
  }
}
