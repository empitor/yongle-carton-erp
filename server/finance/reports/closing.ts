import { z } from 'zod';
import { periodSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, one, rows } from '../../core/index.js';
import { expectRow } from '../base/finance-rows.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { FinanceLedger } from '../ledger/ledger.js';
import { FinanceReports } from './reports.js';
import { expectedVoucher, periodJob, periodJobResult, withdrawJob } from '../base/jobs.js';
import { edit, entry, label, request } from '../base/query.js';
import { endOfMonth } from '../base/periods.js';
import { closingCheck } from './closing-check.js';
import { taxJobDetails, taxPlan } from './closing-tax.js';
import { reportSnapshotText } from './report-shapes.js';

const periodInput = z.object({ period: periodSchema });
/** stale=0：只看各步跑没跑（工资、资产页面用），不重算成本等看要不要重做，省得每次打开都重算 */
const lightInput = z.object({ stale: z.enum(['0', '1']).optional() });
/** 损益结转（kind='profit_close'、'annual_close'）执行记录的明细：几行分录，补结转时带上原来那张凭证 */
const profitJobDetails = z.object({ entries: z.number(), previousVoucher: z.number().nullable().optional() });
/** 这个月某一步的执行记录（没有是 undefined） */
const jobOf = (db: Store['db'], period: string, kind: 'profit_close' | 'annual_close') =>
  one(db, rows.fin_period_jobs, 'SELECT * FROM fin_period_jobs WHERE period=? AND kind=?', period, kind);
/** 凭证按月份编的关联号：2026-03 → 202603 */
const periodKey = (period: string) => Number(period.replace('-', ''));
const readPeriod = (db: Store['db'], period: string) =>
  expectRow(one(db, rows.fin_periods, 'SELECT * FROM fin_periods WHERE period=?', period), '会计期间');

export class FinanceClosing {
  private ledger: FinanceLedger;
  private reports: FinanceReports;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
    this.reports = new FinanceReports(store);
  }
  private get db() {
    return this.store.db;
  }

  check(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor),
      { period } = periodInput.parse(raw);
    const light = lightInput.parse(raw).stale === '0';
    return closingCheck(this.store, this.reports, user, { period, light });
  }

  accrueTax(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({
        period: periodSchema,
        /** 收入、费用或税率变了，撤回原来的计提（已记账的红冲）按现在的数重做 */
        redo: z.boolean().default(false),
        expectedVoucherId: expectedVoucher,
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'closing.tax', input: v, result: periodJobResult(taxJobDetails) }, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      if (v.redo)
        withdrawJob(this.store, user, this.ledger, { period: v.period, kind: 'tax', reason: '重做税费计提', expectedVoucherId: v.expectedVoucherId });
      const { entries, details } = taxPlan(this.store, user, v.period);
      const voucher = entries.length
        ? this.ledger.createLinked(
            user,
            'tax',
            periodKey(v.period),
            { date, requestId: v.requestId, description: '税费计提', entries },
            'finance:close',
          ).header.id
        : null;
      return periodJob(this.store, user, { period: v.period, kind: 'tax', voucher, schema: taxJobDetails, details });
    });
  }

  /** 损益结转要记的分录：月末把损益科目结平；12 月年度结转把本年利润（3103）转到利润分配（3104） */
  private profitEntries(user: Actor, period: string, annual: boolean) {
    if (!annual) return this.reports.profitClosingEntries(user, period);
    if (!period.endsWith('-12')) financeError('仅 12 月可结转年度利润。');
    const prior = one(
      this.db,
      z.object({ voucher_id: rows.fin_period_jobs.shape.voucher_id, status: z.string().nullable() }),
      "SELECT j.voucher_id,v.status FROM fin_period_jobs j LEFT JOIN fin_vouchers v ON v.id=j.voucher_id WHERE j.period=? AND j.kind='profit_close'",
      period,
    );
    if (!prior || (prior.voucher_id && prior.status !== 'posted')) financeError('请先记账月末损益结转。');
    const value = this.reports
      .balances(user, period)
      .filter((r) => r.account_code.startsWith('3103'))
      .reduce((n, r) => n + r.ending, 0);
    return value
      ? [
          entry('3103', Math.max(-value, 0), Math.max(value, 0)),
          entry('3104', Math.max(value, 0), Math.max(-value, 0)),
        ]
      : [];
  }

  settleProfit(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({ period: periodSchema, annual: z.boolean().default(false) })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'closing.profit', input: v, result: periodJobResult(profitJobDetails) }, () => {
      const date = endOfMonth(v.period);
      this.ledger.openPeriod(user, date);
      if (exists(this.db, "SELECT 1 FROM fin_vouchers WHERE period=? AND status NOT IN ('posted','void')", v.period))
        financeError('请先处理本期全部未记账凭证。');
      const check = this.check(user, v);
      if (check.next !== v.period) financeError('须按顺序结转损益。', 409);
      if (!check.steps.filter((s) => s.blocking && s.key !== 'profit').every((s) => s.ok))
        financeError('请先完成结账向导的前置检查。', 409);
      const entries = this.profitEntries(user, v.period, v.annual);
      const kind = v.annual ? 'annual_close' : 'profit_close';
      const previous = jobOf(this.db, v.period, kind);
      if (previous && !entries.length) financeError('该期间已结转且无新增损益。', 409);
      const voucher = entries.length
        ? this.ledger.createLinked(
            user,
            kind,
            periodKey(v.period),
            {
              date,
              requestId: v.requestId,
              description: v.annual ? '年度利润结转' : '月末损益结转',
              entries,
            },
            'finance:close',
          ).header.id
        : null;
      if (previous) {
        const details = profitJobDetails.parse({ entries: entries.length, previousVoucher: previous.voucher_id });
        this.db
          .prepare('UPDATE fin_period_jobs SET voucher_id=?,details=? WHERE period=? AND kind=?')
          .run(voucher, JSON.stringify(details), v.period, kind);
        const after = { period: v.period, kind, voucherId: voucher, details };
        financeAudit(this.store, user, { action: 'supplement', entity: 'fin_period_jobs', id: null, before: previous, after });
        return after;
      }
      return periodJob(this.store, user, { period: v.period, kind, voucher, schema: profitJobDetails, details: { entries: entries.length } });
    });
  }

  close(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = edit.extend({ period: periodSchema }).parse(raw);
    return financeWrite(this.store, user, { action: 'closing.close', input: v, result: rows.fin_periods }, () => {
      this.reports.assertReady(user, v.period);
      const before = this.check(user, v);
      if (!before.record || !before.canClose)
        financeError('结账检查未通过，或期间顺序不正确。', 409);
      checkVersion(before.record, v.version);
      if (this.reports.profitClosingEntries(user, v.period).length)
        financeError('损益结转后又有新发生，请先补齐结转。', 409);
      const document = reportSnapshotText({
        balance: this.reports.get(user, 'balance', v, false),
        profit: this.reports.get(user, 'profit', v, false),
        cashflow: this.reports.get(user, 'cashflow', v, false),
      });
      this.db
        .prepare("UPDATE fin_periods SET status='closed',version=version+1 WHERE period=?")
        .run(v.period);
      this.db
        .prepare('INSERT INTO fin_report_snapshots(period,version,document,created_at) VALUES(?,?,?,?)')
        .run(v.period, v.version + 1, document, new Date().toISOString());
      const after = readPeriod(this.db, v.period);
      financeAudit(this.store, user, { action: 'close', entity: 'fin_periods', id: null, before: before.record, after });
      return { ...after };
    });
  }

  reopen(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = edit.extend({ period: periodSchema, reason: label }).parse(raw);
    if (v.period.endsWith('-12') && user.role !== 'super_admin')
      financeError('年度反结账只允许管理员。', 403);
    return financeWrite(this.store, user, { action: 'closing.reopen', input: v, result: rows.fin_periods }, () => {
      const before = one(
        this.db,
        rows.fin_periods,
        "SELECT * FROM fin_periods WHERE status='closed' ORDER BY period DESC LIMIT 1",
      );
      if (!before || before.period !== v.period) financeError('只能反结最近一个已结期间。', 409);
      checkVersion(before, v.version);
      this.db
        .prepare("UPDATE fin_periods SET status='open',version=version+1 WHERE period=?")
        .run(v.period);
      const after = readPeriod(this.db, v.period);
      financeAudit(this.store, user, { action: 'reopen', entity: 'fin_periods', id: null, before, after: {
        ...after,
        reason: v.reason,
      } });
      return { ...after };
    });
  }
}
