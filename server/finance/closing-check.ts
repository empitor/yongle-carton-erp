/**
 * 结账向导的检查：每一步过没过、哪些卡结账（单据都处理了、凭证都记账了、月末几步跑了且没过时、试算和资产负债平衡、
 * 损益结转了），哪些只提醒（银行流水没对完、启用前单据有变化）。FinanceClosing.check 查完权限调这里。
 */
import { z } from 'zod';
import type { Actor, Store } from '../core/index.js';
import { count, isConstraintError, many, one, rows } from '../core/index.js';
import { errorMessage } from '../../shared/core/index.js';
import type { FinanceReports } from './reports.js';
import { entryNet, jobVoucherNet, sameNet } from './jobs.js';
import { FinanceAssets } from './assets.js';
import { FinancePayroll } from './payroll.js';
import { FinanceCosting } from './costing.js';
import { activeCashAllocation } from './obligation-sql.js';
import { deliveryReversed, sourceDocumentNumber } from './business-source.js';
import { readFinanceSettings } from './settings.js';
import { nextOpenPeriod } from './periods.js';
import { taxPlan } from './closing-tax.js';

/** 结账前月末要跑完的几步 */
const requiredJobs = ['depreciation', 'payroll', 'costing', 'tax'] as const;
type RequiredJob = (typeof requiredJobs)[number];
/** 这个月各步的执行记录，和它生成的凭证的状态（没有凭证是 null） */
const jobRun = rows.fin_period_jobs
  .pick({ kind: true, voucher_id: true })
  .extend({ status: rows.fin_vouchers.shape.status.nullable() });
type JobRun = z.output<typeof jobRun>;
const event = rows.fin_events.shape;
/** 启用前的单据启用后被冲销或改价：只提醒核对期初往来 */
const openingProblem = z.object({
  id: event.id,
  version: event.version,
  source_kind: event.source_kind,
  source_id: event.source_id,
  number: z.string().nullable(),
  date: event.date,
  problem: z.string(),
});

/** 月末某一步跑过以后数据又变了：哪一步、为什么要重做、当时生成的凭证 */
type StaleJob = { kind: RequiredJob; reason: string; voucherId: number | null };
/**
 * 结账检查的一步，按 key 区分各带什么：数一数的几步带 count；月末各步（jobs）带没跑的 missing 和要重做的 stale；
 * 期初往来（opening）另列要核对的单据；试算、资产负债平衡只有过没过；损益结转（profit）带要不要补结转
 */
type ClosingStep = { ok: boolean; blocking: boolean } & (
  | { key: 'events' | 'vouchers' | 'bank'; count: number }
  | { key: 'jobs'; missing: RequiredJob[]; stale: StaleJob[] }
  | { key: 'opening'; count: number; items: z.output<typeof openingProblem>[] }
  | { key: 'trial' | 'balance' }
  | { key: 'profit'; stale: boolean; annualStale: boolean; annualNext: boolean }
);

/** 截至这个月还没处理完的财务事件 */
const outstandingEvents = (db: Store['db'], period: string) =>
  count(
    db,
    `SELECT count(*) FROM fin_events e
      WHERE substr(date,1,7)<=? AND status IN ('info_pending','ready','difference','source_deleted','cost_pending','waiting_invoice','awaiting_allocation_reversal')
      -- 那个月成本已经算完以后才出来的“待算成本”（比如算完又冲销了完工单）：冲销流水按跨期补登计入
      -- 下一次成本计算，那次会把它标成已处理，这里不拦结账
      AND NOT (status='cost_pending' AND EXISTS(SELECT 1 FROM fin_period_jobs j
        WHERE j.kind='costing' AND j.period=substr(e.date,1,7)))
      AND NOT (status='info_pending' AND source_kind='delivery' AND ${deliveryReversed('e')}
        AND NOT EXISTS(SELECT 1 FROM fin_obligations o JOIN fin_allocations a ON a.obligation_id=o.id
          JOIN fin_vouchers original ON original.id=a.voucher_id WHERE o.event_id=e.id AND ${activeCashAllocation}))`,
    period,
  );

/** 某一步跑过以后，按现在的数重算是不是不一样了；不一样返回原因。重算本身报错也算要重做。 */
function staleReason(store: Store, user: Actor, period: string, kind: RequiredJob): string | null {
  try {
    if (kind === 'depreciation') return new FinanceAssets(store).depreciationStale(period);
    if (kind === 'payroll') return new FinancePayroll(store).accrualStale(period);
    if (kind === 'costing') {
      const result = new FinanceCosting(store).stale(user, period);
      return result?.stale ? (result.reason ?? '成本算完以后数据变了。') : null;
    }
    const job = one(store.db, rows.fin_period_jobs, "SELECT * FROM fin_period_jobs WHERE period=? AND kind='tax'", period);
    if (!job) return null;
    const plan = taxPlan(store, user, period);
    return sameNet(entryNet(plan.entries), jobVoucherNet(store, job.voucher_id))
      ? null
      : '税费计提以后，收入、费用、进销项或税率变了。';
  } catch (error) {
    // 数据库约束挡下的写入是程序问题，原样抛出，不当成“要重做”的原因
    if (isConstraintError(error)) throw error;
    return errorMessage(error);
  }
}

/** 跑过以后数据又变了（多见于反结账后改账）：按现在的数重算和当时不一样的，要重做才能结账 */
function staleJobs(store: Store, user: Actor, period: string, runs: JobRun[]): StaleJob[] {
  return requiredJobs.flatMap((kind) => {
    const run = runs.find((r) => r.kind === kind);
    if (!run) return [];
    const reason = staleReason(store, user, period, kind);
    return reason ? [{ kind, reason, voucherId: run.voucher_id }] : [];
  });
}

/**
 * 检查页上算“结转以后要不要补”：算的时候出错（如损益科目开了辅助核算）不在检查页报，
 * 留给结转操作本身把原因报给人，这里当作不用补。
 */
function unlessFailing(compute: () => boolean) {
  try {
    return compute();
  } catch {
    return false;
  }
}

/** 损益结转这一步：结转后又补录了损益要补结转；12 月年度利润结转后又补了损益，年度也要补 */
function profitStep(reports: FinanceReports, user: Actor, period: string, has: (kind: string) => boolean): ClosingStep {
  const profitStale = has('profit_close') && unlessFailing(() => reports.profitClosingEntries(user, period).length > 0);
  const december = period.endsWith('-12');
  const annualStale =
    december &&
    has('annual_close') &&
    !profitStale &&
    unlessFailing(
      () =>
        reports
          .balances(user, period)
          .filter((r) => r.account_code.startsWith('3103'))
          .reduce((n, r) => n + r.ending, 0) !== 0,
    );
  return {
    key: 'profit',
    ok: has('profit_close') && !profitStale && (!december || (has('annual_close') && !annualStale)),
    stale: profitStale,
    annualStale,
    // 12 月分两步：先月末损益，记账后再年度利润；年度结转后又补了损益，年度也要补。
    annualNext: december && has('profit_close') && !profitStale && (!has('annual_close') || annualStale),
    blocking: true,
  };
}

/** 结账检查：period 是哪个月，light 为 true 时只看各步跑没跑（工资、资产页面用），不重算看要不要重做 */
export function closingCheck(store: Store, reports: FinanceReports, user: Actor, q: { period: string; light: boolean }) {
  const { db } = store,
    { period } = q;
  const start = readFinanceSettings(db).start_period;
  const next = nextOpenPeriod(db) ?? start ?? null;
  const record = one(db, rows.fin_periods, 'SELECT * FROM fin_periods WHERE period=?', period);
  const readiness = reports.readiness(user, { period });
  const outstanding = readiness.unsynced + outstandingEvents(db, period);
  const unposted = count(db, "SELECT count(*) FROM fin_vouchers WHERE period<=? AND status NOT IN ('posted','void')", period);
  const runs = many(
    db,
    jobRun,
    'SELECT j.kind,j.voucher_id,v.status FROM fin_period_jobs j LEFT JOIN fin_vouchers v ON v.id=j.voucher_id WHERE j.period=?',
    period,
  );
  const has = (kind: string) => runs.some((r) => r.kind === kind && (r.voucher_id === null || r.status === 'posted'));
  const stale = record?.status === 'closed' || q.light ? [] : staleJobs(store, user, period, runs);
  const trial = start && period >= start ? reports.get(user, 'trial', { period }) : null;
  const balance = trial && readiness.ready ? reports.get(user, 'balance', { period }, false) : null;
  const bank = count(db, 'SELECT count(*) FROM fin_bank_rows WHERE substr(date,1,7)<=? AND voucher_id IS NULL', period);
  // 启用前的单据启用后被冲销或改价：不进账，只提醒核对期初往来，不卡结账（见 flagBeforeOpeningChange）
  const opening = many(
    db,
    openingProblem,
    `SELECT e.id,e.version,e.source_kind,e.source_id,${sourceDocumentNumber('e')} AS number,e.date,e.problem FROM fin_events e
        WHERE status='before_opening' AND problem IS NOT NULL ORDER BY date,id`,
  );
  const steps: ClosingStep[] = [
    { key: 'events', ok: !outstanding, count: outstanding, blocking: true },
    { key: 'vouchers', ok: !unposted, count: unposted, blocking: true },
    {
      key: 'jobs',
      ok: requiredJobs.every(has) && !stale.length,
      missing: requiredJobs.filter((key) => !has(key)),
      stale,
      blocking: true,
    },
    { key: 'bank', ok: !bank, count: bank, blocking: false },
    { key: 'opening', ok: !opening.length, count: opening.length, items: opening, blocking: false },
    { key: 'trial', ok: trial?.balanced === true, blocking: true },
    { key: 'balance', ok: balance?.balanced === true, blocking: true },
    profitStep(reports, user, period, has),
  ];
  return {
    period,
    next,
    record: record ?? null,
    readiness,
    steps,
    canClose: period === next && steps.every((s) => !s.blocking || s.ok),
  };
}
