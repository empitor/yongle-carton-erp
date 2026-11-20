/**
 * 成本计算要查的以前的记录：上次成本计算的时间点、跨期补登的流水，
 * 冲销送货或完工单时找原出库、原完工入库的成本（同月的按本月算，以前月份的按当时记下的），
 * 撤销或更正到货时按这批还挂着的暂估冲回。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { quantityUnits } from '../../shared/core/index.js';
import { one, rows } from '../core/index.js';
import {
  bookedArrivalEvent,
  completionOriginals,
  lateMovementsBefore,
  movementSource,
  reversalOriginals,
  type Mark,
  type Movement,
  type ReversalOriginal,
  undoneArrivals,
} from './costing-source.js';
import { adjustedTotals, clearedEstimate, spreadAdjustment } from './costing-invoice-adjust.js';
import { readSnapshot, type EventSnapshot } from './source-snapshot.js';
import { markOf, readCostingDetails } from './costing-details.js';
import type { CompletionOrigin, ReversalOrigin, Sale } from './costing-month.js';
import { periodOf } from './days.js';
import { adjacentPeriod } from './periods.js';

/** 某个月成本计算执行记录（kind='costing'），没算过是 undefined */
export function costingJob(db: DatabaseSync, period: string) {
  return one(db, rows.fin_period_jobs, "SELECT * FROM fin_period_jobs WHERE kind='costing' AND period=?", period);
}

/**
 * 跨期补登：日期在这个月以前、上个月成本算完以后才登记的流水（以前的月份都算过成本，它们没算进去）。
 * 按推荐口径计入第一个还没算成本的月份，也就是这个月。asOf 只取那个时间点以前登记的（结账检查用）。
 */
export function lateMovements(db: DatabaseSync, period: string, asOf?: Mark) {
  const job = costingJob(db, adjacentPeriod(period, -1));
  if (!job) return [];
  return lateMovementsBefore(db, period + '-01', markOf(readCostingDetails(job)), asOf);
}

/** 那次成本计算记下的一笔成本：[流水, 分, 科目] 里的分和科目 */
const recordedCost = z.object({ cost: z.number(), counter: z.string() });
/** 某个月成本计算明细里记下的一笔出库（list 是 issues）或完工入库（receipts）的成本和对方科目 */
function recordedOf(db: DatabaseSync, list: 'issues' | 'receipts', period: string, movementId: string) {
  return one(
    db,
    recordedCost,
    `SELECT json_extract(x.value,'$[1]') AS cost,json_extract(x.value,'$[2]') AS counter
      FROM fin_period_jobs j,json_each(j.details,'$.${list}') x
      WHERE j.kind='costing' AND j.period=? AND json_extract(x.value,'$[0]')=?`,
    period,
    movementId,
  );
}

/** 一条冲销流水（flow_reversal）找原单据要的几项 */
type ReversalMovement = Pick<Movement, 'item_id' | 'delta_units' | 'source_id' | 'date'>;

/**
 * 冲销送货或完工单（flow_reversal）退回的库存找原单据流水（originals）：
 * 原流水都在本月、且不晚于冲销 → same（送货、领料按负数出库冲回）；
 * 原出库都在以前月份、且当时的成本计算记下了成本 → 按记下的成本和对方科目冲回
 * （送货冲回主营业务成本，生产领料冲回生产成本）；
 * 其他情况查不到原成本，返回 null，要在“计算成本”窗口填金额并选对方科目。
 */
function reversalOrigin(db: DatabaseSync, m: ReversalMovement, start: string, originals: ReversalOriginal[]): ReversalOrigin | null {
  if (!originals.length || originals.reduce((n, o) => n - o.delta_units, 0) !== m.delta_units) return null;
  if (originals.every((o) => o.date >= start && o.date <= m.date))
    return { same: true, originals: originals.map((o) => o.id) };
  if (m.delta_units < 0 || originals.some((o) => o.date >= start)) return null;
  const parts = new Map<string, number>(),
    sales: Sale[] = [];
  let cost = 0;
  for (const o of originals) {
    const recorded = recordedOf(db, 'issues', periodOf(o.date), o.id);
    if (!recorded) return null;
    cost += recorded.cost;
    parts.set(recorded.counter, (parts.get(recorded.counter) ?? 0) + recorded.cost);
    if (o.source_kind === movementSource.delivery && o.kind === 'finished')
      sales.push({
        id: o.id,
        orderId: o.customer_order_id,
        customerId: o.customer_id,
        productId: o.product_id,
        cost: -recorded.cost,
      });
  }
  return { same: false, cost, parts: [...parts], sales };
}

/**
 * 冲销完工单扣回的成品（flow_reversal 成品出库）找原完工入库：本月完工且不晚于冲销 → same，按本月算出的完工成本冲回；
 * 以前月份记下了完工成本 → 按原成本冲回生产成本；查不到返回 null，按月末均价出库，要在“计算成本”窗口选对方科目。
 */
export function completionOrigin(db: DatabaseSync, m: ReversalMovement, start: string): CompletionOrigin | null {
  if (m.source_id == null) return null;
  const originals = completionOriginals(db, m.source_id, m.item_id);
  if (originals.length !== 1 || originals[0].delta_units !== -m.delta_units) return null;
  const [original] = originals;
  if (original.date >= start) return original.date <= m.date ? { same: true } : null;
  const recorded = recordedOf(db, 'receipts', periodOf(original.date), original.id);
  return recorded ? { same: false, cost: recorded.cost, counter: recorded.counter } : null;
}

/**
 * 撤销或更正冲回到货（红字入库）：按这批到货还挂着的暂估冲减入库，返回金额（分），到票全部转走的是 0。
 * 还挂着的暂估 = 记账那条事件快照里这种料各行的暂估，减去到票时已经转走的（按各行暂估占比分摊，和到票调差同一个分摊）。
 * 冲回数量和原到货对不上、或这批到货没记过账（启用前的到货就是这样）返回 null，要人在“计算成本”窗口选对方科目。
 */
function arrivalOrigin(db: DatabaseSync, m: ReversalMovement, originals: ReversalOriginal[]): number | null {
  const event = m.source_id == null ? undefined : bookedArrivalEvent(db, m.source_id);
  if (!event || originals.reduce((n, o) => n + o.delta_units, 0) !== -m.delta_units) return null;
  const lines = linesOfStock(readSnapshot(event), -clearedEstimate(db, event.id), m.item_id);
  if (lines.reduce((n, { line }) => n + quantityUnits(line.stockedQuantity ?? '0'), 0) !== -m.delta_units) return null;
  return sumAmounts(lines);
}

/** 到货快照里这种料的各行，原暂估加上分摊到的 change（按各行暂估占比，和到票调差同一个分摊） */
const linesOfStock = (snapshot: EventSnapshot, change: number, stockId: number) =>
  spreadAdjustment(snapshot, 0, change).filter(({ line }) => line.stockId === stockId);
const sumAmounts = (lines: { amount: number }[]) => lines.reduce((n, l) => n + l.amount, 0);

/**
 * 这些库存品上撤销过的到货还挂在库存里、等红票冲的金额（分，按库存品合计）：撤销冲回的是还挂着的暂估，
 * 留在库存里的是到过票的部分，即这批进了库存的金额（原暂估加上到票调差、红票冲减）减去冲回的。
 * 数量为 0 时只留这部分等红票，其余（均价差这类）结清。adjusted 和成本计算同一个口径（见 adjustedTotals）。
 */
export function awaitingRed(db: DatabaseSync, stockIds: number[], month: { end: string; asOf?: { mark: Mark; applied: Set<string> } }) {
  const held = new Map<number, number>();
  const batches = stockIds.length
    ? undoneArrivals(db, stockIds, month.end, month.asOf?.mark).flatMap(({ source_id, item_id }) => {
        const event = bookedArrivalEvent(db, source_id);
        return event ? [{ item_id, event }] : [];
      })
    : [];
  const adjusted = adjustedTotals(db, month.end, batches.map((b) => b.event.id), month.asOf?.applied);
  for (const { item_id, event } of batches) {
    const snapshot = readSnapshot(event);
    const booked = sumAmounts(linesOfStock(snapshot, adjusted.get(event.id) ?? 0, item_id));
    const undone = sumAmounts(linesOfStock(snapshot, -clearedEstimate(db, event.id), item_id));
    held.set(item_id, (held.get(item_id) ?? 0) + booked - undone);
  }
  return held;
}

/**
 * 一条冲销流水按哪条路找到的原单据：completion 是冲销完工单扣回的成品，arrival 是撤销或更正冲回的到货（金额是要冲减的入库），
 * reversal 是其余（送货、完工单冲销退回的库存）
 */
export type ReversalLookup =
  | { kind: 'completion'; origin: CompletionOrigin | null }
  | { kind: 'arrival'; origin: number | null }
  | { kind: 'reversal'; origin: ReversalOrigin | null };
/**
 * 冲销流水找原单据的唯一入口（计算成本和“计算成本”窗口要填什么都走这里）：成品出库（冲销完工单扣回）找原完工入库，
 * 冲回到货的按原暂估，其余找原单据流水。origin 为 null 的是系统查不到原成本、要人填金额或选对方科目的。
 */
export function originOf(db: DatabaseSync, m: ReversalMovement & Pick<Movement, 'kind'>, start: string): ReversalLookup {
  if (m.kind === 'finished' && m.delta_units < 0) return { kind: 'completion', origin: completionOrigin(db, m, start) };
  const originals = m.source_id == null ? [] : reversalOriginals(db, m.source_id, m.item_id);
  return originals.some((o) => o.document_kind === 'arrival')
    ? { kind: 'arrival', origin: arrivalOrigin(db, m, originals) }
    : { kind: 'reversal', origin: reversalOrigin(db, m, start, originals) };
}
