/**
 * 成本计算对到货的判断：哪些到货不计成本（撤销了又没记过账的）、到货流水按哪条财务事件计价。
 * 只读财务自己的表；“到货单已撤销”由调用方从只读窗口 financeFacts.stock.reversedArrivals 取好传进来。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { many, one, rows } from '../core/index.js';

const arrivalId = z.object({ id: z.string() });
/**
 * 不计成本的到货单编号：已撤销或被更正替代（窗口给的已撤销到货单）、又从没记过账的（没有已生成凭证的事件，
 * 也不是启用前的）。它们的入库和冲回在哪个月都不算（作为 exclude 交给窗口），期初数量按同一口径扣，所以跨月也对得上。
 * 启用前的到货不能排除：期初是人按当时的结存填的，排除了下个月的期初就和上月月末对不上。
 * reversed 是窗口给的已撤销到货单（financeFacts.stock.reversedArrivals）：成本计算里“到货单已撤销”只认这一份，
 * 同一次计算和 arrivalEvents 用同一份；不看观察记录，算成本不依赖补扫扫完，直接调服务、没补扫过时也和单据一致。
 */
export function unbookedVoidArrivals(db: DatabaseSync, reversed: readonly string[]) {
  return many(
    db,
    arrivalId,
    `SELECT j.value AS id FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM fin_events ve WHERE ve.source_kind='arrival'
      AND ve.source_id=j.value AND ve.status IN ('generated','before_opening'))`,
    JSON.stringify(reversed),
  ).map((r) => r.id);
}

const arrivalEventRow = rows.fin_events.pick({ id: true, snapshot: true, status: true });
/** 到货流水计价用的财务事件（已生成凭证的那条记过账的暂估在它的快照里） */
export type ArrivalEvent = z.output<typeof arrivalEventRow>;
/** 到货单最新那条已生成凭证的财务事件（记过账的暂估在它的快照里），没记过账是 undefined */
export function bookedArrivalEvent(db: DatabaseSync, arrivalId: string) {
  return one(
    db,
    arrivalEventRow,
    "SELECT id,snapshot,status FROM fin_events WHERE source_kind='arrival' AND source_id=? AND status='generated' ORDER BY id DESC LIMIT 1",
    arrivalId,
  );
}

const arrivalEventOf = arrivalEventRow.extend({ arrival: z.string() });
/**
 * 到货流水按哪条财务事件计价（到货单编号 → 事件），一批两句查完：单据有效时是观察到的那条（还没生成凭证的由成本计算拦下）；
 * 已撤销或被更正替代的（reversed，和 unbookedVoidArrivals 同一份），撤销后观察记录换成了新事件，按记过账的那条
 * （同 bookedArrivalEvent）。还没同步过的不在结果里。
 */
export function arrivalEvents(db: DatabaseSync, arrivalIds: readonly string[], reversed: readonly string[]) {
  const observed = many(
    db,
    arrivalEventOf,
    `SELECT x.source_id AS arrival,e.id,e.snapshot,e.status FROM json_each(?) j
      JOIN fin_source_observations x ON x.source_kind='arrival' AND x.source_id=j.value JOIN fin_events e ON e.id=x.event_id`,
    JSON.stringify([...new Set(arrivalIds)]),
  );
  const undone = new Set(reversed);
  const booked = new Map(
    many(
      db,
      arrivalEventOf,
      `SELECT j.value AS arrival,e.id,e.snapshot,e.status FROM json_each(?) j JOIN fin_events e ON e.id=(
        SELECT max(g.id) FROM fin_events g WHERE g.source_kind='arrival' AND g.source_id=j.value AND g.status='generated')`,
      JSON.stringify(observed.filter((o) => undone.has(o.arrival)).map((o) => o.arrival)),
    ).map(({ arrival, ...event }) => [arrival, event]),
  );
  const events = new Map<string, ArrivalEvent | undefined>();
  for (const { arrival, ...event } of observed) events.set(arrival, undone.has(arrival) ? booked.get(arrival) : event);
  return events;
}
