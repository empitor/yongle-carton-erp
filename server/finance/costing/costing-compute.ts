/**
 * 算一个月的成本（只读不写）：期初、跨期调差、完工批次、出入库计价（在 costing-month.ts 的库存账里记）、
 * 制造费用分摊，得出凭证分录和各库存品的数量金额。写凭证和成本明细在 costing.ts 的 commit。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import { many, one, rows } from '../../core/index.js';
import { financeError } from '../base/core.js';
import { proportion } from '../base/amounts.js';
import type { CostLink, manual, Mark, opening } from './costing-details.js';
import { invoiceAdjustments, spreadAdjustment, type InvoiceAdjustments } from './costing-invoice-adjust.js';
import { movementSource } from '../../../shared/business/index.js';
import { isReturn, MonthCostBook, type CompletionOrigin, type Item, type ProductionJob, type ReversalOrigin } from './costing-month.js';
import { financeFacts, type StockMovement as Movement } from '../../flow/index.js';
import { awaitingRed, lateMovements, originsOf } from './costing-origins.js';
import { arrivalEvents, unbookedVoidArrivals } from './costing-arrivals.js';
import { adjacentPeriod, endOfMonth } from '../base/periods.js';
import { returnCosts } from '../events/return-estimates.js';
import { entry } from '../base/query.js';
import { readFinanceSettings } from '../base/settings.js';
import { financeTemplate } from '../base/template.js';

type Opening = z.output<typeof opening>;
type Valuation = z.output<typeof manual>;
/** 结账检查按那次计算时的口径重算：那次的时间点和用过的到票调差 */
type AsOf = { mark: Mark; applied: Set<string> };
/** 算一个月要的范围：这个月第一天、月末、上个月，和不计成本的到货单（unbookedVoidArrivals） */
type Month = { start: string; date: string; previous: string; exclude: readonly string[] };

/**
 * 制造费用和人工（pool）按完工批次累计分摊：按产量（useOutput）或领料成本占比，每批都是整数分、合计正好等于 pool。
 * 每批的完工成本 = 领料成本 + 分到的费用，写回 job.cost。
 */
function allocateOverhead(
  pool: number,
  jobs: { materials: number; qty: number; unit: string; cost: number }[],
  useOutput: boolean,
) {
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
  }
}

const priorCost = rows.fin_inventory_costs.pick({ end_qty: true, end_cents: true, unit: true });

/**
 * 各库存品的期初：上月月末成本，启用月用人填的期初成本。期初数量 = start 以前的结存减去跨期补登的流水，
 * 要和上月月末、人填的数量对上。
 */
function openingItems(db: DatabaseSync, month: Month, late: Movement[], provided: Map<number, Opening>, asOf?: AsOf) {
  const { start, date, previous, exclude } = month;
  /** 跨期补登的流水按库存品合计的数量：期初数量扣掉它们，才能和上月月末对上 */
  const lateQty = new Map<number, number>();
  for (const m of late) lateQty.set(m.item_id, (lateQty.get(m.item_id) ?? 0) + m.delta_units);
  const items = new Map<number, Item>();
  for (const stock of financeFacts.stock.balancesBefore(db, { start, end: date, asOf: asOf?.mark, exclude })) {
    const initial = stock.qty - (lateQty.get(stock.id) ?? 0),
      given = provided.get(stock.id);
    const prior = one(
      db,
      priorCost,
      'SELECT end_qty,end_cents,unit FROM fin_inventory_costs WHERE period=? AND stock_id=?',
      previous,
      stock.id,
    );
    if (given && (given.unit !== stock.unit || given.quantity !== initial)) financeError('库存期初数量或单位不一致。');
    if (prior && prior.unit !== stock.unit) financeError('库存单位与上期成本不一致：' + stock.name + '。');
    if (prior && prior.end_qty !== initial)
      financeError(
        '库存“' + stock.name + '”的期初数量和 ' + previous + ' 月末成本对不上，可能改过已算成本月份的流水。' +
          '请先重做 ' + previous + ' 的成本计算（已结账的先反结账）。',
      );
    if (initial && !prior && !given) financeError('缺少库存期初成本：' + stock.name + '，请在“计算成本”窗口填写。');
    items.set(stock.id, {
      stockId: stock.id, name: stock.name, kind: stock.kind, unit: stock.unit,
      openingQty: initial, openingCents: prior?.end_cents ?? given?.amount ?? 0,
      inQty: 0, inCents: 0, outQty: 0, outCents: 0, endQty: 0, endCents: 0,
    });
  }
  return items;
}

/**
 * 以前月份到货的调差直接进库存金额（跨期调差）；同一批到货的蓝票调差和红票冲减合计后一起分摊。
 * 用上的到货批次记进 consumed，有调差的库存品记进 adjustedStocks。
 */
function earlierAdjustments(
  items: Map<number, Item>,
  adjustments: InvoiceAdjustments,
  scope: { start: string; consumed: Set<number>; adjustedStocks: Set<number> },
) {
  for (const [eventId, event] of adjustments.events) {
    if (event.date >= scope.start) continue;
    scope.consumed.add(eventId);
    const delta = adjustments.delta.get(eventId) ?? 0;
    if (!delta) continue;
    for (const { line, change } of spreadAdjustment(event.snapshot, adjustments.prior.get(eventId) ?? 0, delta)) {
      if (!change) continue;
      const item = line.stockId == null ? undefined : items.get(line.stockId);
      if (!item || item.kind !== 'raw' || item.unit !== line.item?.unit)
        financeError('跨期到票调差缺少对应原材料库存品或单位。');
      item.inCents += change;
      scope.adjustedStocks.add(item.stockId);
    }
  }
}

/** 本月的完工批次（成品完工入库，按完工单），领料成本和完工成本后面再算 */
function productionJobs(moves: Movement[]) {
  const production = new Map<string | null, ProductionJob>();
  for (const m of moves.filter(
    (r) => r.kind === 'finished' && r.source_kind === movementSource.production && r.delta_units > 0,
  )) {
    if (production.has(m.source_id)) financeError('完工记录对应多个入库批次，需先核对。');
    production.set(m.source_id, { materials: 0, qty: m.delta_units, unit: m.unit, stockId: m.item_id, cost: 0 });
  }
  return production;
}

/**
 * 冲销流水找原单据（人填了金额的不找）：退回库存的找原流水，扣回成品的找原完工入库，
 * 冲回到货的按这批还挂着的暂估（查不到的照普通出库，要人选对方科目）
 */
function reversalOrigins(db: DatabaseSync, moves: Movement[], manualMap: Map<string, Valuation>, start: string) {
  const reversals = moves.filter((m) => m.source_kind === movementSource.reversal && !manualMap.has(m.id));
  const origins = new Map<string, ReversalOrigin | null>();
  /** 冲销完工单扣回的成品，查得到原完工成本的 */
  const completions = new Map<string, CompletionOrigin>();
  /** 撤销或更正冲回到货，查得到原暂估的：流水 → 要冲减的入库金额 */
  const arrivals = new Map<string, number>();
  for (const [id, found] of originsOf(db, reversals, start)) {
    if (found.kind === 'reversal') origins.set(id, found.origin);
    else if (found.kind === 'arrival') {
      if (found.origin !== null) arrivals.set(id, found.origin);
    } else if (found.origin) completions.set(id, found.origin);
  }
  return { origins, completions, arrivals };
}

/**
 * 采购退货（及冲销）：未到票就退、财务已按暂估单价冲减暂估的（return-estimates.ts），按退掉的暂估金额冲减入库成本，
 * 退货撤销、暂估加回来的再加回；已到票后才退的只改入库数量，金额由供应商红票体现，避免重复扣成本。
 */
function valueReturns(db: DatabaseSync, items: Map<number, Item>, moves: Movement[]) {
  const returned = moves.filter((m) => isReturn(m));
  const returnIds = new Set(returned.flatMap((m) => (m.source_id === null ? [] : [m.source_id])));
  const returnPrices = returnCosts(db, [...returnIds]);
  for (const m of returned) {
    const item = items.get(m.item_id);
    if (!item) financeError('采购退货缺少对应的库存品：' + m.date);
    item.inQty += m.delta_units;
    const priced = m.source_id === null ? undefined : returnPrices.get(m.source_id)?.get(m.item_id);
    if (priced && (m.delta_units < 0 || priced.restored)) item.inCents += Math.sign(m.delta_units) * priced.value;
  }
}

/**
 * 原材料：入库、撤销到货按原暂估冲减（红字入库）、采购退货，调差和退货数量都算进来以后再出库计价
 * （成本为负的先归零；有调差、撤销过到货的数量已是 0 的出库后结清，撤销的到货到过票、等红票的那部分留着）
 */
function valueRaw(
  db: DatabaseSync,
  book: MonthCostBook,
  moves: Movement[],
  s: { items: Map<number, Item>; adjustedStocks: Set<number>; end: string; exclude: readonly string[]; asOf?: AsOf },
) {
  const raw = moves.filter((m) => m.kind === 'raw');
  const sameRun = (m: Movement) => book.sameRun(m);
  for (const m of raw.filter((m) => m.delta_units > 0 && !isReturn(m) && !sameRun(m))) book.inbound(m);
  for (const m of raw.filter((m) => book.isArrivalUndo(m))) book.undoArrival(m);
  valueReturns(db, s.items, raw);
  const settled = new Set([...s.adjustedStocks, ...book.undone]);
  book.floorNegative(settled);
  for (const m of raw.filter((m) => (m.delta_units < 0 && !isReturn(m) && !book.isArrivalUndo(m)) || sameRun(m)))
    if (sameRun(m)) book.reverseOut(m);
    else book.outbound(m);
  book.clearZero(settled, awaitingRed(db, book.emptied(settled), { end: s.end, exclude: s.exclude, asOf: s.asOf }));
}

const poolRow = z.object({ account_code: rows.fin_entries.shape.account_code, amount: z.number() });
/** 这个月已记账的制造费用和人工（成本计算自己的凭证不算），按科目合计；分摊进完工批次后转出 */
function overheadPools(db: DatabaseSync, period: string) {
  return many(
    db,
    poolRow,
    `SELECT e.account_code,sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS amount
    FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.period=?
    AND coalesce(v.module_source,'')<>'costing'
    AND (e.account_code IN ('400102','400103') OR e.account_code LIKE '4101%') GROUP BY e.account_code`,
    period,
  );
}

/** 成品：完工入库、冲销完工单扣回，再出库计价（同原材料，按原成本冲回的库存品出库前后各结清一次） */
function valueFinished(book: MonthCostBook, moves: Movement[], completions: Map<string, CompletionOrigin>) {
  const sameRun = (m: Movement) => book.sameRun(m);
  for (const m of moves.filter((m) => m.kind === 'finished' && m.delta_units > 0 && !isReturn(m) && !sameRun(m)))
    book.inbound(m);
  for (const m of moves.filter((m) => m.kind === 'finished' && completions.has(m.id))) book.undoCompletion(m);
  book.floorNegative(book.valued);
  for (const m of moves.filter(
    (m) => m.kind === 'finished' && ((m.delta_units < 0 && !isReturn(m) && !completions.has(m.id)) || sameRun(m)),
  ))
    if (sameRun(m)) book.reverseOut(m);
    else book.outbound(m);
  book.clearZero(book.valued, new Map());
}

/**
 * 算一个月的成本，只读不写：本月的流水，加上日期在已算成本月份、上次成本计算以后才补登的流水
 * （跨期补登，计入这个月）。asOf 给结账检查用：只算那次计算时已有的流水和到票调差，看按现在的数重算变没变。
 */
export function computeCosting(
  store: Store,
  period: string,
  openingInput: Opening[],
  valuations: Valuation[],
  asOf?: AsOf,
) {
  const db = store.db;
  const reversed = financeFacts.stock.reversedArrivals(db);
  const exclude = unbookedVoidArrivals(db, reversed);
  const month: Month = { start: period + '-01', date: endOfMonth(period), previous: adjacentPeriod(period, -1), exclude };
  const openingMap = new Map(openingInput.map((r) => [r.stockId, r]));
  const manualMap = new Map(valuations.map((r) => [r.movementId, r]));
  if (openingMap.size !== openingInput.length || manualMap.size !== valuations.length)
    financeError('成本输入存在重复记录。');
  const late = lateMovements(db, period, exclude, asOf?.mark);
  const dates = { from: month.start, to: month.date };
  const moves = [...late, ...financeFacts.stock.movements(db, { dates, asOf: asOf?.mark, exclude })];
  const items = openingItems(db, month, late, openingMap, asOf);
  const mapping = financeTemplate(store, 'inventory');
  // 采购到票调差和红票冲减，凭证已记账、以前的成本计算还没用过的都在这里。
  const adjustments = invoiceAdjustments(db, month.date, asOf?.applied);
  /** 本月有到票调差或红票冲减的库存品；本月实际用上调差的到货批次（它们的调差记为已用） */
  const adjustedStocks = new Set<number>(),
    consumed = new Set<number>();
  earlierAdjustments(items, adjustments, { start: month.start, consumed, adjustedStocks });
  const production = productionJobs(moves);
  const { origins, completions, arrivals } = reversalOrigins(db, moves, manualMap, month.start);
  const arrived = moves.flatMap((m) => (m.source_kind === movementSource.arrival && m.source_id !== null ? [m.source_id] : []));
  const events = arrivalEvents(db, arrived, reversed);
  const book = new MonthCostBook({
    start: month.start, items, mapping, manualMap, origins, completions, production,
    adjustments, consumed, adjustedStocks, arrivalEvent: (m) => (m.source_id === null ? undefined : events.get(m.source_id)), arrivals,
  });
  valueRaw(db, book, moves, { items, adjustedStocks, end: month.date, exclude, asOf });
  const pools = overheadPools(db, period),
    jobs = [...production.values()];
  allocateOverhead(pools.reduce((n, r) => n + r.amount, 0), jobs, readFinanceSettings(db).cost_allocation === 'output');
  for (const job of jobs) {
    book.post(mapping('finished'), job.cost);
    book.post(mapping('material'), -job.materials);
  }
  for (const r of pools) book.post(r.account_code, -r.amount);
  valueFinished(book, moves, completions);
  const entries = [...book.balances]
    .filter(([, amount]) => amount !== 0)
    .map(([code, amount]) => entry(code, Math.max(0, amount), Math.max(0, -amount)));
  for (const item of items.values()) {
    item.endQty = item.openingQty + item.inQty - item.outQty;
    item.endCents = item.openingCents + item.inCents - item.outCents;
  }
  return {
    entries,
    items: [...items.values()],
    sales: book.sales,
    /** 本次用掉的到票调差（b:发票:往来）和红票冲减（r:红票:往来），以后的成本计算不再重复取 */
    applied: [...consumed].flatMap((e) => adjustments.keys.get(e) ?? []),
    /** 每笔出库的成本和对方科目：[流水, 分, 科目]，以后月份冲销时按原成本冲回 */
    issues: [...book.issued].map(([key, x]): CostLink => [key, x.cost, x.counter]),
    /** 每笔完工入库的成本和冲销时的对方科目：[流水, 分, 科目]，以后月份冲销完工单时按原完工成本冲回 */
    receipts: [...book.received].map(([key, cost]): CostLink => [key, cost, mapping('material')]),
    /** 转入主营业务成本的库存余额：数量为 0 仍有余额，或调差后成本为负的超出部分 */
    residuals: book.residuals,
    /** 跨期补登、计入这个月的流水 */
    late: late.map((m) => m.id),
  };
}
