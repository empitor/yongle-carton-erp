import { z } from 'zod';
import { periodSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { financeActor } from './core.js';
import { marginFacts } from './costing-source.js';
import { pageSql } from './query.js';
import { snapshotLines } from './source-snapshot.js';
import { proportion } from './amounts.js';
import { sourceBooked } from './event-source-obligations.js';

/** 毛利：按订单、客户、产品或月份看送货收入减销售成本；这个月还没算成本时按上个有成本的月份估算。 */
/**
 * 毛利的收入按记账月份归月：送货收入凭证的日期（补录到已结账月份的单据记在最早没结账的月份），还没生成凭证的用单据日期。
 * 成本（fin_cost_sales）按成本计算的月份，补录单据的出库流水按跨期补登计入那个月，两边落在同一个月、和总账逐月对得上。
 */
const bookedMonth = "substr(coalesce((SELECT bv.date FROM fin_vouchers bv WHERE bv.id=e.voucher_id AND bv.status<>'void'),e.date),1,7)";

/** 毛利一行：分组（订单、客户、产品编号或月份）、收入、成本（还没算的是空）、毛利，和是不是按估算 */
const marginRow = z.object({
  group_id: z.union([z.number(), z.string()]).nullable(),
  revenue: z.number(),
  cost: z.number().nullable(),
  margin: z.number().nullable(),
  estimated: z.number(),
});

export class FinanceMargin {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  get(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        period: periodSchema,
        group: z.enum(['order', 'customer', 'product', 'month']).default('order'),
      })
      .parse(raw);
    const group = {
      order: 'order_id',
      customer: 'customer_id',
      product: 'product_id',
      month: 'period',
    }[q.group];
    const data = pageSql(
      this.db,
      {
        schema: marginRow,
        sql: `WITH revenue AS (
      SELECT json_extract(line.value,'$.orderId') AS order_id,
        CASE WHEN e.party_kind='customer' THEN cast(e.party_id AS INTEGER) END AS customer_id,
        json_extract(line.value,'$.productId') AS product_id,${bookedMonth} AS period,
        coalesce(json_extract(e.snapshot,'$.money.lines['||line.key||'].net'),0) AS amount
      FROM fin_source_observations x JOIN fin_events e ON e.id=x.event_id,${snapshotLines('e.snapshot')} line
      -- 单据有效的按单据算；单据删了、原凭证还留着的（核对后保留凭证）按入账算，和总账收入对得上
      WHERE e.source_kind='delivery' AND e.status<>'before_opening'
      AND (x.status='confirmed' OR (x.status='deleted' AND ${sourceBooked('e')}))
      AND ${bookedMonth}=?
    ), facts AS (SELECT ${group} AS group_id,amount AS revenue,NULL AS cost FROM revenue
      UNION ALL SELECT ${group},0,cost_cents FROM fin_cost_sales WHERE period=?)
    SELECT group_id,sum(revenue) AS revenue,sum(cost) AS cost,sum(revenue)-sum(cost) AS margin,
      (sum(cost) IS NULL OR NOT EXISTS(SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='costing')) AS estimated
      FROM facts GROUP BY group_id`,
        values: [q.period, q.period, q.period],
        order: 'group_id',
      },
      raw,
    );
    const selected = data.rows.filter((r) => r.estimated && r.cost == null).map((r) => r.group_id);
    if (!selected.length) return data;
    const facts = marginFacts(this.db, q.group, q.period, selected);
    const estimates = new Map<unknown, { cost: number; missing: number }>();
    for (const f of facts) {
      const value = estimates.get(f.group_id) ?? { cost: 0, missing: 0 };
      if (!Number(f.cost_quantity)) value.missing++;
      else
        value.cost += proportion(
          Number(f.cost_amount),
          Number(f.quantity),
          Number(f.cost_quantity),
        );
      estimates.set(f.group_id, value);
    }
    return {
      ...data,
      rows: data.rows.map((row) => {
        const value = estimates.get(row.group_id);
        if (!row.estimated || row.cost != null || !value) return row;
        return {
          ...row,
          cost: value.missing ? null : value.cost,
          margin: value.missing ? null : Number(row.revenue) - value.cost,
          missingCostStocks: value.missing,
        };
      }),
    };
  }
}
