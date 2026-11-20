import { z } from 'zod';
import { periodSchema } from '../../shared/finance/index.js';
import { today } from '../../shared/core/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { many, parseStoredJson, rows } from '../core/index.js';
import { financeActor } from './core.js';
import { MONTHS_PER_YEAR, periodOf } from './days.js';
import { FinanceEventViews } from './event-views.js';
import { pageSql } from './query.js';
import { reversedCents } from './reversal-pairs.js';
import { allocationSum } from './obligation-sql.js';
import { adjacentPeriod, endOfMonth } from './periods.js';
import { detailRow, monthlyAll, monthlyAllParams, monthlyObserved, monthlyObservedParams } from './monthly-sql.js';

const metrics = [
  'theoreticalIncome',
  'theoreticalExpense',
  'actualIncome',
  'actualExpense',
  'discountIncome',
  'discountExpense',
  'interestIncome',
  'interestExpense',
  'depositIncome',
  'depositExpense',
  'ordered',
] as const;
type Metric = (typeof metrics)[number];
/** 单据月份筛选（YYYY-MM、预收预付、没核销到单据）的长度上限 */
const SOURCE_MONTH_MAX = 20;
/** 经营趋势最多看几个月 */
const TREND_MAX_MONTHS = 24;
const filters = z.object({
  period: periodSchema,
  metric: z.enum(metrics).optional(),
  sourceMonth: z.string().max(SOURCE_MONTH_MAX).optional(),
  missingTax: z.enum(['0', '1']).optional(),
});
/** 一个月里按金额类型、单据月份的合计：金额（都没价格是 null）、缺价格几条、共几条、缺税率几条 */
const aggregateRow = z.object({
  period: z.string(),
  metric: z.string(),
  source_month: z.string(),
  amount: z.number().nullable(),
  missing: z.number(),
  count: z.number(),
  missing_tax: z.number(),
});
type Aggregate = Omit<z.output<typeof aggregateRow>, 'period'>;
const obligation = rows.fin_obligations.shape;
/** 一个月里按单位到期的往来：到期额（扣掉月底前的红字冲销）、月底前已核销、还没结的 */
const dueRow = z.object({
  period: z.string(),
  kind: obligation.kind,
  party_id: obligation.party_id,
  party_name: obligation.party_name,
  due: z.number(),
  settled: z.number(),
  outstanding: z.number(),
});
type Due = Omit<z.output<typeof dueRow>, 'period'>;

export class FinanceMonthly {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }
  detail(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = filters.parse(raw);
    const pending = new FinanceEventViews(this.store).unsynced(actor, q.period);
    const sql = `SELECT * FROM (${monthlyAll}) WHERE date BETWEEN ? AND ?
      AND (? IS NULL OR metric=?) AND (? IS NULL OR source_month=?)
      AND (? IS NULL OR missing_tax=?) AND (amount IS NULL OR amount<>0)`;
    const data = pageSql(
      this.db,
      {
        schema: detailRow,
        sql,
        values: [
        ...monthlyAllParams(pending),
        q.period + '-01',
        endOfMonth(q.period),
        q.metric ?? null,
        q.metric ?? null,
        q.sourceMonth ?? null,
        q.sourceMonth ?? null,
        q.missingTax ?? null,
        Number(q.missingTax ?? 0),
        ],
        order: 'date',
      },
      raw,
    );
    return {
      ...data,
      rows: data.rows.map((row) => ({
        ...row,
        // 各来源拼的明细（事件快照，或收付款、利息、保证金、凭证分录、订单几项），形状各不相同，原样给页面
        detail: parseStoredJson(z.json(), row.detail, `月度台账明细（${row.metric} ${row.id ?? ''}）`),
      })),
    };
  }
  get(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = filters.parse(raw);
    return this.range(actor, period, period, 1)[0];
  }
  private range(actor: Actor | null, first: string, last: string, months: number) {
    const pending = new FinanceEventViews(this.store).unsynced(actor, first, last);
    const from = first + '-01', to = endOfMonth(last);
    const aggregates = many(
      this.db,
      aggregateRow,
      `SELECT substr(date,1,7) AS period,metric,source_month,sum(amount) AS amount,
      sum(amount IS NULL) AS missing,count(*) AS count,sum(missing_tax) AS missing_tax
      FROM (${monthlyObserved}) WHERE date BETWEEN ? AND ? GROUP BY period,metric,source_month`,
      ...monthlyObservedParams(pending),
      from,
      to,
    );
    const byMonth = new Map<string, Map<string, Aggregate>>();
    const monthRows = (period: string) => {
      let rows = byMonth.get(period);
      if (!rows) byMonth.set(period, rows = new Map<string, Aggregate>());
      return rows;
    };
    for (const { period, ...row } of aggregates) monthRows(period).set(JSON.stringify([row.metric, row.source_month]), row);
    for (const row of pending) {
      const period = periodOf(row.date);
      const metric = row.source_kind === 'delivery' ? 'theoreticalIncome' : 'theoreticalExpense';
      const rows = monthRows(period);
      const key = JSON.stringify([metric, period]);
      const group = rows.get(key) ?? { metric, source_month: period, amount: null, count: 0, missing: 0, missing_tax: 0 };
      if (row.theoretical !== null) group.amount = (group.amount ?? 0) + row.theoretical;
      else group.missing++;
      group.count++;
      if (row.missing.includes('tax')) group.missing_tax++;
      rows.set(key, group);
    }
    const cutoff = "date(o.due_date,'start of month','+1 month','-1 day')";
    // 红字冲销成对看（见 reversal-pairs.ts）：冲销那笔不算到期（它的到期日只是冲销日），
    // 冲掉的金额从原往来的到期额里扣，和已核销一样只算到这个月底为止的冲销。
    const reversed = reversedCents('o', ' AND r.date<=' + cutoff);
    const due = many(
      this.db,
      dueRow,
      `SELECT substr(o.due_date,1,7) AS period,o.kind,o.party_id,max(o.party_name) AS party_name,sum(o.amount_cents+${reversed}) AS due,
      sum(${allocationSum('a.obligation_id=o.id AND a.date<=' + cutoff, true)}) AS settled,
      sum(o.amount_cents+${reversed}-${allocationSum('a.obligation_id=o.id AND a.date<=' + cutoff, true)}) AS outstanding
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE due_date BETWEEN ? AND ?
      AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void') AND o.reversal_of IS NULL
      GROUP BY period,o.kind,o.party_id`,
      from,
      to,
    );
    const dueByMonth = new Map<string, Due[]>();
    for (const { period, ...row } of due) {
      const rows = dueByMonth.get(period);
      if (rows) rows.push(row);
      else dueByMonth.set(period, [row]);
    }
    return Array.from({ length: months }, (_, index) => {
      const period = adjacentPeriod(first, index);
      return this.result(period, [...monthRows(period).values()], dueByMonth.get(period) ?? []);
    });
  }
  private result(period: string, rows: Aggregate[], due: Due[]) {
    const total = (metric: Metric) => rows.filter((r) => r.metric === metric).reduce((n, r) => n + (r.amount ?? 0), 0);
    const totals = {
      theoreticalIncome: total('theoreticalIncome'),
      theoreticalExpense: total('theoreticalExpense'),
      actualIncome: total('actualIncome'),
      actualExpense: total('actualExpense'),
      discountIncome: total('discountIncome'),
      discountExpense: total('discountExpense'),
      interestIncome: total('interestIncome'),
      interestExpense: total('interestExpense'),
      depositIncome: total('depositIncome'),
      depositExpense: total('depositExpense'),
      ordered: total('ordered'),
    } satisfies Record<Metric, number>;
    return {
      period,
      ...totals,
      theoreticalProfit: totals.theoreticalIncome - totals.theoreticalExpense,
      actualProfit: totals.actualIncome - totals.actualExpense,
      missingPrice: rows.reduce((n, r) => n + r.missing, 0),
      missingTax: rows.reduce((n, r) => n + r.missing_tax, 0),
      sources: rows.filter(
        (r) => ['actualIncome', 'actualExpense'].includes(r.metric) && Number(r.amount) !== 0,
      ),
      due,
    };
  }
  trend(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        period: periodSchema.default(() => periodOf(today())),
        months: z.coerce.number().int().min(1).max(TREND_MAX_MONTHS).default(MONTHS_PER_YEAR),
      })
      .parse(raw);
    return this.range(actor, adjacentPeriod(q.period, 1 - q.months), q.period, q.months);
  }
}
