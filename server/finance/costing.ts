import { z } from 'zod';
import { periodSchema, centsSchema, accountCodeSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { periodJob } from './jobs.js';
import {
  adjacentPeriod,
  endOfMonth,
  entry,
  id,
  label,
  pageSql,
  proportion,
  request,
} from './query.js';
import { quantityUnits } from '../../shared/operations.js';
import { financeTemplate } from './template.js';
import type { FinanceSourceSnapshot } from './source-snapshot.js';

type Movement = {
  id: string;
  item_id: number;
  delta_units: number;
  source_kind: string;
  source_id: string;
  date: string;
  customer_order_id: number | null;
  stock_name: string;
  kind: 'raw' | 'finished';
  unit: string;
  product_id: number | null;
  customer_id: number | null;
};
type Item = {
  stockId: number;
  name: string;
  kind: string;
  unit: string;
  openingQty: number;
  openingCents: number;
  inQty: number;
  inCents: number;
  outQty: number;
  outCents: number;
  endQty: number;
  endCents: number;
};
const opening = z.strictObject({
  stockId: id,
  unit: label,
  quantity: z.number().int().nonnegative(),
  amount: centsSchema,
});
const manual = z.strictObject({
  movementId: label,
  unit: label,
  amount: centsSchema,
  counterAccount: accountCodeSchema.optional(),
  reason: label,
});
export class FinanceCosting {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ period: periodSchema, stockId: id.optional() }).parse(raw);
    return pageSql(
      this.db,
      'SELECT * FROM fin_inventory_costs WHERE period=? AND (? IS NULL OR stock_id=?)',
      [q.period, q.stockId ?? null, q.stockId ?? null],
      raw,
      'stock_id',
    );
  }

  /** 算成本前要人填的内容：启用月已有库存的期初成本，和系统算不出来的手工出入库。 */
  requirements(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    const settings = this.db.prepare('SELECT start_period FROM fin_settings WHERE id=1').get()!;
    const previous = adjacentPeriod(period, -1);
    const done = !!this.db
      .prepare("SELECT 1 FROM fin_period_jobs WHERE kind='costing' AND period=?")
      .get(period);
    const opening = this.db
      .prepare(
        `SELECT s.id AS stockId,s.name,s.unit,coalesce(sum(m.delta_units),0) AS quantity
        FROM stock_items s JOIN stock_movements m ON m.item_id=s.id AND m.date<?
        WHERE NOT EXISTS(SELECT 1 FROM fin_inventory_costs c WHERE c.period=? AND c.stock_id=s.id)
        GROUP BY s.id HAVING quantity<>0 ORDER BY s.kind DESC,s.name`,
      )
      .all(period + '-01', previous);
    const manual = this.db
      .prepare(
        `SELECT m.id,m.date,m.delta_units AS quantity,m.source_kind,m.notes,s.name,s.unit,s.kind
        FROM stock_movements m JOIN stock_items s ON s.id=m.item_id
        WHERE m.date BETWEEN ? AND ?
        AND NOT (m.source_kind='flow_production')
        AND NOT (m.delta_units>0 AND m.source_kind IN ('flow_arrival','purchase_receipt'))
        AND NOT (m.delta_units<0 AND s.kind='finished' AND m.source_kind='flow_delivery')
        ORDER BY m.date,m.rowid`,
      )
      .all(period + '-01', endOfMonth(period));
    return {
      period,
      done,
      isStart: period === settings.start_period,
      opening: period === settings.start_period ? opening : [],
      /** 入库要填金额；非手工的出库要填对方科目，手工流水默认走待处理财产损溢。 */
      valuations: manual.map((m) => ({
        ...m,
        needsAmount: Number(m.quantity) > 0,
        needsCounter: Number(m.quantity) < 0 && m.source_kind !== 'manual',
      })),
    };
  }

  run(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({
        period: periodSchema,
        opening: z.array(opening).max(2000).default([]),
        valuations: z.array(manual).max(2000).default([]),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'costing.run', v, () => {
      const date = endOfMonth(v.period),
        previous = adjacentPeriod(v.period, -1);
      this.ledger.openPeriod(user, date);
      if (
        this.db
          .prepare("SELECT 1 FROM fin_period_jobs WHERE kind='costing' AND period>=?")
          .get(v.period)
      )
        financeError('成本须按月顺序结转且不能重复。', 409);
      const before = this.db
        .prepare('SELECT start_period,cost_allocation FROM fin_settings WHERE id=1')
        .get()!;
      if (
        v.period !== before.start_period &&
        !this.db
          .prepare("SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='costing'")
          .get(previous)
      )
        financeError('请先完成上一期成本。', 409);
      if (v.period !== before.start_period && v.opening.length)
        financeError('仅启用期间可录入库存期初成本。');
      const openingMap = new Map(v.opening.map((r) => [r.stockId, r]));
      const manualMap = new Map(v.valuations.map((r) => [r.movementId, r]));
      if (openingMap.size !== v.opening.length || manualMap.size !== v.valuations.length)
        financeError('成本输入存在重复记录。');
      const moves = this.db
        .prepare(
          `SELECT m.*,s.name AS stock_name,s.unit,s.kind,s.product_id,o.customer_id
        FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id
        WHERE m.date BETWEEN ? AND ? ORDER BY m.date,m.rowid`,
        )
        .all(v.period + '-01', date) as unknown as Movement[];
      const items = new Map<number, Item>();
      const stocks = this.db
        .prepare(
          `SELECT s.*,coalesce((SELECT sum(delta_units) FROM stock_movements WHERE item_id=s.id AND date<?),0) AS qty
        FROM stock_items s WHERE EXISTS(SELECT 1 FROM stock_movements WHERE item_id=s.id AND date<=?)`,
        )
        .all(v.period + '-01', date);
      for (const stock of stocks) {
        const key = Number(stock.id),
          initial = Number(stock.qty),
          provided = openingMap.get(key);
        const prior = this.db
          .prepare(
            'SELECT end_qty,end_cents,unit FROM fin_inventory_costs WHERE period=? AND stock_id=?',
          )
          .get(previous, key);
        if (provided && (provided.unit !== stock.unit || provided.quantity !== initial))
          financeError('库存期初数量或单位不一致。');
        if (prior && (prior.unit !== stock.unit || prior.end_qty !== initial))
          financeError('库存单位或期初数量与上期成本不一致。');
        if (initial && !prior && !provided)
          financeError('缺少库存期初成本：' + stock.name + '，请在“计算成本”窗口填写。');
        items.set(key, {
          stockId: key,
          name: String(stock.name),
          kind: String(stock.kind),
          unit: String(stock.unit),
          openingQty: initial,
          openingCents: Number(prior?.end_cents ?? provided?.amount ?? 0),
          inQty: 0,
          inCents: 0,
          outQty: 0,
          outCents: 0,
          endQty: 0,
          endCents: 0,
        });
      }
      const balances = new Map<string, number>();
      const mapping = financeTemplate(this.store, 'inventory');
      const post = (code: string, delta: number) =>
        balances.set(code, (balances.get(code) ?? 0) + delta);
      const adjustments = this.db
        .prepare(
          `SELECT e.id,e.date,e.snapshot,sum(l.net_cents-l.estimate_cents) AS amount
        FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id JOIN fin_vouchers v ON v.id=i.voucher_id
        JOIN fin_obligations o ON o.id=l.obligation_id JOIN fin_events e ON e.id=o.event_id
        WHERE i.direction='purchase' AND i.date BETWEEN ? AND ? AND v.status='posted' AND l.estimate_cents IS NOT NULL
        GROUP BY e.id`,
        )
        .all(v.period + '-01', date);
      const byEvent = new Map(adjustments.map((r) => [r.id, Number(r.amount)]));
      const spread = (snapshot: FinanceSourceSnapshot, delta: number) => {
        const lines = (snapshot.doc.lines ?? snapshot.doc.items)!;
        const basis = Number(snapshot.money?.net);
        if (delta && (!basis || basis + delta < 0))
          financeError('到票调差缺少有效的原暂估分摊金额。');
        let used = 0,
          cumulative = 0;
        return lines.map((line, i) => {
          const original = Number(snapshot.money?.lines[i]?.net ?? 0);
          cumulative += original;
          const apportioned = delta
            ? Math.sign(delta) * proportion(Math.abs(delta), cumulative, basis)
            : 0;
          const change = apportioned - used;
          used = apportioned;
          return { line, amount: original + change, change };
        });
      };
      const lateStocks = new Set<number>();
      for (const adjustment of adjustments.filter(
        (r) => String(r.date) < v.period + '-01' && Number(r.amount) !== 0,
      )) {
        for (const { line, change } of spread(
          JSON.parse(String(adjustment.snapshot)),
          Number(adjustment.amount),
        )) {
          if (!change) continue;
          const item = items.get(Number(line.stockId));
          if (!item || item.kind !== 'raw' || item.unit !== line.item?.unit)
            financeError('跨期到票调差缺少对应原材料库存品或单位。');
          item.inCents += change;
          lateStocks.add(item.stockId);
        }
      }
      const production = new Map<
        string,
        { materials: number; qty: number; unit: string; stockId: number; cost: number }
      >();
      for (const m of moves.filter(
        (r) => r.kind === 'finished' && r.source_kind === 'flow_production' && r.delta_units > 0,
      )) {
        if (production.has(m.source_id)) financeError('完工记录对应多个入库批次，需先核对。');
        production.set(m.source_id, {
          materials: 0,
          qty: m.delta_units,
          unit: m.unit,
          stockId: m.item_id,
          cost: 0,
        });
      }
      const inbound = (m: Movement) => {
        const item = items.get(m.item_id)!,
          explicit = manualMap.get(m.id);
        let amount: number | null = null,
          counter: string | null = null;
        if (m.source_kind === 'flow_production' && m.kind === 'finished')
          amount = production.get(m.source_id)?.cost ?? null;
        else if (m.source_kind === 'flow_arrival' || m.source_kind === 'purchase_receipt') {
          const kind = m.source_kind === 'flow_arrival' ? 'arrival' : 'legacy_arrival';
          const event = this.db
            .prepare(
              `SELECT e.id,e.snapshot,e.status FROM fin_source_observations x JOIN fin_events e ON e.id=x.event_id
            LEFT JOIN fin_obligations o ON o.event_id=e.id AND o.amount_cents>0
            WHERE x.source_kind=? AND x.source_id=? ORDER BY o.id DESC LIMIT 1`,
            )
            .get(kind, m.source_id);
          if (event?.status !== 'generated')
            financeError('原材料到货财务资料未完成，请核对入库记录：' + item.name + '，' + m.date);
          const snap = JSON.parse(String(event.snapshot));
          const lines = spread(snap, byEvent.get(event.id) ?? 0).filter(
            ({ line }) => Number(line.stockId) === m.item_id,
          );
          if (lines.some(({ line }) => line.item?.unit !== m.unit))
            financeError('到货单位与库存单位不一致。');
          const matching = lines.filter(
            ({ line }) => quantityUnits(String(line.stockedQuantity ?? '0')) === m.delta_units,
          );
          if (matching.length === 1) amount = matching[0].amount;
        }
        if (explicit) {
          if (explicit.unit !== m.unit) financeError('成本输入单位与原流水不一致。');
          amount = explicit.amount;
          counter =
            explicit.counterAccount ?? (m.source_kind === 'manual' ? mapping('adjustment') : null);
        }
        if (amount === null) financeError('缺少入库成本或无法确认数量对应关系：' + item.name + '，' + m.date);
        item.inQty += m.delta_units;
        item.inCents += amount;
        if (counter && amount) {
          post(mapping(m.kind), amount);
          post(counter, -amount);
        }
      };
      const sales: {
        id: string;
        orderId: number | null;
        customerId: number | null;
        productId: number | null;
        cost: number;
      }[] = [];
      const outbound = (m: Movement) => {
        const item = items.get(m.item_id)!,
          qty = -m.delta_units,
          explicit = manualMap.get(m.id);
        if (explicit && explicit.unit !== m.unit) financeError('出库成本单位与原流水不一致。');
        if (item.outQty + qty > item.openingQty + item.inQty)
          financeError('出库量超过可计价库存 ' + item.name);
        const amount =
          proportion(
            item.openingCents + item.inCents,
            item.outQty + qty,
            item.openingQty + item.inQty,
          ) - item.outCents;
        item.outQty += qty;
        item.outCents += amount;
        if (m.kind === 'raw' && m.source_kind === 'flow_production') {
          const job = production.get(m.source_id);
          if (!job) financeError('领料缺少对应的完工入库，请核对领料记录：' + item.name + '，' + m.date);
          job.materials += amount;
          post(mapping('material'), amount);
          post(mapping('raw'), -amount);
        } else if (m.kind === 'finished' && m.source_kind === 'flow_delivery') {
          sales.push({
            id: m.id,
            orderId: m.customer_order_id,
            customerId: m.customer_id,
            productId: m.product_id,
            cost: amount,
          });
          post(mapping('sales'), amount);
          post(mapping('finished'), -amount);
        } else {
          const counter =
            explicit?.counterAccount ?? (m.source_kind === 'manual' ? mapping('adjustment') : null);
          if (!counter) financeError('请核对库存出库或冲销的对方科目：' + item.name + '，' + m.date);
          post(counter, amount);
          post(mapping(m.kind), -amount);
        }
      };
      for (const m of moves.filter((m) => m.kind === 'raw' && m.delta_units > 0)) inbound(m);
      for (const key of lateStocks) {
        const item = items.get(key)!;
        if (!(item.openingQty + item.inQty) || item.openingCents + item.inCents < 0)
          financeError('跨期到票调差没有可计价原材料或使成本为负，需先核对 ' + item.name);
      }
      for (const m of moves.filter((m) => m.kind === 'raw' && m.delta_units < 0)) outbound(m);
      const pools = this.db
        .prepare(
          `SELECT e.account_code,sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS amount
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.period=?
        AND (e.account_code IN ('400102','400103') OR e.account_code LIKE '4101%') GROUP BY e.account_code`,
        )
        .all(v.period);
      const pool = pools.reduce((n, r) => n + Number(r.amount), 0),
        jobs = [...production.values()];
      const useOutput = before.cost_allocation === 'output';
      if (pool < 0) financeError('制造费用或人工净额为负，须人工核对。');
      if (pool && useOutput && new Set(jobs.map((j) => j.unit)).size > 1)
        financeError('完工产量单位不同，不能按产量合并分摊。');
      const basis = (job: (typeof jobs)[number]) => (useOutput ? job.qty : job.materials);
      const totalBasis = jobs.reduce((n, j) => n + basis(j), 0);
      if (pool && !totalBasis) financeError('缺少完工分摊基数。');
      let used = 0,
        cumulative = 0;
      for (const job of jobs) {
        cumulative += basis(job);
        const allocated = pool ? proportion(pool, cumulative, totalBasis) : 0;
        job.cost = job.materials + allocated - used;
        used = allocated;
        post(mapping('finished'), job.cost);
        post(mapping('material'), -job.materials);
      }
      for (const r of pools) post(String(r.account_code), -Number(r.amount));
      for (const m of moves.filter((m) => m.kind === 'finished' && m.delta_units > 0)) inbound(m);
      for (const m of moves.filter((m) => m.kind === 'finished' && m.delta_units < 0)) outbound(m);
      const entries = [...balances]
        .filter(([, amount]) => amount !== 0)
        .map(([code, amount]) => entry(code, Math.max(0, amount), Math.max(0, -amount)));
      const voucher = entries.length
        ? Number(
            this.ledger.createLinked(
              user,
              'costing',
              Number(v.period.replace('-', '')),
              { date, description: '月末加权平均成本结转', requestId: v.requestId, entries },
              'finance:close',
            ).header.id,
          )
        : null;
      const insert = this.db.prepare(
        'INSERT INTO fin_inventory_costs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const item of items.values()) {
        item.endQty = item.openingQty + item.inQty - item.outQty;
        item.endCents = item.openingCents + item.inCents - item.outCents;
        insert.run(
          item.stockId,
          v.period,
          item.name,
          item.unit,
          item.openingQty,
          item.openingCents,
          item.inQty,
          item.inCents,
          item.outQty,
          item.outCents,
          item.endQty,
          item.endCents,
        );
      }
      const sale = this.db.prepare('INSERT INTO fin_cost_sales VALUES(?,?,?,?,?,?)');
      for (const m of sales) sale.run(v.period, m.id, m.orderId, m.customerId, m.productId, m.cost);
      const pending = this.db
        .prepare(
          `SELECT * FROM fin_events WHERE substr(date,1,7)=? AND (
          status='cost_pending' OR (source_kind='stock' AND status='difference' AND source_id IN (
            SELECT id FROM stock_movements WHERE action='adjust' AND substr(date,1,7)=?)))`,
        )
        .all(v.period, v.period);
      for (const e of pending) {
        this.db
          .prepare("UPDATE fin_events SET status='costed',version=version+1 WHERE id=?")
          .run(e.id);
        financeAudit(this.store, user, 'cost', 'fin_events', Number(e.id), e, {
          ...e,
          status: 'costed',
          version: Number(e.version) + 1,
        });
      }
      return periodJob(this.store, user, v.period, 'costing', voucher, {
        rows: [...items.values()],
        sales,
        valuations: v.valuations,
      });
    });
  }

  margin(actor: Actor | null, raw: unknown) {
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
      `WITH revenue AS (
      SELECT json_extract(line.value,'$.orderId') AS order_id,json_extract(e.snapshot,'$.doc.customerId') AS customer_id,
        json_extract(line.value,'$.productId') AS product_id,substr(e.date,1,7) AS period,
        coalesce(json_extract(e.snapshot,'$.money.lines['||line.key||'].net'),0) AS amount
      FROM fin_source_observations x JOIN fin_events e ON e.id=x.event_id,json_each(e.snapshot,'$.doc.lines') line
      WHERE e.source_kind='delivery' AND x.status='confirmed' AND e.status NOT IN ('source_deleted','before_opening')
      AND substr(e.date,1,7)=?
    ), facts AS (SELECT ${group} AS group_id,amount AS revenue,NULL AS cost FROM revenue
      UNION ALL SELECT ${group},0,cost_cents FROM fin_cost_sales WHERE period=?)
    SELECT group_id,sum(revenue) AS revenue,sum(cost) AS cost,sum(revenue)-sum(cost) AS margin,
      (sum(cost) IS NULL OR NOT EXISTS(SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='costing')) AS estimated
      FROM facts GROUP BY group_id`,
      [q.period, q.period, q.period],
      raw,
      'group_id',
    );
    const selected = data.rows.filter((r) => r.estimated && r.cost == null).map((r) => r.group_id);
    if (!selected.length) return data;
    const keys = {
      order: 'm.customer_order_id',
      customer: 'o.customer_id',
      product: 's.product_id',
      month: 'substr(m.date,1,7)',
    };
    const key = keys[q.group];
    const facts = this.db
      .prepare(
        `SELECT ${key} AS group_id,m.item_id,sum(-m.delta_units) AS quantity,
      c.opening_qty+c.in_qty AS cost_quantity,c.opening_cents+c.in_cents AS cost_amount
      FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id
      JOIN flow_documents f ON f.id=cast(m.source_id AS INTEGER) AND f.kind='delivery' AND f.status='confirmed'
      LEFT JOIN fin_inventory_costs c ON c.stock_id=m.item_id AND c.unit=s.unit AND c.period=(
        SELECT max(prior.period) FROM fin_inventory_costs prior WHERE prior.stock_id=m.item_id AND prior.unit=s.unit AND prior.period<?)
      WHERE m.source_kind='flow_delivery' AND m.delta_units<0 AND substr(m.date,1,7)=?
      AND EXISTS(SELECT 1 FROM json_each(?) j WHERE j.value IS ${key}) GROUP BY group_id,m.item_id`,
      )
      .all(q.period, q.period, JSON.stringify(selected));
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
