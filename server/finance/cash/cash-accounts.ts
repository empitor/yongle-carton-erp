/** 资金账户：列表和余额、新增修改、资金日报（期初、当天收入支出、期末）。 */
import { z } from 'zod';
import { dateSchema, today } from '../../../shared/core/index.js';
import { accountCodeSchema, versionSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, one, rows } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { id, label, pageSql, request, row } from '../base/query.js';
import { cashAccountKinds } from '../base/stored-values.js';

/** 按类型筛选时类型文字最长几个字 */
const KIND_FILTER_MAX = 20;
/** 资金账户列表一行：账户加截至那天的余额 */
const accountRow = rows.fin_cash_accounts.extend({ balance: z.number() });
const cash = rows.fin_cash_accounts.shape;
/** 资金日报一行：期初、当天收入、支出、期末，期末是负数时 insufficient 为 1 */
const dailyRow = z.object({
  id: cash.id,
  name: cash.name,
  kind: cash.kind,
  account_code: cash.account_code,
  income: z.number(),
  expense: z.number(),
  opening: z.number(),
  closing: z.number(),
  insufficient: z.number(),
});
const accountInput = request.extend({
  id: id.optional(),
  version: versionSchema.optional(),
  name: label,
  kind: z.enum(cashAccountKinds),
  accountCode: accountCodeSchema,
  lastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .default(null),
  enabled: z.boolean().default(true),
});

export class FinanceCashAccounts {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  accounts(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ date: dateSchema.default(() => today()), kind: z.string().max(KIND_FILTER_MAX).optional() })
      .parse(raw);
    return pageSql(
      this.db,
      {
        schema: accountRow,
        sql: `SELECT a.*, coalesce((SELECT sum(debit-credit) FROM fin_opening
      WHERE account_code=a.account_code AND auxiliary_id IS NULL),0)+coalesce((
      SELECT sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(e.debit-e.credit))
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
      WHERE v.status='posted' AND v.date<=? AND e.account_code=a.account_code),0) AS balance
      FROM fin_cash_accounts a WHERE (? IS NULL OR a.kind=?)`,
        values: [q.date, q.kind ?? null, q.kind ?? null],
        order: 'id',
      },
      raw,
    );
  }

  saveAccount(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = accountInput.parse(raw);
    if (v.kind !== 'bank' && v.lastFour) financeError('只有银行账户可保存账号后四位。');
    return financeWrite(this.store, user, { action: 'cash.account', input: v, result: rows.fin_cash_accounts }, () => {
      const before = v.id ? row(this.db, 'fin_cash_accounts', v.id) : null;
      this.checkAccount(v);
      const values = [v.name, v.kind, v.accountCode, v.lastFour, Number(v.enabled)] as const;
      let key: number;
      if (before) {
        checkVersion(before, v.version ?? 0);
        if (v.accountCode !== before.account_code || v.kind !== before.kind)
          financeError('资金账户科目和类型须保持一致。');
        key = before.id;
        this.db
          .prepare(
            'UPDATE fin_cash_accounts SET name=?,kind=?,account_code=?,last_four=?,enabled=?,version=version+1 WHERE id=?',
          )
          .run(...values, key);
      } else {
        key = Number(
          this.db
            .prepare('INSERT INTO fin_cash_accounts(name,kind,account_code,last_four,enabled) VALUES(?,?,?,?,?)')
            .run(...values).lastInsertRowid,
        );
      }
      const after = row(this.db, 'fin_cash_accounts', key);
      financeAudit(this.store, user, { action: 'save', entity: 'fin_cash_accounts', id: key, before, after });
      return after;
    });
  }

  /** 资金账户要对应一个启用的末级资产科目，类型和科目对得上，名称和科目都没被别的账户用 */
  private checkAccount(v: z.output<typeof accountInput>) {
    const account = one(
      this.db,
      rows.fin_accounts,
      `SELECT * FROM fin_accounts a WHERE code=? AND enabled=1 AND
      auxiliary IS NULL AND category='asset' AND NOT EXISTS(SELECT 1 FROM fin_accounts WHERE parent_code=a.code)`,
      v.accountCode,
    );
    if (!account) financeError('资金账户须对应启用的末级资金科目。');
    // 科目对、只是和类型对不上：说清是不匹配、该选哪类科目
    if (v.kind === 'bank' && account.cash_kind !== 'bank') financeError('类型和科目对不上：银行账户要选银行存款类科目。');
    if (v.kind === 'cash' && account.cash_kind !== 'cash') financeError('类型和科目对不上：现金账户要选库存现金类科目。');
    if (exists(this.db, 'SELECT 1 FROM fin_cash_accounts WHERE (name=? OR account_code=?) AND id<>?', v.name, v.accountCode, v.id ?? 0))
      financeError('资金账户名称或对应科目已使用。', 409);
  }

  daily(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ date: dateSchema.default(() => today()) }).parse(raw);
    // 当天收入、支出按实际进出算：红字凭证（分录和原凭证同方向、按负数计）冲减它冲的那一边，不当成反方向的进出。
    // 比如撤销核销那天，原收款凭证红冲 1,000、转预收又进 1,000，收入净增 0，支出不多出 1,000。
    // 某一边冲减后成了负数（冲的是前几天的收款），差额挪到另一边，收入、支出都不显示负数；期末不受影响。
    const sql = `WITH flow AS (
      SELECT e.account_code,v.date,(e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount,
        e.debit-e.credit>0 AS inward
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.date<=?
    ), activity AS (
      SELECT account_code,sum(CASE WHEN date<? THEN amount ELSE 0 END) AS prior,
        sum(CASE WHEN date=? AND inward THEN amount ELSE 0 END) AS inflow,
        sum(CASE WHEN date=? AND NOT inward THEN -amount ELSE 0 END) AS outflow FROM flow GROUP BY account_code
    ), net AS (
      SELECT account_code,prior,max(inflow,0)+max(-outflow,0) AS income,max(outflow,0)+max(-inflow,0) AS expense FROM activity
    ) SELECT a.id,a.name,a.kind,a.account_code,coalesce(f.income,0) AS income,coalesce(f.expense,0) AS expense,
      coalesce((SELECT sum(debit-credit) FROM fin_opening WHERE account_code=a.account_code AND auxiliary_id IS NULL),0)
        +coalesce(f.prior,0) AS opening FROM fin_cash_accounts a LEFT JOIN net f ON f.account_code=a.account_code`;
    return pageSql(
      this.db,
      {
        schema: dailyRow,
        sql: `SELECT *,opening+income-expense AS closing,(opening+income-expense<0) AS insufficient FROM (${sql})`,
        values: [q.date, q.date, q.date, q.date],
        order: 'id',
      },
      raw,
    );
  }
}
