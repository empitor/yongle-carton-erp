import { z } from 'zod';
import { periodSchema } from '../../../shared/finance/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { many, rows } from '../../core/index.js';
import { financeFacts } from '../../flow/index.js';
import { financeActor } from '../base/core.js';
import { pageSql } from '../base/query.js';
import { snapshotLines } from '../events/source-snapshot.js';
import { proportion } from '../base/amounts.js';
import { sourceBooked } from '../events/event-source-obligations.js';

/** 毛利：按订单、客户、产品或月份看送货收入减销售成本；这个月还没算成本时按上个有成本的月份估算。 */
/**
 * 毛利的收入按记账月份归月：送货收入凭证的日期（补录到已结账月份的单据记在最早没结账的月份），还没生成凭证的用单据日期。
 * 成本（fin_cost_sales）按成本计算的月份，补录单据的出库流水按跨期补登计入那个月，两边落在同一个月、和总账逐月对得上。
 */
const bookedMonth = "substr(coalesce((SELECT bv.date FROM fin_vouchers bv WHERE bv.id=e.voucher_id AND bv.status<>'void'),e.date),1,7)";

/** 分组的值：订单、客户、产品编号，或月份（YYYY-MM）；流水没挂订单、产品的是空 */
const marginGroup = z.union([z.number(), z.string()]).nullable();
type MarginGroup = z.output<typeof marginGroup>;
/** 毛利按什么分组：订单、客户、产品、月份 */
const groupBys = ['order', 'customer', 'product', 'month'] as const;
type GroupBy = (typeof groupBys)[number];

/** 上个有成本的月份的期初加入库数量和金额（库存品、单位） */
const priorCost = z.object({
  stock_id: rows.fin_inventory_costs.shape.stock_id,
  unit: rows.fin_inventory_costs.shape.unit,
  cost_quantity: z.number(),
  cost_amount: z.number(),
});
/**
 * 毛利还没算成本时的估算口径：这个月成品送货出库的数量（窗口给）按分组和库存品合计，只要 selected 里的分组，
 * 各库存品按 period 以前最后一个有成本的月份的期初加入库数量、金额（没有的是空）。
 */
function marginFacts(db: Store['db'], group: GroupBy, period: string, selected: MarginGroup[]) {
  const wanted = new Set(selected);
  const keyOf = {
    order: (r: Outflow) => r.orderId,
    customer: (r: Outflow) => r.customerId,
    product: (r: Outflow) => r.productId,
    month: () => period,
  }[group];
  const facts = new Map<string, { group_id: MarginGroup; item_id: number; unit: string; quantity: number }>();
  for (const r of financeFacts.stock.deliveryOutflows(db, period)) {
    const group_id = keyOf(r);
    if (!wanted.has(group_id)) continue;
    const key = JSON.stringify([group_id, r.itemId]);
    const fact = facts.get(key) ?? { group_id, item_id: r.itemId, unit: r.unit, quantity: 0 };
    fact.quantity += r.quantity;
    facts.set(key, fact);
  }
  const pairs = new Map([...facts.values()].map((f) => [JSON.stringify([f.item_id, f.unit]), [f.item_id, f.unit]]));
  const costs = new Map(
    many(
      db,
      priorCost,
      `SELECT c.stock_id,c.unit,c.opening_qty+c.in_qty AS cost_quantity,c.opening_cents+c.in_cents AS cost_amount
        FROM json_each(?) j JOIN fin_inventory_costs c ON c.stock_id=json_extract(j.value,'$[0]') AND c.unit=json_extract(j.value,'$[1]')
        AND c.period=(SELECT max(prior.period) FROM fin_inventory_costs prior WHERE prior.stock_id=c.stock_id AND prior.unit=c.unit AND prior.period<?)`,
      JSON.stringify([...pairs.values()]),
      period,
    ).map((c) => [JSON.stringify([c.stock_id, c.unit]), c]),
  );
  return [...facts.values()].map((f) => ({ ...f, cost: costs.get(JSON.stringify([f.item_id, f.unit])) }));
}
type Outflow = ReturnType<typeof financeFacts.stock.deliveryOutflows>[number];

/** 毛利一行：分组（订单、客户、产品编号或月份）、收入、成本（还没算的是空）、毛利，和是不是按估算 */
const marginRow = z.object({
  group_id: marginGroup,
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
        group: z.enum(groupBys).default('order'),
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
      if (!f.cost?.cost_quantity) value.missing++;
      else value.cost += proportion(f.cost.cost_amount, f.quantity, f.cost.cost_quantity);
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
