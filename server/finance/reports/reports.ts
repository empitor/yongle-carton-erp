import { z } from 'zod';
import { periodSchema, accountCodeSchema, centsSchema, reportKinds, versionSchema } from '../../../shared/finance/index.js';
import { AppError, exists, many, one, rows } from '../../core/index.js';
import { expectRow } from '../base/finance-rows.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { FinanceMonthly } from './monthly.js';
import { FinanceEventViews } from '../events/event-views.js';
import { FinanceOverview } from './overview.js';
import { FinanceParties } from '../parties/parties.js';
import { entry, pageSql, request } from '../base/query.js';
import { activeCashAllocation, allocationReversalMessage } from '../parties/obligation-sql.js';
import { readSnapshot } from '../events/source-snapshot.js';
import { endOfMonth } from '../base/periods.js';
import { unseenSourceList } from '../events/catch-up.js';
import { catchUpFailed } from '../base/sync-health.js';
import { lapsedStatuses, scanSources, sourceIs, unseenCount } from '../events/source-scan.js';
import { readReportSnapshot, type BalanceReport, type CashflowReport, type ProfitReport } from './report-shapes.js';
import {
  balanceSheet,
  cashflowStatement,
  categoryByCode,
  ledgerBalances,
  profitStatement,
  savedReport,
  trialBalance,
  type Report,
  type TrialReport,
} from './report-sheets.js';

/** 预算一行：预算加科目名称、实际发生、差额 */
const budgetRow = rows.fin_budgets.extend({ name: z.string(), actual: z.number(), difference: z.number() });

const type = z.enum(reportKinds);
const filter = z.object({ period: periodSchema });
/** 资料待补的单据最多列几条 */
const READINESS_ROWS = 30;
const event = rows.fin_events.shape;
/** 还卡着正式报表的一条财务事件：待补资料，或送货单已冲销、核销还没撤销 */
const readinessRow = z.object({
  id: event.id,
  source_kind: event.source_kind,
  source_id: event.source_id,
  number: z.string().nullable(),
  date: event.date,
  amount_cents: event.amount_cents,
  problem: event.problem,
  reverse_pending: z.number(),
  snapshot: event.snapshot,
});
const readinessTotals = z.object({ count: z.number(), reversal_count: z.number(), amount: z.number(), delivery: z.number() });
/** 看板上本月按科目的经营数 */
const accountingTotals = z.object({ revenue: z.number(), salesCost: z.number(), expense: z.number(), profit: z.number() });

const closedPeriod = (db: Store['db'], period: string) =>
  exists(db, "SELECT 1 FROM fin_periods WHERE period=? AND status='closed'", period);

/**
 * 还有单据没同步进财务时的说法。读之前已经补扫到完（catch-up.ts），剩下的是内容读不出来、补扫跳过的，写明是哪几张；
 * 列不出单号的（只有已被删的来源）只说有单据没同步。
 */
const unsyncedMessage = (numbers: string[]) =>
  numbers.length
    ? '有业务单据还没同步进财务：' + numbers.join('、') + '。多半是单据内容读不出来，请联系维护人员查看出错记录，在库里改好后会自动补上，再输出正式报表。'
    : '有业务单据还没同步进财务，请稍后重试，再输出正式报表。';
/** 补扫没成功（sync-health.ts 的 catchUpFailed）时的说法 */
const SYNC_FAILED = '业务单据没能同步进财务（原因已记进出错记录），请联系维护人员，修好后再输出正式报表。';

export class FinanceInfoPending extends AppError {
  constructor(readonly details: ReturnType<FinanceReports['readiness']>) {
    super(
      details.syncFailed
        ? SYNC_FAILED
        : details.reversalCount
        ? '本期有冲销送货单待处理，请先撤销核销并记账相关红冲。'
        : details.count
          ? '本期有待补财务资料，请补完后再输出正式报表。'
          : unsyncedMessage(details.unsyncedSources.map((s) => s.number ?? s.source_id)),
      409,
      'FINANCE_INFO_PENDING',
    );
  }
}
export class FinanceReports {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  /** 正式报表前资料补没补完：本月卡着的事件、缺资料的单据，加上截至月底还没同步进财务的单据（和结账检查同一个 unseenSources） */
  readiness(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = filter.parse(raw);
    const unseen = unseenCount(scanSources(this.db), endOfMonth(period));
    // 读之前的补扫没成功（catch-up.ts）：财务的数可能不是最新的，照样拦
    const syncFailed = catchUpFailed(this.db);
    const unsynced = new FinanceEventViews(this.store).unsynced(actor, period);
    const pending = unsynced.filter((r) => r.status === 'info_pending');
    // 送货单已冲销：还没补扫进来的冲销也算（source-scan.ts 的 sourceIs）
    const query = `FROM (
      SELECT e.*, (e.source_kind='delivery' AND ${sourceIs('e', 'reversed')}) AS reversed,
        EXISTS(SELECT 1 FROM fin_obligations o JOIN fin_allocations a ON a.obligation_id=o.id
          JOIN fin_vouchers original ON original.id=a.voucher_id WHERE o.event_id=e.id AND ${activeCashAllocation}) AS allocated
      FROM fin_events e WHERE e.status IN ('info_pending','awaiting_allocation_reversal') AND e.date BETWEEN ? AND ?
      AND e.id NOT IN (SELECT value FROM json_each(?))
    ) WHERE status='awaiting_allocation_reversal' OR NOT reversed OR allocated`;
    const bounds = [
      lapsedStatuses(this.db),
      period + '-01',
      endOfMonth(period),
      JSON.stringify(unsynced.flatMap((r) => (r.id == null ? [] : [r.id]))),
    ];
    const totals = expectRow(
      one(
        this.db,
        readinessTotals,
        `SELECT count(*) AS count,coalesce(sum(reversed OR status='awaiting_allocation_reversal'),0) AS reversal_count,
        coalesce(sum(CASE WHEN NOT reversed THEN amount_cents END),0) AS amount,
        coalesce(sum(CASE WHEN source_kind='delivery' AND NOT reversed THEN amount_cents END),0) AS delivery ${query}`,
        ...bounds,
      ),
      '待补资料合计',
    );
    const blocked = many(
      this.db,
      readinessRow,
      `SELECT id,source_kind,source_id,source_number AS number,date,amount_cents,problem,
      reversed OR status='awaiting_allocation_reversal' AS reverse_pending,snapshot
      ${query} ORDER BY date,id LIMIT ${READINESS_ROWS}`,
      ...bounds,
    );
    return {
      period,
      ready: !totals.count && pending.length === 0 && !unseen && !syncFailed,
      count: totals.count + pending.length,
      reversalCount: totals.reversal_count,
      amount: totals.amount + pending.reduce((n, r) => n + Number(r.amount_cents), 0),
      deliveryAmount:
        totals.delivery +
        pending
          .filter((r) => r.source_kind === 'delivery')
          .reduce((n, r) => n + Number(r.amount_cents), 0),
      unsynced: unseen,
      syncFailed,
      // 还没同步的是哪几张（结账、正式报表拦下时的说法写明单号）
      unsyncedSources: unseen
        ? unseenSourceList(this.db, endOfMonth(period), READINESS_ROWS).map((s) => ({
            source_kind: s.kind,
            source_id: s.id,
            number: s.number,
          }))
        : [],
      rows: [
        ...blocked.map(({ reverse_pending, snapshot, ...r }) => ({
          ...r,
          problem: reverse_pending ? allocationReversalMessage : r.problem,
          missing: reverse_pending ? ['allocation_reversal'] : (readSnapshot({ id: r.id, snapshot }).missing ?? []),
        })),
        // 单号已由 unsynced 按 eventColumns 算好；快照、理论金额、往来单位是月度台账用的，这里不回
        ...pending
          .slice(0, READINESS_ROWS)
          .map(({ snapshot: _snapshot, theoretical: _theoretical, party: _party, ...r }) => r),
      ].slice(0, READINESS_ROWS),
    };
  }
  assertReady(user: Actor, period: string) {
    const readiness = this.readiness(user, { period });
    if (!readiness.ready) throw new FinanceInfoPending(readiness);
  }
  balances(actor: Actor | null, period: string) {
    return ledgerBalances(this.store, actor, period);
  }
  /** 按现在的账算资产负债表，不查资料齐没齐（结账检查用，那边各步自己拦） */
  currentBalance(actor: Actor | null, period: string) {
    return balanceSheet(period, this.balances(actor, period), categoryByCode(this.db));
  }
  /** 一张正式报表：试算平衡表随时算；别的要资料补齐，已结账的月份读结账时存的快照（snapshot 为 false 时按现在的账重算） */
  report(actor: Actor | null, rawType: unknown, raw: unknown, snapshot = true): Report {
    const user = financeActor(actor),
      kind = type.parse(rawType),
      { period } = filter.parse(raw);
    if (kind !== 'trial') {
      this.assertReady(user, period);
      const saved = snapshot ? this.closedSnapshot(period) : undefined;
      if (saved) return savedReport(saved, kind);
    }
    switch (kind) {
      case 'trial':
        return { kind, data: trialBalance(period, this.balances(user, period)) };
      case 'balance':
        return { kind, data: this.currentBalance(user, period) };
      case 'profit':
        return { kind, data: profitStatement(this.db, period, categoryByCode(this.db)) };
      case 'cashflow':
        return { kind, data: cashflowStatement(this.db, period, this.balances(user, period)) };
    }
  }
  get(actor: Actor | null, rawType: 'trial', raw: unknown, snapshot?: boolean): TrialReport;
  get(actor: Actor | null, rawType: 'balance', raw: unknown, snapshot?: boolean): BalanceReport;
  get(actor: Actor | null, rawType: 'profit', raw: unknown, snapshot?: boolean): ProfitReport;
  get(actor: Actor | null, rawType: 'cashflow', raw: unknown, snapshot?: boolean): CashflowReport;
  get(actor: Actor | null, rawType: unknown, raw: unknown, snapshot?: boolean): Report['data'];
  get(actor: Actor | null, rawType: unknown, raw: unknown, snapshot = true) {
    return this.report(actor, rawType, raw, snapshot).data;
  }
  /** 已结账月份最新的报表快照；没结账或没有快照是 undefined */
  private closedSnapshot(period: string) {
    if (!closedPeriod(this.db, period)) return undefined;
    const saved = one(
      this.db,
      rows.fin_report_snapshots,
      'SELECT * FROM fin_report_snapshots WHERE period=? ORDER BY version DESC LIMIT 1',
      period,
    );
    return saved && readReportSnapshot(saved);
  }
  budgets(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = filter.parse(raw);
    return pageSql(
      this.db,
      {
        schema: budgetRow,
        sql: `SELECT *,actual-amount_cents AS difference FROM (
      SELECT b.*,a.name,(CASE WHEN a.direction='credit' THEN -1 ELSE 1 END)*coalesce((SELECT sum((e.debit-e.credit)*CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.period=b.period AND v.status='posted'
      AND coalesce(v.module_source,'') NOT IN ('profit_close','annual_close') AND e.account_code LIKE b.account_code||'%'),0) AS actual
      FROM fin_budgets b JOIN fin_accounts a ON a.code=b.account_code WHERE b.period=?)`,
        values: [period],
        order: 'account_code',
      },
      raw,
    );
  }
  budget(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({
        period: periodSchema,
        accountCode: accountCodeSchema,
        amount: centsSchema,
        version: versionSchema.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'budget.save', input: v, result: rows.fin_budgets }, () => {
      if (closedPeriod(this.db, v.period)) financeError('该期间已结账，不能修改预算。', 409);
      const get = () =>
        one(this.db, rows.fin_budgets, 'SELECT * FROM fin_budgets WHERE period=? AND account_code=?', v.period, v.accountCode);
      const before = get();
      if (before) checkVersion(before, v.version ?? 0);
      else if (v.version) financeError('预算记录不存在。', 404);
      if (!exists(this.db, 'SELECT 1 FROM fin_accounts WHERE code=?', v.accountCode)) financeError('预算科目不存在。');
      this.db
        .prepare(
          `INSERT INTO fin_budgets(period,account_code,amount_cents) VALUES(?,?,?)
        ON CONFLICT(period,account_code) DO UPDATE SET amount_cents=excluded.amount_cents,version=version+1`,
        )
        .run(v.period, v.accountCode, v.amount);
      const after = expectRow(get(), '预算');
      financeAudit(this.store, user, { action: 'save', entity: 'fin_budgets', id: null, before: before ?? null, after });
      return { ...after };
    });
  }
  dashboard(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor),
      { period } = filter.parse(raw);
    const monthly = new FinanceMonthly(this.store);
    const trend = monthly.trend(user, { period });
    // 趋势按月份从早到晚、到这个月为止（默认 12 个月，至少 1 个），最后一个就是这个月
    const current = trend[trend.length - 1];
    const accounting = expectRow(
      one(
        this.db,
        accountingTotals,
        `SELECT
      coalesce(sum(CASE WHEN e.account_code LIKE '5001%' OR e.account_code LIKE '5051%' THEN -amount ELSE 0 END),0) AS revenue,
      coalesce(sum(CASE WHEN e.account_code LIKE '5401%' OR e.account_code LIKE '5402%' THEN amount ELSE 0 END),0) AS salesCost,
      coalesce(sum(CASE WHEN e.account_code LIKE '56%' THEN amount ELSE 0 END),0) AS expense,
      coalesce(sum(-amount),0) AS profit
      FROM (SELECT e.account_code,(e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id JOIN fin_accounts a ON a.code=e.account_code
        WHERE v.status='posted' AND v.period=? AND a.category='profit' AND coalesce(v.module_source,'')<>'profit_close') e`,
        period,
      ),
      '本月经营数',
    );
    const date = endOfMonth(period),
      parties = new FinanceParties(this.store);
    const receivable = parties.aging(user, { kind: 'receivable', date, pageSize: 1 });
    const payable = parties.aging(user, { kind: 'payable', date, pageSize: 1 });
    const pending = this.readiness(user, { period });
    const funds = new FinanceOverview(this.store).summary(user, { date });
    return {
      period,
      current,
      trend,
      estimated: current.missingTax > 0 || current.missingPrice > 0,
      missingTax: current.missingTax,
      accounting: {
        ...accounting,
        grossProfit: accounting.revenue - accounting.salesCost,
        pendingAmount: pending.amount,
        estimatedRevenue: accounting.revenue + pending.deliveryAmount,
        cash: funds.accounts.reduce((n, r) => n + r.balance, 0),
        receivable: receivable.totals,
        payable: payable.totals,
      },
    };
  }
  profitClosingEntries(user: Actor, period: string) {
    const b = this.balances(user, period);
    const lines = b.flatMap((r) => {
      const a = one(
        this.db,
        rows.fin_accounts.pick({ category: true, auxiliary: true }),
        'SELECT category,auxiliary FROM fin_accounts WHERE code=?',
        r.account_code,
      );
      if (a?.category !== 'profit' || !r.ending) return [];
      if (a.auxiliary) financeError('损益科目启用了辅助核算，需逐辅助项结转。');
      return [entry(r.account_code, Math.max(0, -r.ending), Math.max(0, r.ending))];
    });
    const balance = lines.reduce((n, r) => n + r.debit - r.credit, 0);
    if (balance) lines.push(entry('3103', Math.max(0, -balance), Math.max(0, balance)));
    return lines;
  }
}
