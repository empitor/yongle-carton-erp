/**
 * 成本计算要查的以前的记录：上次成本计算的时间点、跨期补登的流水，
 * 冲销送货或完工单时找原出库、原完工入库的成本（同月的按本月算，以前月份的按当时记下的）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { one, rows } from '../core/index.js';
import {
  completionOriginals,
  lateMovementsBefore,
  movementSource,
  reversalOriginals,
  type Mark,
  type Movement,
} from './costing-source.js';
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
 * 冲销送货、完工或到货单（flow_reversal）找原单据流水：
 * 原流水都在本月、且不晚于冲销 → same（送货、领料按负数出库冲回，到货与原入库成对抵消）；
 * 原出库都在以前月份、且当时的成本计算记下了成本 → 按记下的成本和对方科目冲回
 * （送货冲回主营业务成本，生产领料冲回生产成本）；
 * 其他情况查不到原成本，返回 null，要在“计算成本”窗口填金额并选对方科目。
 */
export function reversalOrigin(db: DatabaseSync, m: ReversalMovement, start: string): ReversalOrigin | null {
  if (m.source_id == null) return null;
  const originals = reversalOriginals(db, m.source_id, m.item_id);
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

/** 一条冲销流水按哪条路找到的原单据：completion 是冲销完工单扣回的成品，reversal 是其余（退回库存、冲销到货） */
export type ReversalLookup =
  | { kind: 'completion'; origin: CompletionOrigin | null }
  | { kind: 'reversal'; origin: ReversalOrigin | null };
/**
 * 冲销流水找原单据的唯一入口（计算成本和“计算成本”窗口要填什么都走这里）：成品出库（冲销完工单扣回）找原完工入库，
 * 其余找原单据流水。origin 为 null 的是系统查不到原成本、要人填金额或选对方科目的。
 */
export function originOf(db: DatabaseSync, m: ReversalMovement & Pick<Movement, 'kind'>, start: string): ReversalLookup {
  return m.kind === 'finished' && m.delta_units < 0
    ? { kind: 'completion', origin: completionOrigin(db, m, start) }
    : { kind: 'reversal', origin: reversalOrigin(db, m, start) };
}
