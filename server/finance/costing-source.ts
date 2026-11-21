/**
 * 成本计算自己的判断：哪些到货不计成本（撤销了又没记过账的）、到货流水按哪条财务事件计价、启用月要填期初成本的库存品。
 * 库存流水、库存品、冲销对应的原流水这些业务数据从只读窗口 financeFacts.stock 拿（server/flow/finance-facts/stock.ts）。
 * 流水来源的叫法（stock_movements.source_kind）按共用业务的 movementSourceKinds 核对。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { movementSourceKinds } from '../../shared/business/index.js';
import { many, one, rows } from '../core/index.js';
import { financeFacts } from '../flow/index.js';

/** 库存流水的来源（stock_movements.source_kind），成本计算按它分入库、出库、冲销 */
export const movementSource = {
  arrival: 'flow_arrival',
  delivery: 'flow_delivery',
  production: 'flow_production',
  reversal: 'flow_reversal',
  purchaseReturn: 'purchase_return',
  manual: 'manual',
} as const satisfies Record<string, (typeof movementSourceKinds)[number]>;

/**
 * 财务事件 e 的来源到货单撤销（更正）那天：已撤销的取冲回它库存的流水日期；更正出来的替代单还没记过账时
 * （更正带出来的那一次“有差异”）取原单冲回流水的日期，记过账以后再改的不算。没有的是 NULL。SQL 表达式。
 */
export const arrivalReversedOn = (e: string) =>
  `(SELECT max(r.date) FROM stock_movements r WHERE r.source_kind='${movementSource.reversal}' AND r.source_id IN (
    SELECT cast(u.id AS TEXT) FROM flow_documents u WHERE u.kind='arrival' AND u.status='reversed'
      AND (u.id=cast(${e}.source_id AS INTEGER) OR (u.replaced_by=cast(${e}.source_id AS INTEGER)
        AND NOT EXISTS(SELECT 1 FROM fin_events g WHERE g.source_kind='arrival' AND g.source_id=${e}.source_id
          AND g.status='generated')))))`;

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

/** 某次成本计算的时间点：那次计算的时间，和当时库存流水的最大行号。 */
export type Mark = { ranAt: string; maxRowid: number };

const costedStock = rows.fin_inventory_costs.pick({ stock_id: true });
/** start 以前还有结存（不算 exclude 的到货）、previous 月份没有算过成本的库存品（启用月要填期初成本的），原材料在前、按名称排 */
export function openingStocks(db: DatabaseSync, start: string, previous: string, exclude: readonly string[]) {
  const balances = financeFacts.stock.openingBalances(db, start, exclude);
  const costed = new Set(
    many(
      db,
      costedStock,
      'SELECT stock_id FROM fin_inventory_costs WHERE period=? AND stock_id IN (SELECT value FROM json_each(?))',
      previous,
      JSON.stringify(balances.map((b) => b.stockId)),
    ).map((r) => r.stock_id),
  );
  return balances.filter((b) => !costed.has(b.stockId));
}
