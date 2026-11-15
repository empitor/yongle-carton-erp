import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { many, one, rows } from '../core/index.js';
import { accountCodeSchema, centsSchema, requestIdSchema, versionSchema } from '../../shared/finance/index.js';
import { dateSchema, today } from '../../shared/core/index.js';
import { FinanceLedger } from './ledger.js';
import {
  dayOfMonth,
  dueDate,
  installments,
  partyTerms,
  readTermOptions,
  termDays,
  termMonths,
  termOptions,
  termsSnapshotText,
} from './terms.js';
import { edit, entry, id, label, money, pageSql, request, row } from './query.js';
import { parsePaging } from '../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { partyName } from './business-source.js';
import { financeTemplate } from './template.js';
import { obligationKinds, partyKinds, taxModes, termTypes } from './stored-values.js';
import { isReversed } from './reversal-pairs.js';
import { agingBucket, allocationSum, obligationBaseDate, openItems } from './obligation-sql.js';
import { obligationList } from './obligation-list.js';
import { expectRow, openItemRow } from './finance-rows.js';
import { readFinanceSettings } from './settings.js';

const partyKind = z.enum(partyKinds);
const kind = z.enum(obligationKinds);
/** 税率最大 100% */
const MAX_TAX_RATE = 100;
const terms = z
  .strictObject({
    kind: partyKind,
    partyId: z.number().int().positive(),
    // none 是“没有约定”：到期日留空，和压 0 天（当天到期）分开存
    termType: z.enum(termTypes).default('days'),
    termDays: termDays.optional(),
    termMonths: termMonths.optional(),
    paymentDay: dayOfMonth.optional(),
    cutoffDay: dayOfMonth.nullable().default(null),
    options: termOptions.optional(),
    creditLimit: centsSchema.nullable().default(null),
    taxRate: z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,6})?%?$/)
      .refine((v) => Number(v.replace(/%$/, '')) <= MAX_TAX_RATE)
      .nullable()
      .optional(),
    taxMode: z.enum(taxModes).nullable().optional(),
    version: versionSchema.optional(),
    requestId: requestIdSchema,
  })
  .refine(
    (v) =>
      v.termType === 'none' ||
      (v.termType === 'days'
        ? v.termDays !== undefined
        : v.termMonths !== undefined && v.paymentDay !== undefined),
    '请完整填写按天或月结账期。',
  )
  // 没有约定时不留天数、月数这些残值，免得以后读回来被当成压 0 天
  .transform((v) =>
    v.termType === 'none'
      ? { ...v, termDays: 0, termMonths: undefined, paymentDay: undefined, cutoffDay: null }
      : v,
  );

/** 账期列表一行：账期加这个单位已记账的应收余额 */
const termsListRow = rows.fin_party_terms.extend({ receivable: z.number() });
/** 给页面的账期：存的约定文字（options）按 termOptions 解析补齐，读一个单位和列表同一种写法 */
const withOptions = <T extends { kind: string; party_id: string; options: string }>(t: T) => ({
  ...t,
  options: readTermOptions(t.options, `fin_party_terms.options（${t.kind} ${t.party_id}）`),
});
/** 账龄逐笔一行：往来加截至那天的余额、红字冲销待记账、账龄天数、离到期几天、分到哪一档 */
const agingRow = rows.fin_obligations.extend({
  balance: z.number(),
  reversal_pending: z.number(),
  days: z.number(),
  days_to_due: z.number().nullable(),
  bucket: z.number(),
});
/** 账龄合计：每一档的余额和笔数 */
const agingTotal = z.object({ bucket: z.number(), balance: z.number(), count: z.number() });

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
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'bad-debt', input, result: rows.fin_bad_debts }, () => {
      const db = this.store.db;
      const before = one(db, openItemRow, 'SELECT * FROM (' + openItems + ") WHERE id=? AND kind='receivable'", key);
      if (!before || before.balance < v.amount || v.date < before.date || !before.voucher_id)
        financeError('坏账须对应有效往来单及可核销余额。');
      checkVersion(before, v.version);
      const ledger = new FinanceLedger(this.store);
      if (ledger.get(user, before.voucher_id).header.status !== 'posted')
        financeError('往来凭证尚未记账。');
      const provision =
        v.kind === 'provision' ? (v.counterAccount ?? financeError('计提坏账须明确备抵科目。')) : null;
      const fee = financeTemplate(this.store, 'bad_debt')('expense');
      const aux = { kind: 'customer' as const, id: before.party_id, name: before.party_name };
      const entries =
        provision !== null
          ? [entry(fee, v.amount, 0), entry(provision, 0, v.amount)]
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
      financeAudit(this.store, user, { action: v.kind, entity: 'fin_bad_debts', id: adjustment, before: null, after });
      return after;
    });
  }
  getTerms(actor: Actor | null, rawKind: unknown, rawId: unknown) {
    financeActor(actor);
    const found = partyTerms(this.store.db, partyKind.parse(rawKind), String(id.parse(rawId)));
    return found ? withOptions(found) : null;
  }

  terms(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ kind: partyKind.optional(), partyId: z.string().max(100).optional() })
      .parse(raw);
    const page = pageSql(
      this.store.db,
      {
        schema: termsListRow,
        sql: `SELECT t.*,coalesce((SELECT sum(o.amount_cents-${allocationSum('a.obligation_id=o.id', true)})
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind='receivable' AND o.party_id=t.party_id AND (o.opening_id IS NOT NULL OR v.status='posted')),0) AS receivable
      FROM fin_party_terms t WHERE (? IS NULL OR t.kind=?) AND (? IS NULL OR t.party_id=?)`,
        values: [q.kind ?? null, q.kind ?? null, q.partyId ?? null, q.partyId ?? null],
        order: 'party_id',
      },
      raw,
    );
    // 列表上要显示现结优惠、利息、保证金，约定和读一个单位一样解析好给页面
    return { ...page, rows: page.rows.map(withOptions) };
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
    return financeWrite(this.store, user, { action: 'obligations.create', input: v, result: rows.fin_obligations }, () => {
      const db = this.store.db,
        ar = v.kind === 'receivable';
      const name = partyName(db, ar ? 'customer' : 'supplier', v.partyId);
      const terms = partyTerms(db, ar ? 'customer' : 'supplier', String(v.partyId));
      const due = v.dueDate === undefined ? dueDate(v.date, terms) : v.dueDate;
      const account = ar ? '1122' : '2202';
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
          .run(v.kind, aux.id, name, v.date, due, v.amount, v.description, termsSnapshotText(terms)).lastInsertRowid,
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
      financeAudit(this.store, user, { action: 'create', entity: 'fin_obligations', id: key, before: null, after });
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
      bands = readFinanceSettings(db).agingDays;
    // 账龄只算已记账：红字凭证还没记账的冲销不算，原往来照样挂着，reversal_pending 标出来给界面写一句说明
    const sql = `SELECT o.*, o.amount_cents-${allocationSum('a.obligation_id=o.id AND a.date<=?', true)} AS balance,
      ${isReversed('o', " AND rv.status<>'posted'")} AS reversal_pending,
      CAST(julianday(?) - julianday(${q.basis === 'due' ? 'coalesce(o.due_date,o.date)' : obligationBaseDate('o')}) AS INTEGER) AS days,
      CAST(julianday(o.due_date)-julianday(?) AS INTEGER) AS days_to_due FROM fin_obligations o
      LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE o.date<=? AND o.kind=?
      AND o.amount_cents>0 AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status='posted')
      AND NOT ${isReversed('o', " AND rv.status='posted' AND r.date<=?")}`;
    const args = [q.date, q.date, q.date, q.date, q.kind, q.date];
    // 分档在这里算一次，逐笔和合计都读 bucket 列
    const filtered =
      `SELECT *,${agingBucket(bands.length)} AS bucket FROM (${sql}) WHERE balance>0` +
      (q.overdue === '1' ? ' AND days_to_due<0' : '');
    const filteredArgs = [...bands, ...args];
    // 欠得最久的在前（账龄天数从大到小），同样天数按单据日期、编号排，翻页稳定
    const data = pageSql(db, { schema: agingRow, sql: filtered, values: filteredArgs, order: 'days,date,id' }, raw);
    // 合计按档排，“没有账期”放最后
    const totals = many(
      db,
      agingTotal,
      'SELECT bucket,sum(balance) AS balance,count(*) AS count FROM (' + filtered + ') GROUP BY bucket ORDER BY bucket<0,bucket',
      ...filteredArgs,
    );
    return { ...data, bands, totals };
  }

  saveTerms(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      input = terms.parse(raw);
    return financeWrite(this.store, user, { action: 'terms.save', input, result: rows.fin_party_terms }, () => {
      const db = this.store.db;
      const name = partyName(db, input.kind, input.partyId);
      const id = String(input.partyId),
        before = partyTerms(db, input.kind, id);
      if (before) {
        if (input.version === undefined) financeError('这个单位已经设过账期，请在账期详情里编辑。', 409);
        checkVersion(before, input.version);
        db.prepare(
          `UPDATE fin_party_terms SET term_days=?,credit_limit=?,party_name=?,tax_rate=?,tax_mode=?,
          term_type=?,term_months=?,payment_day=?,cutoff_day=?,options=?,version=version+1
          WHERE kind=? AND party_id=?`,
        ).run(
          input.termDays ?? 0,
          input.creditLimit,
          name,
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
        if (input.version !== undefined) financeError('这个单位还没设账期，请新建。', 404);
        db.prepare(
          `INSERT INTO fin_party_terms(kind,party_id,party_name,term_days,credit_limit,tax_rate,tax_mode,
            term_type,term_months,payment_day,cutoff_day,options) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          input.kind,
          id,
          name,
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
      const after = { ...expectRow(partyTerms(db, input.kind, id), '这个单位的账期') };
      financeAudit(
        this.store,
        user,
        {
          action: 'save',
          entity: 'fin_party_terms',
          id: input.partyId,
          before: before ?? null,
          after,
        },
      );
      return after;
    });
  }

  obligations(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    return obligationList(
      this.store.db,
      z.object({ kind, partyId: z.string().max(100).optional() }).parse(raw),
      parsePaging(raw),
    );
  }
}
