import { z } from 'zod';
import { dateSchema, today } from '../../shared/core/index.js';
import { centsSchema, periodSchema } from '../../shared/finance/index.js';
import type { FinanceEntry } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, parseStoredJson, rows } from '../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite, requirePartyName } from './core.js';
import { financeTemplate } from './template.js';
import { FinanceLedger } from './ledger.js';
import { edit, entry, id, label, money, pageSql, partyKind, request, row } from './query.js';
import { overdueInterest } from './terms.js';
import { depositActionKinds, depositKinds, partyKinds } from './stored-values.js';
import { allocationsByDate, openItems, voucherReversed, voucherStands, voucherState } from './obligation-sql.js';
import { endOfMonth } from './periods.js';
import { openItemRow, sumOf } from './finance-rows.js';

/** 保证金 d 已经退回、转抵掉的（只算凭证还算数的） */
const depositUsed = (d: string) => `coalesce((SELECT sum(a.amount_cents) FROM fin_deposit_actions a
  JOIN fin_vouchers av ON av.id=a.voucher_id WHERE a.deposit_id=${d} AND ${voucherStands('av')}),0)`;
/**
 * 还算数的利息确认（FROM 片段，i 是 fin_interest）：免除的（没有凭证）、凭证没作废也没被红冲的。
 * 撤回或红冲掉的那次不算，那几天可以重新确认。
 */
const effectiveInterest = `fin_interest i LEFT JOIN fin_vouchers iv ON iv.id=i.voucher_id
  WHERE (i.voucher_id IS NULL OR (iv.status<>'void' AND NOT EXISTS(
    SELECT 1 FROM fin_vouchers ir WHERE ir.reversal_of=iv.id AND ir.status<>'void')))`;

/** 保证金列表一行：保证金加余额、凭证状态，actions 是退回、转抵记录（SQL 拼的 JSON 文字，各带自己的凭证三列） */
const depositRow = rows.fin_deposits.extend({
  balance: z.number(),
  voucher_status: z.string().nullable(),
  voucher_state: z.string().nullable(),
  actions: z.string(),
});
/** 保证金的一次退回或转抵（列表 actions 里的一项）：凭证一定有（按凭证连出来的） */
const depositActionItem = z.object({
  id: z.number(),
  kind: z.enum(depositActionKinds),
  date: z.string(),
  amount_cents: z.number(),
  obligation_id: z.number().nullable(),
  voucher_id: z.number(),
  voucher_status: z.string(),
  voucher_state: z.string().nullable(),
});
/** 计息列表一行：还欠着的往来，加上次确认算到哪天、这个月确认过的那条和金额、最后一次核销的日期 */
const interestRow = openItemRow.extend({
  confirmed_through: z.string().nullable(),
  interest_id: z.number().nullable(),
  confirmed: z.number(),
  last_paid: z.string().nullable(),
});
const actionInput = edit.extend({
  kind: z.enum(depositActionKinds),
  date: dateSchema,
  amount: money,
  reason: label,
  accountId: id.optional(),
  obligationId: id.optional(),
});
type ActionInput = z.output<typeof actionInput>;
type DepositRow = z.output<typeof rows.fin_deposits>;

/** 保证金（收、付、退回、转抵）和压款利息 */
export class FinanceDepositsInterest {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }
  private template(name: string, key: string) {
    return financeTemplate(this.store, name)(key);
  }
  private bank(key: number) {
    const a = row(this.db, 'fin_cash_accounts', key);
    if (!a.enabled) financeError('资金账户已停用。');
    return a.account_code;
  }
  deposits(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ kind: z.enum(depositKinds).optional(), partyId: id.optional() })
      .parse(raw);
    const page = pageSql(
      this.db,
      {
        schema: depositRow,
        // 余额只算还算数的凭证：收付保证金那张撤回或红冲了是 0，退回、转抵撤回或红冲了不扣；
        // 保证金本身的凭证三列（voucher_id、voucher_status、voucher_state），actions 是退回、转抵记录，各带自己的凭证三列
        sql: `SELECT d.*,CASE WHEN NOT ${voucherStands('dv')} THEN 0 ELSE d.amount_cents-${depositUsed('d.id')} END AS balance,
        dv.status AS voucher_status,${voucherState('dv')} AS voucher_state,
        (SELECT json_group_array(json_object('id',a.id,'kind',a.kind,'date',a.date,'amount_cents',a.amount_cents,
          'obligation_id',a.obligation_id,'voucher_id',a.voucher_id,'voucher_status',av.status,'voucher_state',${voucherState('av')}))
          FROM fin_deposit_actions a JOIN fin_vouchers av ON av.id=a.voucher_id WHERE a.deposit_id=d.id) AS actions
      FROM fin_deposits d LEFT JOIN fin_vouchers dv ON dv.id=d.voucher_id
      WHERE (? IS NULL OR d.kind=?) AND (? IS NULL OR d.party_id=?)`,
        values: [q.kind ?? null, q.kind ?? null, q.partyId ?? null, String(q.partyId ?? '')],
        order: 'date',
      },
      raw,
    );
    // 退回、转抵记录解析好给页面（详情里逐笔列出、能撤回）
    return {
      ...page,
      rows: page.rows.map((d) => ({
        ...d,
        actions: parseStoredJson(z.array(depositActionItem), d.actions, `保证金 ${d.id} 的退回、转抵记录`),
      })),
    };
  }
  deposit(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash');
    const v = request
      .extend({
        kind: z.enum(depositKinds),
        partyKind: z.enum(partyKinds),
        partyId: id,
        accountId: id,
        date: dateSchema,
        amount: money,
        description: label,
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'deposit.create', input: v, result: rows.fin_deposits }, () => {
      const name = requirePartyName(this.db, v.partyKind, v.partyId);
      const key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_deposits(kind,party_kind,party_id,party_name,date,amount_cents,description)
        VALUES(?,?,?,?,?,?,?)`,
          )
          .run(v.kind, v.partyKind, String(v.partyId), name, v.date, v.amount, v.description).lastInsertRowid,
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
      this.db.prepare('UPDATE fin_deposits SET voucher_id=? WHERE id=?').run(voucher.header.id, key);
      const after = row(this.db, 'fin_deposits', key);
      financeAudit(this.store, user, { action: 'create', entity: 'fin_deposits', id: key, before: null, after });
      return after;
    });
  }
  depositAction(actor: Actor | null, rawId: unknown, raw: unknown) {
    const key = id.parse(rawId);
    const v = actionInput.parse(raw);
    const permission = v.kind === 'refund' ? 'finance:cash' : 'finance:edit';
    const user = financeActor(actor, permission);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'deposit.action', input, result: rows.fin_deposit_actions }, () => {
      const before = row(this.db, 'fin_deposits', key);
      checkVersion(before, v.version);
      if (
        this.ledger.get(user, before.voucher_id).header.status !== 'posted' ||
        exists(this.db, `SELECT 1 FROM fin_vouchers v WHERE v.id=? AND ${voucherReversed('v')}`, before.voucher_id) ||
        v.date < before.date
      )
        financeError('保证金须先记账、没有红冲，且操作日期不得早于收付日。');
      const left = before.amount_cents - sumOf(this.db, `SELECT ${depositUsed('?')} AS n`, key);
      if (v.amount > left) financeError('保证金余额不足。');
      const counter = this.template('deposit', before.kind);
      const entries = v.kind === 'refund' ? this.refundEntries(before, v, counter) : this.applyEntries(before, v, counter);
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
          .run(key, v.kind, v.date, v.amount, v.obligationId ?? null, voucher.header.id).lastInsertRowid,
      );
      this.db.prepare('UPDATE fin_deposits SET version=version+1 WHERE id=?').run(key);
      const action = row(this.db, 'fin_deposit_actions', actionId);
      financeAudit(this.store, user, {
        action: v.kind,
        entity: 'fin_deposits',
        id: key,
        before,
        after: { ...row(this.db, 'fin_deposits', key), action, reason: v.reason },
      });
      return action;
    });
  }
  /** 退回保证金：钱退回（收回）资金账户 */
  private refundEntries(before: DepositRow, v: ActionInput, counter: string): FinanceEntry[] {
    if (!v.accountId) financeError('请选择退回资金账户。');
    const bank = this.bank(v.accountId);
    return before.kind === 'paid'
      ? [entry(bank, v.amount, 0, null, '保证金退回'), entry(counter, 0, v.amount)]
      : [entry(counter, v.amount, 0), entry(bank, 0, v.amount, null, '保证金退回')];
  }
  /** 保证金转抵一笔往来：付出去的抵应付，收进来的抵应收；往来要是同一单位、方向对、余额够 */
  private applyEntries(before: DepositRow, v: ActionInput, counter: string): FinanceEntry[] {
    const paid = before.kind === 'paid';
    if (!v.obligationId) financeError('请选择转抵的往来单。');
    const o = one(this.db, openItemRow, 'SELECT * FROM (' + openItems + ') WHERE id=?', v.obligationId);
    if (
      !o ||
      o.party_id !== before.party_id ||
      before.party_kind !== (paid ? 'supplier' : 'customer') ||
      o.kind !== (paid ? 'payable' : 'receivable') ||
      v.amount > o.balance ||
      v.date < o.date
    )
      financeError('转抵单方向、往来单位、金额或日期不符。');
    const aux = { kind: paid ? ('supplier' as const) : ('customer' as const), id: o.party_id, name: o.party_name };
    this.db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(v.obligationId);
    return paid
      ? [entry('2202', v.amount, 0, aux), entry(counter, 0, v.amount)]
      : [entry(counter, v.amount, 0), entry('1122', 0, v.amount, aux)];
  }
  /** 这笔往来的利息建议：从上次确认算到的那天之后算到 asOf（见 overdueInterest） */
  private estimate(o: Parameters<typeof overdueInterest>[0] & { id: number }, asOf: string) {
    const after = one(
      this.db,
      z.object({ date: z.string().nullable() }),
      `SELECT max(i.date) AS date FROM ${effectiveInterest} AND i.obligation_id=?`,
      o.id,
    )?.date;
    const paid = many(this.db, z.object({ date: z.string(), amount: z.number() }), allocationsByDate('?'), o.id);
    return overdueInterest(o, asOf, after ?? null, paid);
  }
  interest(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ period: periodSchema, kind: partyKind, date: dateSchema.optional() })
      .parse(raw);
    // 看的那天（默认今天）和月底取早的：没过的日子不先算
    const end = endOfMonth(q.period),
      asOf = (q.date ?? today()) < end ? (q.date ?? today()) : end;
    // 还欠着的，或者付清了、但最后一次核销在上次确认之后（付清前那几天还没确认）的
    const items = pageSql(
      this.db,
      {
        schema: interestRow,
        sql: `SELECT * FROM (SELECT o.*,
        (SELECT max(i.date) FROM ${effectiveInterest} AND i.obligation_id=o.id) AS confirmed_through,
        (SELECT max(i.id) FROM ${effectiveInterest} AND i.obligation_id=o.id AND i.period=?) AS interest_id,
        (SELECT coalesce(sum(i.amount_cents),0) FROM ${effectiveInterest} AND i.obligation_id=o.id AND i.period=?) AS confirmed,
        (SELECT max(p.date) FROM (${allocationsByDate('o.id')}) p) AS last_paid
      FROM (${openItems}) o
      WHERE o.kind=? AND o.date<=?
      AND json_type(json_extract(o.terms_snapshot,'$.options'),'$.interest')='object')
      WHERE balance>0 OR last_paid>coalesce(confirmed_through,due_date,date)`,
        values: [q.period, q.period, q.kind, end],
        order: 'date',
      },
      raw,
    );
    return {
      ...items,
      asOf,
      rows: items.rows.map((o) => ({ ...o, estimate: this.estimate(o, asOf) })),
    };
  }
  /**
   * 确认一次利息：算到 date（默认今天，不晚于这个月月底），从上次确认算到的那天之后接着算，
   * 一个月可以确认几次。凭证日期就是算到的那天。
   */
  confirmInterest(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        period: periodSchema,
        obligationId: id,
        version: z.number().int().positive(),
        date: dateSchema.optional(),
        amount: centsSchema.optional(),
        reason: label.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'interest.confirm', input: v, result: rows.fin_interest }, () => {
      const o = one(this.db, openItemRow, 'SELECT * FROM (' + openItems + ') WHERE id=?', v.obligationId);
      if (!o) financeError('没有可计息的往来。');
      checkVersion(o, v.version);
      const end = endOfMonth(v.period),
        wanted = v.date ?? today();
      if (wanted > today()) financeError('利息只能算到今天。');
      const date = wanted < end ? wanted : end;
      if (date < v.period + '-01') financeError('这个月还没到，不能确认利息。');
      const suggestion = this.estimate(o, date);
      if (suggestion && suggestion.from >= date) financeError('利息已经算到 ' + suggestion.from + '，没有新的天数。', 409);
      const amount = v.amount ?? suggestion?.amount ?? 0;
      if ((!suggestion || amount !== suggestion.amount || !amount) && !v.reason)
        financeError('调整或免除利息须填原因。');
      const ar = o.kind === 'receivable';
      this.ledger.openPeriod(user, date);
      const key = Number(
        this.db
          .prepare('INSERT INTO fin_interest(obligation_id,period,date,amount_cents,reason) VALUES(?,?,?,?,?)')
          .run(v.obligationId, v.period, date, amount, v.reason ?? '按规则计息').lastInsertRowid,
      );
      if (amount) {
        const fee = this.template('interest', 'fee'),
          aux = { kind: ar ? ('customer' as const) : ('supplier' as const), id: o.party_id, name: o.party_name };
        const entries = ar
          ? [entry('1122', amount, 0, aux), entry(fee, 0, amount)]
          : [entry(fee, amount, 0), entry('2202', 0, amount, aux)];
        const voucher = this.ledger.createLinked(user, 'interest', key, {
          date,
          description: '压款利息',
          entries,
          requestId: v.requestId,
        });
        this.db.prepare('UPDATE fin_interest SET voucher_id=? WHERE id=?').run(voucher.header.id, key);
        const ob = Number(
          this.db
            .prepare(
              `INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description,voucher_id)
          VALUES(?,?,?,?,?,'压款利息',?)`,
            )
            .run(o.kind, o.party_id, o.party_name, date, amount, voucher.header.id).lastInsertRowid,
        );
        financeAudit(this.store, user, { action: 'interest', entity: 'fin_obligations', id: ob, before: null, after: row(this.db, 'fin_obligations', ob) });
      }
      const after = row(this.db, 'fin_interest', key);
      financeAudit(this.store, user, { action: 'confirm', entity: 'fin_interest', id: key, before: null, after: { ...after, suggestion } });
      return after;
    });
  }
}
