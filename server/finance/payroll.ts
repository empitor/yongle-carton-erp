import { z } from 'zod';
import {
  accountCodeSchema,
  centsSchema,
  periodSchema,
  versionSchema,
} from '../../shared/finance.js';
import { dateSchema } from '../../shared/domain.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { FinanceSettlements } from './settlements.js';
import { periodJob } from './jobs.js';
import { endOfMonth, entry, id, label, pageSql, request, row } from './query.js';
import { sheetRows, yuan } from './bank.js';
import { financeTemplate } from './template.js';

const payrollRow = z
  .strictObject({
    employeeId: label,
    employeeName: label,
    department: label,
    accountCode: accountCodeSchema,
    gross: centsSchema,
    social: centsSchema,
    housing: centsSchema,
    tax: centsSchema,
    net: centsSchema,
    employerSocial: centsSchema,
    employerHousing: centsSchema,
    version: versionSchema.optional(),
  })
  .refine(
    (v) => BigInt(v.gross) === BigInt(v.social) + BigInt(v.housing) + BigInt(v.tax) + BigInt(v.net),
    '应发须等于实发和个人扣款之和。',
  );

export class FinancePayroll {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }
  list(actor: Actor | null, raw: unknown) {
    const q = z
      .object({
        period: periodSchema,
        department: label.optional(),
        detail: z.enum(['1', '0']).default('0'),
      })
      .parse(raw);
    financeActor(actor, q.detail === '1' ? 'finance:close' : 'finance:view');
    const where = 'FROM fin_payroll WHERE period=? AND (? IS NULL OR department=?)';
    return pageSql(
      this.db,
      q.detail === '1'
        ? 'SELECT * ' + where
        : `SELECT department,count(*) AS employees,sum(gross) AS gross,
      sum(net) AS net,sum(social) AS social,sum(housing) AS housing,sum(tax) AS tax,
      sum(employer_social) AS employer_social,sum(employer_housing) AS employer_housing ${where} GROUP BY department`,
      [q.period, q.department ?? null, q.department ?? null],
      raw,
      'department',
    );
  }
  save(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({ period: periodSchema, rows: z.array(payrollRow).min(1).max(1000) })
      .parse(raw);
    return financeWrite(this.store, user, 'payroll.save', v, () => {
      this.ledger.openPeriod(user, endOfMonth(v.period));
      if (
        this.db
          .prepare("SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='payroll'")
          .get(v.period)
      )
        financeError('工资已确认。', 409);
      if (new Set(v.rows.map((r) => r.employeeId)).size !== v.rows.length)
        financeError('工资员工重复。');
      const rows = v.rows.map((r) => {
        const before = this.db
          .prepare('SELECT * FROM fin_payroll WHERE period=? AND employee_id=?')
          .get(v.period, r.employeeId);
        if (before) checkVersion(before, r.version ?? 0);
        else if (r.version) financeError('工资记录不存在。', 404);
        this.db
          .prepare(
            `INSERT INTO fin_payroll(period,employee_id,employee_name,department,account_code,gross,social,housing,tax,net,employer_social,employer_housing)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period,employee_id) DO UPDATE SET employee_name=excluded.employee_name,
          department=excluded.department,account_code=excluded.account_code,gross=excluded.gross,social=excluded.social,
          housing=excluded.housing,tax=excluded.tax,net=excluded.net,employer_social=excluded.employer_social,
          employer_housing=excluded.employer_housing,version=version+1`,
          )
          .run(
            v.period,
            r.employeeId,
            r.employeeName,
            r.department,
            r.accountCode,
            r.gross,
            r.social,
            r.housing,
            r.tax,
            r.net,
            r.employerSocial,
            r.employerHousing,
          );
        const after = this.db
          .prepare('SELECT * FROM fin_payroll WHERE period=? AND employee_id=?')
          .get(v.period, r.employeeId)!;
        financeAudit(
          this.store,
          user,
          'save',
          'fin_payroll',
          Number(after.id),
          before ?? null,
          after,
        );
        return { ...after };
      });
      return { rows };
    });
  }
  async upload(actor: Actor | null, raw: unknown, bytes: Buffer) {
    financeActor(actor, 'finance:close');
    const v = request.extend({ period: periodSchema, format: z.enum(['csv', 'xlsx']) }).parse(raw);
    const lines = await sheetRows(bytes, v.format, 1);
    const rows = lines.map((c) => ({
      employeeId: c[0],
      employeeName: c[1],
      department: c[2],
      accountCode: c[3],
      gross: yuan(c[4] ?? ''),
      social: yuan(c[5] ?? ''),
      housing: yuan(c[6] ?? ''),
      tax: yuan(c[7] ?? ''),
      net: yuan(c[8] ?? ''),
      employerSocial: yuan(c[9] ?? ''),
      employerHousing: yuan(c[10] ?? ''),
      version: c[11] ? Number(c[11]) : undefined,
    }));
    return this.save(actor, { period: v.period, requestId: v.requestId, rows });
  }
  confirm(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close'),
      v = request
        .extend({
          period: periodSchema,
          socialAccount: accountCodeSchema.optional(),
          housingAccount: accountCodeSchema.optional(),
          taxAccount: accountCodeSchema.optional(),
        })
        .parse(raw);
    return financeWrite(this.store, user, 'payroll.confirm', v, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      const groups = this.db
        .prepare(
          `SELECT account_code,sum(gross+employer_social+employer_housing) AS cost,
        sum(social+employer_social) AS social,sum(housing+employer_housing) AS housing,sum(tax) AS tax,sum(net) AS net
        FROM fin_payroll WHERE period=? GROUP BY account_code`,
        )
        .all(v.period);
      const total = (key: string) => groups.reduce((n, r) => n + Number(r[key]), 0);
      const cost = total('cost'),
        net = total('net');
      const credits = new Map<string, number>();
      const mapping = financeTemplate(this.store, 'payroll'),
        wagesAccount = mapping('wages');
      for (const [code, n] of [
        [wagesAccount, net],
        [v.socialAccount ?? mapping('social'), total('social')],
        [v.housingAccount ?? mapping('housing'), total('housing')],
        [v.taxAccount ?? mapping('tax'), total('tax')],
      ] as const)
        credits.set(code, (credits.get(code) ?? 0) + n);
      const entries = [
        ...groups
          .filter((r) => r.cost)
          .map((r) => entry(String(r.account_code), Number(r.cost), 0)),
        ...Array.from(credits)
          .filter(([, amount]) => amount)
          .map(([code, amount]) => entry(code, 0, amount)),
      ];
      const voucher = cost
        ? Number(
            this.ledger.createLinked(
              user,
              'payroll',
              Number(v.period.replace('-', '')),
              { date, requestId: v.requestId, description: '工资计提', entries },
              'finance:close',
            ).header.id,
          )
        : null;
      return periodJob(this.store, user, v.period, 'payroll', voucher, { cost, net, wagesAccount });
    });
  }
  pay(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      v = request.extend({ period: periodSchema, date: dateSchema, accountId: id }).parse(raw);
    return financeWrite(this.store, user, 'payroll.pay', v, () => {
      const run = this.db
        .prepare("SELECT * FROM fin_period_jobs WHERE period=? AND kind='payroll'")
        .get(v.period);
      if (
        !run?.voucher_id ||
        this.ledger.get(user, run.voucher_id).header.status !== 'posted' ||
        v.date < endOfMonth(v.period)
      )
        financeError('请先确认并记账工资计提。');
      const payroll = JSON.parse(String(run.details));
      const amount = Number(payroll.net);
      if (!amount) financeError('没有应发放净额。');
      const cash = new FinanceSettlements(this.store);
      const draft = cash.writeCash(user, {
        requestId: v.requestId,
        kind: 'outlay',
        accountId: v.accountId,
        date: v.date,
        amount,
        method: '银行',
        description: '工资发放 ' + v.period,
        counterAccount: String(payroll.wagesAccount),
        cashFlow: '支付给职工的现金',
      });
      const previous = this.db
        .prepare("SELECT * FROM fin_period_jobs WHERE period=? AND kind='payroll_pay'")
        .get(v.period);
      if (
        previous &&
        row(this.db, 'fin_cash_documents', Number(JSON.parse(String(previous.details)).cashId))
          .status !== 'cancelled'
      )
        financeError('该期间工资已发放。', 409);
      cash.confirm(user, draft.id, {
        version: 1,
        requestId: 'payroll-cash:' + v.period + ':' + draft.id,
      });
      if (previous) {
        const voucherId = row(this.db, 'fin_cash_documents', Number(draft.id)).voucher_id;
        const details = { cashId: draft.id, amount };
        this.db
          .prepare(
            "UPDATE fin_period_jobs SET voucher_id=?,details=? WHERE period=? AND kind='payroll_pay'",
          )
          .run(voucherId, JSON.stringify(details), v.period);
        const after = { period: v.period, kind: 'payroll_pay', voucherId, details };
        financeAudit(this.store, user, 'payment_replace', 'fin_period_jobs', null, previous, after);
        return after;
      }
      return periodJob(
        this.store,
        user,
        v.period,
        'payroll_pay',
        Number(row(this.db, 'fin_cash_documents', Number(draft.id)).voucher_id),
        { cashId: draft.id, amount },
      );
    });
  }
}
