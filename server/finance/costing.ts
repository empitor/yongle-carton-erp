import { z } from 'zod';
import { periodSchema } from '../../shared/finance/index.js';
import { errorMessage } from '../../shared/core/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, isConstraintError, many, rehearse, rows as tableRows } from '../core/index.js';
import { financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { entryNet, expectedVoucher, jobVoucherNet, periodJob, periodJobResult, sameNet, withdrawJob } from './jobs.js';
import { id, pageSql, request } from './query.js';
import { financeFacts } from '../flow/index.js';
import { movementSource, openingStocks, unbookedVoidArrivals, type Mark } from './costing-source.js';
import { invoiceAdjustments } from './costing-invoice-adjust.js';
import { computeCosting } from './costing-compute.js';
import { costingDetails, manual, markOf, opening, readCostingDetails } from './costing-details.js';
import type { Item } from './costing-month.js';
import { costingJob, lateMovements, originsOf } from './costing-origins.js';
import { adjacentPeriod, endOfMonth } from './periods.js';
import { readFinanceSettings } from './settings.js';

/** 一次计算成本最多填几行期初成本、几笔出入库金额 */
const COSTING_INPUT_MAX = 2000;
type Opening = z.output<typeof opening>;
type Valuation = z.output<typeof manual>;

/** 有数的库存品行（期初、入库、出库有一项不是 0） */
const hasMovement = (r: Item) => r.openingQty || r.openingCents || r.inQty || r.inCents || r.outQty || r.outCents;
/** 比较两次计算各库存品的数量金额用的键（全是 0 的行不比：之后才登记流水的库存品会多出一行空的） */
const itemKeys = (items: Item[]) =>
  items
    .filter(hasMovement)
    .map((r) => [r.stockId, r.unit, r.openingQty, r.openingCents, r.inQty, r.inCents, r.outQty, r.outCents].join('|'))
    .sort();

/** 启用月的期初成本：那次计算记下的各库存品里有期初数量或金额的 */
const openingOf = (items: Item[]): Opening[] =>
  items
    .filter((r) => r.openingQty || r.openingCents)
    .map((r) => ({ stockId: r.stockId, unit: r.unit, quantity: r.openingQty, amount: r.openingCents }));

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
      {
        schema: tableRows.fin_inventory_costs,
        sql: 'SELECT * FROM fin_inventory_costs WHERE period=? AND (? IS NULL OR stock_id=?)',
        values: [q.period, q.stockId ?? null, q.stockId ?? null],
        order: 'stock_id',
      },
      raw,
    );
  }

  /**
   * 撤回这个月和以后月份已算的成本（从后往前）：凭证红冲或作废，执行记录改名留底，
   * 库存成本和销售成本明细删掉重算（原来的数在留底的执行记录里）。
   */
  private withdraw(user: Actor, period: string, expectedVoucherId?: number | null) {
    const jobs = many(
      this.db,
      tableRows.fin_period_jobs.pick({ period: true }),
      "SELECT period FROM fin_period_jobs WHERE kind='costing' AND period>=? ORDER BY period DESC",
      period,
    ).map((r) => r.period);
    if (!jobs.includes(period)) financeError('这个月还没算成本，不用重做。', 409);
    for (const p of jobs) {
      withdrawJob(this.store, user, {
        period: p,
        kind: 'costing',
        reason: '重做 ' + period + ' 成本',
        expectedVoucherId: p === period ? expectedVoucherId : undefined,
      });
      const rows = many(this.db, tableRows.fin_inventory_costs, 'SELECT * FROM fin_inventory_costs WHERE period=?', p);
      const sales = many(this.db, tableRows.fin_cost_sales, 'SELECT * FROM fin_cost_sales WHERE period=?', p);
      this.db.prepare('DELETE FROM fin_inventory_costs WHERE period=?').run(p);
      this.db.prepare('DELETE FROM fin_cost_sales WHERE period=?').run(p);
      financeAudit(this.store, user, {
        action: 'withdraw',
        entity: 'fin_inventory_costs',
        id: null,
        before: { period: p, rows, sales },
        after: null,
      });
    }
  }

  /**
   * 结账检查用：按那次计算时已有的流水、到票调差和当时填的金额，用现在的数重算一遍，
   * 结果（凭证、各库存品的数量金额）和那次不一样就要重做。之后才补登的流水和调差按口径计入以后月份，不算在内。
   */
  stale(actor: Actor | null, rawPeriod: unknown): { stale: boolean; reason: string | null } | null {
    financeActor(actor);
    const period = periodSchema.parse(rawPeriod);
    const job = costingJob(this.db, period);
    if (!job) return null;
    const details = readCostingDetails(job);
    const openingRows = period === readFinanceSettings(this.db).start_period ? openingOf(details.rows) : [];
    try {
      return rehearse(this.db, () => {
        // 在保存点里先把这个月的执行记录拿掉，compute 才会当成“这个月还没算过”重算一遍；最后一定退回保存点，记录原样还在
        this.db.prepare("DELETE FROM fin_period_jobs WHERE period=? AND kind='costing'").run(period);
        const result = this.compute(period, openingRows, details.valuations, {
          mark: markOf(details),
          applied: new Set(details.applied),
        });
        const sameRows = JSON.stringify(itemKeys(result.items)) === JSON.stringify(itemKeys(details.rows));
        const same = sameRows && sameNet(entryNet(result.entries), jobVoucherNet(this.store, job.voucher_id));
        return {
          stale: !same,
          reason: same ? null : '成本算完以后，这个月的出入库、费用或上月成本变了。',
        };
      });
    } catch (error) {
      // 重算时报的业务提示（数量对不上、单位变了……）就是要重做的原因；数据库约束挡下的写入是程序问题，原样抛出，不当成“要重做”
      if (isConstraintError(error)) throw error;
      return { stale: true, reason: errorMessage(error) };
    }
  }

  /**
   * 入库要填金额；非手工的出入库都要选对方科目，手工流水默认走待处理财产损溢。
   * 冲销送货、完工单退回的库存，查得到原出库成本的系统按原成本冲回；冲销完工单扣回的成品，
   * 查得到原完工成本的按原成本冲回生产成本；撤销或更正冲回记过账的到货，按原暂估冲减入库（金额可以是 0），都不用填。
   */
  private valuationsToFill(period: string, lateIds: string[], exclude: readonly string[]) {
    const start = period + '-01';
    const manualRows = financeFacts.stock.manualMovements(this.db, { from: start, to: endOfMonth(period), ids: lateIds, exclude });
    const reversals = manualRows
      .filter((m) => m.source_kind === movementSource.reversal)
      .map((m) => ({ id: m.id, item_id: m.item_id, delta_units: m.quantity, source_id: m.source_id, date: m.date, kind: m.kind }));
    const origins = originsOf(this.db, reversals, start);
    return manualRows.flatMap((row) => {
      const found = origins.get(row.id);
      if (found && found.origin !== null) return [];
      const { id, date, quantity, source_kind, notes, name, unit, kind } = row;
      const needs = { needsAmount: quantity > 0, needsCounter: source_kind !== movementSource.manual };
      return [{ id, date, quantity, source_kind, notes, name, unit, kind, late: date < start, ...needs }];
    });
  }

  /** 算成本前要人填的内容：启用月已有库存的期初成本，和系统算不出来的手工出入库。 */
  requirements(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    const isStart = period === readFinanceSettings(this.db).start_period;
    const job = costingJob(this.db, period);
    const details = job ? readCostingDetails(job) : null;
    // 重做时用这些：算这个月时会一起算进来的跨期补登（已算过的话按重做时的口径），上次填过的金额
    const exclude = unbookedVoidArrivals(this.db, financeFacts.stock.reversedArrivals(this.db));
    const late = lateMovements(this.db, period, exclude);
    return {
      period,
      done: !!job,
      isStart,
      opening: isStart ? openingStocks(this.db, period + '-01', adjacentPeriod(period, -1), exclude) : [],
      /** 跨期补登：日期在已算成本的月份、算完以后才登记的流水，计入这个月 */
      late: late.map((m) => ({
        id: m.id,
        date: m.date,
        name: m.stock_name,
        unit: m.unit,
        quantity: m.delta_units,
        source_kind: m.source_kind,
      })),
      /** 上次算这个月时填的金额和对方科目、期初金额，重做时带出来；原凭证号重做时带回来校验 */
      previousValuations: details ? details.valuations : [],
      previousOpening: details ? openingOf(details.rows).map((r) => ({ stockId: r.stockId, amount: r.amount })) : [],
      voucherId: job ? job.voucher_id : null,
      valuations: this.valuationsToFill(period, late.map((m) => m.id), exclude),
    };
  }

  /**
   * 已记账、发票日期不晚于该月末、还没被成本计算用过的到票调差和红票冲减（分）。
   * 月成本算完以后才记账的会留在这里，下个月的成本计算会把它算进库存；结账对账库存和 1403 时可以用来解释差额。
   */
  pendingInvoiceAdjustments(period: string) {
    const pending = invoiceAdjustments(this.db, endOfMonth(periodSchema.parse(period)));
    return {
      cents: [...pending.delta.values()].reduce((n, x) => n + x, 0),
      events: [...pending.delta].filter(([, x]) => x !== 0).map(([event]) => event),
    };
  }

  run(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({
        period: periodSchema,
        opening: z.array(opening).max(COSTING_INPUT_MAX).default([]),
        valuations: z.array(manual).max(COSTING_INPUT_MAX).default([]),
        /** 这个月已经算过：撤回原来的（以后月份算过的一起撤回），按现在的数重算 */
        redo: z.boolean().default(false),
        expectedVoucherId: expectedVoucher,
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'costing.run', input: v, result: periodJobResult(costingDetails) }, () => {
      this.ledger.openPeriod(user, endOfMonth(v.period));
      if (v.redo) this.withdraw(user, v.period, v.expectedVoucherId);
      if (exists(this.db, "SELECT 1 FROM fin_period_jobs WHERE kind='costing' AND period>=?", v.period))
        financeError('成本须按月顺序结转且不能重复；要按现在的数重算，用“重做成本”。', 409);
      const start = readFinanceSettings(this.db).start_period;
      if (v.period !== start && !costingJob(this.db, adjacentPeriod(v.period, -1)))
        financeError('请先完成上一期成本。', 409);
      if (v.period !== start && v.opening.length) financeError('仅启用期间可录入库存期初成本。');
      return this.commit(user, v, this.compute(v.period, v.opening, v.valuations));
    });
  }

  /** 算一个月的成本（costing-compute.ts）。单独一个方法：结账检查的测试要替换它来模拟算的时候出错。 */
  private compute(
    period: string,
    openingRows: Opening[],
    valuations: Valuation[],
    asOf?: { mark: Mark; applied: Set<string> },
  ) {
    return computeCosting(this.store, period, openingRows, valuations, asOf);
  }

  /**
   * 本月和以前月份还在等成本的都算处理了：以前月份已算过成本后才冲销的完工单、
   * 管理员改过的盘点流水，数量差异作为跨期调整进了这次的成本计算，不能永远挂着卡结账。
   */
  private markCosted(user: Actor, date: string) {
    const pending = many(
      this.db,
      tableRows.fin_events,
      `SELECT * FROM fin_events WHERE date<=? AND (status='cost_pending'
          OR (source_kind='stock' AND status='difference' AND source_id IN (SELECT value FROM json_each(?))))`,
      date,
      JSON.stringify(financeFacts.stock.adjustIds(this.db, date)),
    );
    for (const e of pending) {
      this.db.prepare("UPDATE fin_events SET status='costed',version=version+1 WHERE id=?").run(e.id);
      const after = { ...e, status: 'costed', version: e.version + 1 };
      financeAudit(this.store, user, { action: 'cost', entity: 'fin_events', id: e.id, before: e, after });
    }
  }

  private commit(
    user: Actor,
    v: { period: string; requestId: string; valuations: Valuation[] },
    result: ReturnType<FinanceCosting['compute']>,
  ) {
    const date = endOfMonth(v.period);
    const { entries, items, sales } = result;
    const description = '月末加权平均成本结转';
    const voucher = entries.length
      ? this.ledger.createLinked(
          user,
          'costing',
          Number(v.period.replace('-', '')),
          { date, description, requestId: v.requestId, entries },
          'finance:close',
        ).header.id
      : null;
    const insert = this.db.prepare(
      'INSERT INTO fin_inventory_costs(stock_id,period,stock_name,unit,opening_qty,opening_cents,in_qty,in_cents,out_qty,out_cents,end_qty,end_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const item of items) {
      const { stockId, name, unit, openingQty, openingCents, inQty, inCents, outQty, outCents, endQty, endCents } = item;
      insert.run(stockId, v.period, name, unit, openingQty, openingCents, inQty, inCents, outQty, outCents, endQty, endCents);
    }
    const sale = this.db.prepare(
      'INSERT INTO fin_cost_sales(period,movement_id,order_id,customer_id,product_id,cost_cents) VALUES(?,?,?,?,?,?)',
    );
    for (const m of sales) sale.run(v.period, m.id, m.orderId, m.customerId, m.productId, m.cost);
    this.markCosted(user, date);
    const { applied, issues, receipts, residuals, late } = result;
    const details = {
      rows: items,
      sales,
      valuations: v.valuations,
      applied,
      issues,
      receipts,
      residuals,
      late,
      /** 这次计算的时间和当时流水的最大行号：以后才登记、日期在这个月及以前的流水算跨期补登 */
      ranAt: new Date().toISOString(),
      maxRowid: financeFacts.stock.maxRowid(this.db),
    };
    return periodJob(this.store, user, { period: v.period, kind: 'costing', voucher, schema: costingDetails, details });
  }
}
