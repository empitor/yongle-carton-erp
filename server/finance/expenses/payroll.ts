import { z } from 'zod';
import { accountCodeSchema, centsSchema, periodSchema, versionSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { many, one, rows } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { FinanceLedger } from '../ledger/ledger.js';
import { entryNet, expectedVoucher, periodJob, periodJobResult, sameNet, withdrawJob } from '../base/jobs.js';
import { entry, label, pageSql, request, type FinancePage } from '../base/query.js';
import { sheetRows, yuan } from '../base/sheet-import.js';
import { financeTemplate } from '../base/template.js';
import { snapshotBeforeDestructive } from '../../core/index.js';
import { endOfMonth } from '../base/periods.js';
import { expectRow } from '../base/finance-rows.js';
import { accrualDetails, payrollJob, readAccrual } from './payroll-jobs.js';
import { paidOut, payInput, paymentStatus, payPayroll } from './payroll-pay.js';

/** 一张工资表最多几个人 */
const MAX_EMPLOYEES = 1000;
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
/** 工资表按部门汇总的一行 */
const departmentRow = z.object({
  department: z.string(),
  employees: z.number(),
  gross: z.number(),
  net: z.number(),
  social: z.number(),
  housing: z.number(),
  tax: z.number(),
  employer_social: z.number(),
  employer_housing: z.number(),
});
type DepartmentTotals = z.output<typeof departmentRow>;
type PayrollRow = z.output<typeof rows.fin_payroll>;
/** 工资表列表的筛选：哪个月、哪个部门（翻页参数另从同一份查询里读） */
type PayrollQuery = { period: string; department?: string };
/** 计提按费用科目分组的合计 */
const costGroup = z.object({
  account_code: z.string(),
  cost: z.number(),
  social: z.number(),
  housing: z.number(),
  tax: z.number(),
  net: z.number(),
});
/** 挂账科目（没另选的用模板里的） */
type PayrollAccounts = z.output<typeof accrualDetails>['accounts'];
const saved = z.object({ rows: z.array(rows.fin_payroll) });
const accrued = periodJobResult(accrualDetails);

export class FinancePayroll {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }
  /** detail=1：员工明细（要结账权限） */
  list(actor: Actor | null, raw: PayrollQuery & { detail: '1' }): FinancePage<PayrollRow>;
  /** 不带 detail（或 detail=0）：按部门汇总 */
  list(actor: Actor | null, raw: PayrollQuery & { detail?: '0' }): FinancePage<DepartmentTotals>;
  /** 地址上的查询参数：哪一种由 detail 定 */
  list(actor: Actor | null, raw: unknown): FinancePage<PayrollRow> | FinancePage<DepartmentTotals>;
  list(actor: Actor | null, raw: unknown): FinancePage<PayrollRow> | FinancePage<DepartmentTotals> {
    const q = z
      .object({
        period: periodSchema,
        department: label.optional(),
        detail: z.enum(['1', '0']).default('0'),
      })
      .parse(raw);
    financeActor(actor, q.detail === '1' ? 'finance:close' : 'finance:view');
    const where = 'FROM fin_payroll WHERE period=? AND (? IS NULL OR department=?)';
    const values = [q.period, q.department ?? null, q.department ?? null];
    return q.detail === '1'
      ? pageSql(this.db, { schema: rows.fin_payroll, sql: 'SELECT * ' + where, values, order: 'department' }, raw)
      : pageSql(
          this.db,
          {
            schema: departmentRow,
            sql: `SELECT department,count(*) AS employees,sum(gross) AS gross,
      sum(net) AS net,sum(social) AS social,sum(housing) AS housing,sum(tax) AS tax,
      sum(employer_social) AS employer_social,sum(employer_housing) AS employer_housing ${where} GROUP BY department`,
            values,
            order: 'department',
          },
          raw,
        );
  }
  private employee(period: string, employeeId: string) {
    return one(this.db, rows.fin_payroll, 'SELECT * FROM fin_payroll WHERE period=? AND employee_id=?', period, employeeId);
  }
  /**
   * 保存工资表。replace 是导入整张工资表：这个月按文件整月覆盖，文件里没写版本列的按当前版本覆盖，
   * 文件里没有的员工删掉（删前留了快照和审计）。
   */
  save(actor: Actor | null, raw: unknown, replace = false) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({ period: periodSchema, rows: z.array(payrollRow).min(1).max(MAX_EMPLOYEES) })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'payroll.save', input: v, result: saved }, () => {
      // 计提以后还能改（月份没结账就行）：改了以后结账检查会提示重做工资计提。
      this.ledger.openPeriod(user, endOfMonth(v.period));
      if (new Set(v.rows.map((r) => r.employeeId)).size !== v.rows.length) financeError('工资员工重复。');
      const list = v.rows.map((r) => {
        const before = this.employee(v.period, r.employeeId);
        if (before) checkVersion(before, r.version ?? (replace ? before.version : 0));
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
        const after = expectRow(this.employee(v.period, r.employeeId), '工资记录');
        financeAudit(this.store, user, { action: 'save', entity: 'fin_payroll', id: after.id, before: before ?? null, after });
        return { ...after };
      });
      if (replace) this.removeMissing(user, v.period, v.rows.map((r) => r.employeeId));
      return { rows: list };
    });
  }
  /** 整月覆盖：文件里没有的员工删掉，逐条记审计 */
  private removeMissing(user: Actor, period: string, employeeIds: string[]) {
    const removed = many(
      this.db,
      rows.fin_payroll,
      'SELECT * FROM fin_payroll WHERE period=? AND employee_id NOT IN (SELECT value FROM json_each(?))',
      period,
      JSON.stringify(employeeIds),
    );
    for (const item of removed) {
      this.db.prepare('DELETE FROM fin_payroll WHERE id=?').run(item.id);
      financeAudit(this.store, user, { action: 'replace_delete', entity: 'fin_payroll', id: item.id, before: item, after: null });
    }
  }
  async upload(actor: Actor | null, raw: unknown, bytes: Buffer) {
    financeActor(actor, 'finance:close');
    const v = request.extend({ period: periodSchema, format: z.enum(['csv', 'xlsx']) }).parse(raw);
    const lines = await sheetRows(bytes, v.format, 1);
    const sheet = lines.map((c) => ({
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
    // 重新导入是整月覆盖：文件里少了的员工会删掉，删之前留一份快照
    const listed = new Set(sheet.map((r) => String(r.employeeId)));
    if (
      many(this.db, rows.fin_payroll.pick({ employee_id: true }), 'SELECT employee_id FROM fin_payroll WHERE period=?', v.period).some(
        (r) => !listed.has(r.employee_id),
      )
    )
      snapshotBeforeDestructive(this.store, 'finance-payroll-replace');
    return this.save(actor, { period: v.period, requestId: v.requestId, rows: sheet }, true);
  }
  /** 按现在的工资表算计提分录，只读不写。 */
  private plan(period: string, accounts: PayrollAccounts = {}) {
    const groups = many(
      this.db,
      costGroup,
      `SELECT account_code,sum(gross+employer_social+employer_housing) AS cost,
      sum(social+employer_social) AS social,sum(housing+employer_housing) AS housing,sum(tax) AS tax,sum(net) AS net
      FROM fin_payroll WHERE period=? GROUP BY account_code`,
      period,
    );
    const total = (key: 'cost' | 'social' | 'housing' | 'tax' | 'net') => groups.reduce((n, r) => n + r[key], 0);
    const cost = total('cost'),
      net = total('net');
    const credits = new Map<string, number>();
    const mapping = financeTemplate(this.store, 'payroll'),
      wagesAccount = mapping('wages');
    for (const [code, n] of [
      [wagesAccount, net],
      [accounts.socialAccount ?? mapping('social'), total('social')],
      [accounts.housingAccount ?? mapping('housing'), total('housing')],
      [accounts.taxAccount ?? mapping('tax'), total('tax')],
    ] as const)
      credits.set(code, (credits.get(code) ?? 0) + n);
    const entries = [
      ...groups.filter((r) => r.cost).map((r) => entry(r.account_code, r.cost, 0)),
      ...Array.from(credits)
        .filter(([, amount]) => amount)
        .map(([code, amount]) => entry(code, 0, amount)),
    ];
    return {
      entries,
      cost,
      net,
      wagesAccount,
      totals: { social: total('social'), housing: total('housing'), tax: total('tax') },
    };
  }

  /**
   * 结账检查：工资计提以后工资表改了，按现在的工资表重算和那次不一样，要重做。
   * 比各部门费用科目、实发和代扣合计；挂账科目当时可能改选过，只比金额。
   */
  accrualStale(period: string) {
    const job = payrollJob(this.db, period, 'payroll');
    if (!job) return null;
    const details = readAccrual(job);
    const plan = this.plan(period, details.accounts);
    const debit = (list: { accountCode: string; debit: number; credit: number }[]) =>
      entryNet(list.filter((e) => e.debit > 0));
    const recorded = job.voucher_id
      ? many(
          this.db,
          rows.fin_entries.pick({ account_code: true, debit: true, credit: true }),
          'SELECT account_code,debit,credit FROM fin_entries WHERE voucher_id=?',
          job.voucher_id,
        ).map((e) => ({ accountCode: e.account_code, debit: e.debit, credit: e.credit }))
      : [];
    const changed =
      !sameNet(debit(plan.entries), debit(recorded)) ||
      details.net !== plan.net ||
      details.totals.social !== plan.totals.social ||
      details.totals.housing !== plan.totals.housing ||
      details.totals.tax !== plan.totals.tax;
    return changed ? '工资计提以后，工资表改过。' : null;
  }

  confirm(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close'),
      v = request
        .extend({
          period: periodSchema,
          socialAccount: accountCodeSchema.optional(),
          housingAccount: accountCodeSchema.optional(),
          taxAccount: accountCodeSchema.optional(),
          /** 工资表改过，撤回原来的计提（已记账的红冲）按现在的工资表重做 */
          redo: z.boolean().default(false),
          expectedVoucherId: expectedVoucher,
        })
        .parse(raw);
    return financeWrite(this.store, user, { action: 'payroll.confirm', input: v, result: accrued }, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      let accounts: PayrollAccounts = {
        socialAccount: v.socialAccount,
        housingAccount: v.housingAccount,
        taxAccount: v.taxAccount,
      };
      if (v.redo) {
        const previous = withdrawJob(this.store, user, this.ledger, {
          period: v.period,
          kind: 'payroll',
          reason: '重做工资计提',
          expectedVoucherId: v.expectedVoucherId,
        });
        // 没另选挂账科目时沿用上次的
        const used = readAccrual(previous.job).accounts;
        accounts = {
          socialAccount: v.socialAccount ?? used.socialAccount,
          housingAccount: v.housingAccount ?? used.housingAccount,
          taxAccount: v.taxAccount ?? used.taxAccount,
        };
      }
      const { entries, cost, net, wagesAccount, totals } = this.plan(v.period, accounts);
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
      return periodJob(this.store, user, {
        period: v.period,
        kind: 'payroll',
        voucher,
        schema: accrualDetails,
        details: { cost, net, wagesAccount, totals, accounts },
      });
    });
  }
  /** 这个月工资发了多少、还剩多少（见 payroll-pay.ts） */
  paymentStatus(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    return paymentStatus(this.db, period);
  }

  /** 发一次工资（见 payroll-pay.ts） */
  pay(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      v = payInput.parse(raw);
    return financeWrite(this.store, user, { action: 'payroll.pay', input: v, result: paidOut }, () =>
      payPayroll(this.store, this.ledger, user, v),
    );
  }
}
