import { z } from 'zod';
import { dateSchema } from '../../shared/domain.js';
import { accountCodeSchema, versionSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { FinanceSettlements } from './settlements.js';
import { financeTemplate } from './template.js';
import { edit, entry, id, label, money, pageSql, request, row } from './query.js';

export class FinanceExpenses {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }
  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        status: z.string().max(30).optional(),
        employeeId: z.string().max(100).optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
      })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT * FROM fin_expenses WHERE (? IS NULL OR status=?)
      AND (? IS NULL OR employee_id=?) AND date BETWEEN ? AND ?`,
      [
        q.status ?? null,
        q.status ?? null,
        q.employeeId ?? null,
        q.employeeId ?? null,
        q.from ?? '0000-01-01',
        q.to ?? '9999-12-31',
      ],
      raw,
      'date',
    );
  }
  save(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        id: id.optional(),
        version: versionSchema.optional(),
        employeeId: label,
        employeeName: label,
        department: label,
        date: dateSchema,
        accountCode: accountCodeSchema,
        amount: money,
        description: label,
        invoiceId: id.optional(),
        attachmentId: id.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'expenses.save', v, () => {
      const before = v.id ? row(this.db, 'fin_expenses', v.id) : null;
      this.ledger.openPeriod(user, v.date);
      if (before) {
        checkVersion(before, v.version ?? 0);
        if (!['draft', 'rejected'].includes(String(before.status)))
          financeError('该费用状态不可编辑。');
      }
      const args = [
        v.employeeId,
        v.employeeName,
        v.department,
        v.date,
        v.accountCode,
        v.amount,
        v.description,
        v.invoiceId ?? null,
        v.attachmentId ?? null,
      ];
      const key =
        v.id ??
        Number(
          this.db
            .prepare(
              `INSERT INTO fin_expenses(employee_id,employee_name,department,date,account_code,amount_cents,
        description,invoice_id,attachment_id,status) VALUES(?,?,?,?,?,?,?,?,?,'draft')`,
            )
            .run(...args).lastInsertRowid,
        );
      if (before)
        this.db
          .prepare(
            `UPDATE fin_expenses SET employee_id=?,employee_name=?,department=?,date=?,account_code=?,amount_cents=?,
        description=?,invoice_id=?,attachment_id=?,status='draft',version=version+1 WHERE id=?`,
          )
          .run(...args, key);
      const after = row(this.db, 'fin_expenses', key);
      financeAudit(this.store, user, 'save', 'fin_expenses', key, before, after);
      return after;
    });
  }
  transition(actor: Actor | null, rawId: unknown, raw: unknown) {
    const key = id.parse(rawId);
    const v = edit
      .extend({
        action: z.enum(['submit', 'approve', 'reject', 'pay']),
        date: dateSchema.optional(),
        accountId: id.optional(),
        reason: label.optional(),
      })
      .parse(raw);
    const permission =
      v.action === 'pay'
        ? 'finance:cash'
        : v.action === 'submit'
          ? 'finance:edit'
          : 'finance:approve';
    const user = financeActor(actor, permission);
    return financeWrite(this.store, user, 'expenses.transition', { ...v, key }, () => {
      const before = row(this.db, 'fin_expenses', key);
      checkVersion(before, v.version);
      const status = { submit: 'pending', approve: 'approved', reject: 'rejected', pay: 'paid' }[
        v.action
      ];
      const expected = { submit: 'draft', approve: 'pending', reject: 'pending', pay: 'approved' }[
        v.action
      ];
      if (before.status !== expected) financeError('费用单当前状态不允许此操作。', 409);
      this.ledger.openPeriod(user, String(v.date ?? before.date));
      let voucher = before.voucher_id,
        cash = before.cash_id;
      if (v.action === 'reject' && !v.reason) financeError('请填写驳回原因。');
      if (v.action === 'approve') {
        const amount = Number(before.amount_cents);
        voucher = this.ledger.createLinked(
          user,
          'expense',
          key,
          {
            requestId: v.requestId,
            date: before.date,
            description: before.description,
            entries: [
              entry(String(before.account_code), amount, 0),
              entry(financeTemplate(this.store, 'expense')('liability'), 0, amount),
            ],
          },
          permission,
        ).header.id;
      }
      if (v.action === 'pay') {
        if (!v.accountId || !v.date || v.date < String(before.date))
          financeError('请填写合法付款账户及日期。');
        const accrued = this.ledger.get(user, before.voucher_id);
        if (accrued.header.status !== 'posted') financeError('请先记账费用凭证。');
        const service = new FinanceSettlements(this.store);
        const saved = service.writeCash(user, {
          requestId: v.requestId,
          kind: 'outlay',
          accountId: v.accountId,
          date: v.date,
          amount: Number(before.amount_cents),
          method: '其他',
          description: String(before.description),
          counterAccount: String(accrued.entries.find((e) => Number(e.credit) > 0)?.account_code),
          cashFlow: '支付其他经营活动现金',
        });
        cash = saved.id;
        service.confirm(user, cash, {
          version: 1,
          requestId: 'expense-pay:' + key + ':' + v.version,
        });
      }
      this.db
        .prepare(
          'UPDATE fin_expenses SET status=?,voucher_id=?,cash_id=?,version=version+1 WHERE id=?',
        )
        .run(status, voucher, cash, key);
      const after = row(this.db, 'fin_expenses', key);
      financeAudit(this.store, user, v.action, 'fin_expenses', key, before, {
        ...after,
        reason: v.reason,
      });
      return after;
    });
  }
  advance(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash');
    const v = request
      .extend({
        date: dateSchema,
        accountId: id,
        employeeId: label,
        employeeName: label,
        amount: money,
        kind: z.enum(['loan', 'repayment']),
        description: label,
        accountCode: accountCodeSchema,
      })
      .parse(raw);
    return financeWrite(this.store, user, 'expenses.advance', v, () => {
      const account = row(this.db, 'fin_cash_accounts', v.accountId);
      if (!account.enabled || !v.accountCode.startsWith('1221'))
        financeError('员工借还款须使用启用账户和其他应收科目。');
      const subject = this.db.prepare('SELECT auxiliary FROM fin_accounts WHERE code=?').get(v.accountCode);
      const employee = subject?.auxiliary === null
          ? null
          : { kind: 'employee' as const, id: v.employeeId, name: v.employeeName },
        employeeDetail = employee ? '' : `员工：${v.employeeName}（${v.employeeId}）`.slice(0, 200),
        bank = String(account.account_code);
      const entries =
        v.kind === 'loan'
          ? [
              entry(v.accountCode, v.amount, 0, employee, undefined, employeeDetail),
              entry(bank, 0, v.amount, null, '员工借款'),
            ]
          : [
              entry(bank, v.amount, 0, null, '员工还款'),
              entry(v.accountCode, 0, v.amount, employee, undefined, employeeDetail),
            ];
      const voucher = this.ledger.createLinked(
        user,
        'employee_advance',
        v.accountId,
        { requestId: v.requestId, date: v.date, description: v.description, entries },
        'finance:cash',
      );
      financeAudit(this.store, user, v.kind, 'fin_vouchers', Number(voucher.header.id), null, {
        employeeId: v.employeeId, employeeName: v.employeeName, accountId: v.accountId,
      });
      return voucher;
    });
  }
}
