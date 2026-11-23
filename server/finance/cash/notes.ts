import { z } from 'zod';
import { dateSchema, today } from '../../../shared/core/index.js';
import { accountCodeSchema } from '../../../shared/finance/index.js';
import type { FinanceEntry } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, many, rows } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite, requirePartyName } from '../base/core.js';
import { financeTemplate } from '../base/template.js';
import { FinanceLedger } from '../ledger/ledger.js';
import { edit, entry, id, label, money, pageSql, partyKind, request, row } from '../base/query.js';
import { DAYS_PER_YEAR, shiftDays } from '../base/days.js';
import { noteStatuses } from '../base/stored-values.js';
import { voucherColumns } from '../parties/obligation-sql.js';
import {
  noteAllocations,
  planSettlement,
  positions,
  recordSettlement,
  settledLines,
  sideEntries,
  sides,
  type Party,
  type Side,
} from './note-settlements.js';

/** 贴现利息没指定科目时记财务费用 */
const DISCOUNT_FEE_ACCOUNT = '5603';
const states = z.enum(noteStatuses);
/** 票据列表一行：票据加还记在预收、预付里的金额，和变更凭证三列（change_ 开头） */
const listRow = rows.fin_notes.extend({
  unsettled_cents: z.number(),
  change_voucher_id: z.number().nullable(),
  change_voucher_status: z.string().nullable(),
  change_voucher_state: z.string().nullable(),
});
const changeInput = edit.extend({
  status: states.exclude(['held', 'cancelled']),
  date: dateSchema,
  reason: label,
  accountId: id.optional(),
  counterAccount: accountCodeSchema.optional(),
  counterPartyId: id.optional(),
  proceeds: money.optional(),
  allocations: noteAllocations,
});
type ChangeInput = z.output<typeof changeInput>;
type NoteRow = z.output<typeof rows.fin_notes>;
type Line = { obligationId: number; amount: number };
/** 票据变更的分录，和要在往来上记的冲销（退票冲回、背书冲应付；到期收款、贴现没有） */
type ChangePlan = { entries: FinanceEntry[]; settle: { lines: Line[] } | null };

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
        dueDays: z.coerce.number().int().min(0).max(DAYS_PER_YEAR).optional(),
        date: dateSchema.default(() => today()),
      })
      .parse(raw);
    // unsettled_cents：还记在预收、预付里、没冲到具体欠款上的部分，可以在详情里“核销到欠款”。
    return pageSql(
      this.db,
      {
        schema: listRow,
        sql: `SELECT n.*,coalesce((SELECT sum((CASE WHEN e.account_code='2203' THEN e.credit-e.debit ELSE e.debit-e.credit END)
        *(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
        WHERE v.module_source='note' AND v.module_id=n.id AND v.status<>'void' AND e.account_code IN ('2203','1123')),0) AS unsettled_cents,
        ${voucherColumns("CASE WHEN n.status NOT IN ('held','cancelled') THEN n.voucher_id END", 'change_')}
      FROM fin_notes n WHERE (? IS NULL OR kind=?) AND (? IS NULL OR status=?)
      AND (? IS NULL OR (status='held' AND due_date<=?))`,
        values: [
          q.kind ?? null,
          q.kind ?? null,
          q.status ?? null,
          q.status ?? null,
          q.dueDays ?? null,
          shiftDays(q.date, q.dueDays ?? 0),
        ],
        order: 'due_date',
      },
      raw,
    );
  }

  private noteAccount(kind: string) {
    return financeTemplate(this.store, 'notes')(kind);
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
        allocations: noteAllocations,
      })
      .parse(raw);
    if (v.dueDate < v.date) financeError('票据到期日不可早于出票日期。');
    return financeWrite(this.store, user, { action: 'notes.create', input: v, result: rows.fin_notes }, () => {
      const side: Side = v.kind;
      const rule = sides[side],
        name = requirePartyName(this.db, rule.auxiliary, v.partyId);
      if (exists(this.db, 'SELECT 1 FROM fin_notes WHERE kind=? AND number=?', v.kind, v.number))
        financeError('票号重复。', 409);
      const key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_notes(kind,party_id,party_name,number,bank,date,due_date,amount_cents,status)
        VALUES(?,?,?,?,?,?,?,?,'held')`,
          )
          .run(v.kind, String(v.partyId), name, v.number, v.bank, v.date, v.dueDate, v.amount).lastInsertRowid,
      );
      const aux: Party = { kind: rule.auxiliary, id: String(v.partyId), name };
      const plan = planSettlement(this.db, { side, partyId: aux.id, date: v.date, amount: v.amount, explicit: v.allocations });
      const note = this.noteAccount(v.kind);
      const partyEntries = sideEntries(side, aux, plan.total, v.amount - plan.total);
      const entries =
        side === 'receivable' ? [entry(note, v.amount, 0), ...partyEntries] : [...partyEntries, entry(note, 0, v.amount)];
      const voucher = new FinanceLedger(this.store).createLinked(
        user,
        'note',
        key,
        { date: v.date, description: '承兑票据 ' + v.number, requestId: v.requestId, entries },
        'finance:cash',
      );
      this.db.prepare('UPDATE fin_notes SET voucher_id=? WHERE id=?').run(voucher.header.id, key);
      recordSettlement(this.store, user, {
        lines: plan.lines,
        date: v.date,
        voucher: Number(voucher.header.id),
        reason: '承兑票据 ' + v.number,
      });
      const after = row(this.db, 'fin_notes', key);
      financeAudit(this.store, user, {
        action: 'create',
        entity: 'fin_notes',
        id: key,
        before: null,
        after: { ...after, settlements: plan.lines },
      });
      return after;
    });
  }

  change(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = changeInput.parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'notes.change', input, result: rows.fin_notes }, () => {
      const before = row(this.db, 'fin_notes', key),
        ledger = new FinanceLedger(this.store);
      checkVersion(before, v.version);
      if (before.status !== 'held' || v.date < before.date || ledger.get(user, before.voucher_id).header.status !== 'posted')
        financeError('只有已记账的持有票据可变更。');
      const note = this.noteAccount(before.kind);
      const { entries, settle } =
        v.status === 'returned'
          ? this.returned(before, note)
          : v.status === 'endorsed'
            ? this.endorsed(before, note, v)
            : this.cashed(before, note, v);
      const voucher = ledger.createLinked(
        user,
        'note',
        key,
        { date: v.date, requestId: v.requestId, description: v.reason, entries },
        'finance:cash',
      );
      if (settle)
        recordSettlement(this.store, user, { lines: settle.lines, date: v.date, voucher: Number(voucher.header.id), reason: v.reason });
      this.db
        .prepare('UPDATE fin_notes SET status=?,voucher_id=?,version=version+1 WHERE id=?')
        .run(v.status, voucher.header.id, key);
      const after = row(this.db, 'fin_notes', key);
      financeAudit(this.store, user, {
        action: 'change',
        entity: 'fin_notes',
        id: key,
        before,
        after: { ...after, reason: v.reason, ...(settle ? { settlements: settle.lines } : {}) },
      });
      return after;
    });
  }

  /** 退票：收票（开票）时冲掉的往来逐笔冲回，记在预收（预付）的部分一起转回 */
  private returned(before: NoteRow, note: string): ChangePlan {
    const ar = before.kind === 'receivable',
      amount = before.amount_cents;
    const side: Side = ar ? 'receivable' : 'payable';
    const current = positions(this.db, before.id).filter((p) => p.side === side);
    const fallback: Party = { kind: sides[side].auxiliary, id: before.party_id, name: before.party_name };
    const partyEntries = current.length
      ? current.flatMap((p) => sideEntries(side, p.party, p.settled, p.advance, true))
      : sideEntries(side, fallback, amount, 0, true);
    return {
      entries: ar ? [...partyEntries, entry(note, 0, amount)] : [entry(note, amount, 0), ...partyEntries],
      settle: {
        lines: current.flatMap((p) =>
          settledLines(this.db, before.id, side, p.party.id).map((l) => ({ ...l, amount: -l.amount })),
        ),
      },
    };
  }

  /** 背书给供应商抵货款：冲这个供应商的应付，冲不完的记预付 */
  private endorsed(before: NoteRow, note: string, v: ChangeInput): ChangePlan {
    if (before.kind !== 'receivable' || !v.counterPartyId) financeError('应收票据背书须指定供应商。');
    const amount = before.amount_cents;
    const aux: Party = { kind: 'supplier', id: String(v.counterPartyId), name: requirePartyName(this.db, 'supplier', v.counterPartyId) };
    const plan = planSettlement(this.db, { side: 'payable', partyId: aux.id, date: v.date, amount, explicit: v.allocations });
    return {
      entries: [...sideEntries('payable', aux, plan.total, amount - plan.total), entry(note, 0, amount)],
      settle: plan,
    };
  }

  /** 到期收款（付款）、贴现：钱进出资金账户，贴现少收的记财务费用 */
  private cashed(before: NoteRow, note: string, v: ChangeInput): ChangePlan {
    const ar = before.kind === 'receivable',
      amount = before.amount_cents;
    if (!v.accountId || (!ar && v.status === 'discounted')) financeError('请选择资金账户及合法票据操作。');
    const cash = row(this.db, 'fin_cash_accounts', v.accountId),
      bank = cash.account_code;
    if (!cash.enabled) financeError('资金账户已停用。');
    const proceeds = v.status === 'discounted' ? (v.proceeds ?? 0) : amount;
    if (!proceeds || proceeds > amount) financeError('贴现实收金额不合法。');
    const fee = amount - proceeds;
    const entries = ar
      ? [
          entry(bank, proceeds, 0, null, '销售商品收到的现金'),
          entry(note, 0, amount),
          ...(fee ? [entry(v.counterAccount ?? DISCOUNT_FEE_ACCOUNT, fee, 0)] : []),
        ]
      : [entry(note, amount, 0), entry(bank, 0, amount, null, '购买商品支付的现金')];
    return { entries, settle: null };
  }

  /**
   * 票据金额当时没冲完、记在预收（预付）里的部分，等这个单位有了新的欠款再冲上去：
   * 收票的借预收、贷应收，开票或背书的借应付、贷预付，往来上留核销记录。
   */
  allocate(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit.extend({ date: dateSchema, allocations: noteAllocations }).parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'notes.allocate', input, result: rows.fin_notes }, () => {
      const before = row(this.db, 'fin_notes', key);
      checkVersion(before, v.version);
      if (v.date < before.date) financeError('核销日期不能早于出票日。');
      const open = positions(this.db, key).filter((p) => p.advance > 0);
      if (!open.length) financeError('这张票据没有记在预收、预付里的金额。', 409);
      const chosen = this.chosenBySide(open, v.allocations);
      const ledger = new FinanceLedger(this.store);
      const done: Line[] = [];
      for (const p of open) {
        const picked = chosen.get(p.side + ':' + p.party.id);
        if (v.allocations && !picked) continue;
        const plan = planSettlement(this.db, { side: p.side, partyId: p.party.id, date: v.date, amount: p.advance, explicit: picked });
        if (!plan.total) continue;
        const rule = sides[p.side];
        const entries =
          p.side === 'receivable'
            ? [entry(rule.advance, plan.total, 0, p.party), entry(rule.party, 0, plan.total, p.party)]
            : [entry(rule.party, plan.total, 0, p.party), entry(rule.advance, 0, plan.total, p.party)];
        const voucher = ledger.createLinked(
          user,
          'note',
          key,
          {
            date: v.date,
            requestId: v.requestId + ':' + p.side + ':' + p.party.id,
            description: '票据核销 ' + before.number,
            entries,
          },
          'finance:cash',
        );
        recordSettlement(this.store, user, {
          lines: plan.lines,
          date: v.date,
          voucher: Number(voucher.header.id),
          reason: '票据核销 ' + before.number,
        });
        done.push(...plan.lines);
      }
      if (!done.length) financeError('这个单位没有未结清的欠款可以核销。', 409);
      this.db.prepare('UPDATE fin_notes SET version=version+1 WHERE id=?').run(key);
      const after = row(this.db, 'fin_notes', key);
      financeAudit(this.store, user, { action: 'allocate', entity: 'fin_notes', id: key, before, after: { ...after, settlements: done } });
      return after;
    });
  }

  /** 指定了核销哪几笔的，按往来的方向和单位分到对应的一边；对不上的直接报错，不按先后去冲 */
  private chosenBySide(open: readonly { side: Side; party: Party }[], allocations: z.output<typeof noteAllocations>) {
    const chosen = new Map<string, NonNullable<typeof allocations>>();
    if (!allocations) return chosen;
    const owners = new Map(
      many(
        this.db,
        rows.fin_obligations.pick({ id: true, kind: true, party_id: true }),
        'SELECT id,kind,party_id FROM fin_obligations WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(allocations.map((a) => a.obligationId)),
      ).map((o) => [o.id, o.kind + ':' + o.party_id]),
    );
    for (const a of allocations) {
      const side = owners.get(a.obligationId);
      if (!side || !open.some((p) => p.side + ':' + p.party.id === side))
        financeError('指定核销的往来不属于这张票据的往来单位，或那边没有记在预收、预付的金额。');
      chosen.set(side, [...(chosen.get(side) ?? []), a]);
    }
    return chosen;
  }
}
