/**
 * 成本计算读库存数据的地方：库存流水、库存品、流水挂的订单，和冲销流水对应的原单据。
 *
 * 财务不调用业务代码，按表只读采购库存、单据流转的数据（tests/module-boundaries.test.ts 登记的例外），
 * 读这些表的 SQL 只放在这里和 business-source.ts。流水来源编码（stock_movements.source_kind）也只在这里写一次。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { stockKinds } from '../../shared/business/index.js';
import { count, many, rows } from '../core/index.js';

/** 库存流水的来源（stock_movements.source_kind），成本计算按它分入库、出库、冲销 */
export const movementSource = {
  arrival: 'flow_arrival',
  delivery: 'flow_delivery',
  production: 'flow_production',
  reversal: 'flow_reversal',
  purchaseReturn: 'purchase_return',
  manual: 'manual',
} as const;

const movement = rows.stock_movements.shape;
const stock = rows.stock_items.shape;
/** 库存品的种类（原材料、成品），建表 CHECK 只收这两种 */
const stockKind = z.enum(stockKinds);

/** 成本计算用的一条库存流水，带库存品和订单资料（来源编号库里可能空着） */
const movementRow = z.object({
  id: movement.id,
  item_id: movement.item_id,
  delta_units: movement.delta_units,
  source_kind: movement.source_kind,
  source_id: movement.source_id,
  date: movement.date,
  customer_order_id: movement.customer_order_id,
  stock_name: stock.name,
  kind: stockKind,
  unit: stock.unit,
  product_id: stock.product_id,
  customer_id: rows.orders.shape.customer_id.nullable(),
});
export type Movement = z.output<typeof movementRow>;

/** 某次成本计算的时间点：那次计算的时间，和当时库存流水的最大行号。 */
export type Mark = { ranAt: string; maxRowid: number };
/**
 * 这个时间点以前已经登记的流水（SQL 条件）。登记时间和行号两个都看：补登时手工写早了登记时间的、
 * 或者行号被重用的，只要有一个对不上就算之后才登记的。
 */
const recordedBy = (mark: Mark, alias: string): { sql: string; args: (string | number)[] } => ({
  sql: '(' + alias + '.created_at<=? AND ' + alias + '.rowid<=?)',
  args: [mark.ranAt, mark.maxRowid],
});
const everything: { sql: string; args: (string | number)[] } = { sql: '1', args: [] };

const movementColumns = `SELECT m.id,m.item_id,m.delta_units,m.source_kind,m.source_id,m.date,m.customer_order_id,
        s.name AS stock_name,s.kind,s.unit,s.product_id,o.customer_id
        FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id`;

/**
 * 跨期补登的流水：日期在 start 以前、prior 那次成本计算以后才登记的。asOf 只取那个时间点以前登记的（结账检查用）。
 */
export function lateMovementsBefore(db: DatabaseSync, start: string, prior: Mark, asOf?: Mark) {
  const after = recordedBy(prior, 'm');
  const existed = asOf ? recordedBy(asOf, 'm') : everything;
  return many(
    db,
    movementRow,
    `${movementColumns}
        WHERE m.date<? AND NOT ${after.sql} AND ${existed.sql} ORDER BY m.date,m.rowid`,
    start,
    ...after.args,
    ...existed.args,
  );
}

/** 一段日期里的流水（按日期、行号排）。asOf 只取那个时间点以前登记的。 */
export function movementsBetween(db: DatabaseSync, start: string, end: string, asOf?: Mark) {
  const existed = asOf ? recordedBy(asOf, 'm') : everything;
  return many(
    db,
    movementRow,
    `${movementColumns}
        WHERE m.date BETWEEN ? AND ? AND ${existed.sql} ORDER BY m.date,m.rowid`,
    start,
    end,
    ...existed.args,
  );
}

/** stocksBefore 一行：库存品，带 start 以前的结存数量 */
const stockWithQty = rows.stock_items.extend({ kind: stockKind, qty: z.number() });
/** end 以前有流水的库存品，带 start 以前的结存数量（qty）。asOf 只算那个时间点以前登记的流水。 */
export function stocksBefore(db: DatabaseSync, start: string, end: string, asOf?: Mark) {
  const existed = asOf ? recordedBy(asOf, 'x') : everything;
  return many(
    db,
    stockWithQty,
    `SELECT s.*,coalesce((SELECT sum(x.delta_units) FROM stock_movements x WHERE x.item_id=s.id AND x.date<?
          AND ${existed.sql}),0) AS qty
        FROM stock_items s WHERE EXISTS(SELECT 1 FROM stock_movements WHERE item_id=s.id AND date<=?)`,
    start,
    ...existed.args,
    end,
  );
}

/** 启用月要填期初成本的一个库存品：编号、名称、单位、start 以前的结存数量 */
const openingStock = z.object({ stockId: stock.id, name: stock.name, unit: stock.unit, quantity: z.number() });
/** start 以前还有结存、previous 月份没有算过成本的库存品（启用月要填期初成本的） */
export function openingStocks(db: DatabaseSync, start: string, previous: string) {
  return many(
    db,
    openingStock,
    `SELECT s.id AS stockId,s.name,s.unit,coalesce(sum(m.delta_units),0) AS quantity
        FROM stock_items s JOIN stock_movements m ON m.item_id=s.id AND m.date<?
        WHERE NOT EXISTS(SELECT 1 FROM fin_inventory_costs c WHERE c.period=? AND c.stock_id=s.id)
        GROUP BY s.id HAVING quantity<>0 ORDER BY s.kind DESC,s.name`,
    start,
    previous,
  );
}

/** 要人填金额或选对方科目的一笔流水：流水几项（数量是 delta_units）加库存品的名称、单位、种类 */
const manualMovement = z.object({
  id: movement.id,
  item_id: movement.item_id,
  source_id: movement.source_id,
  date: movement.date,
  quantity: movement.delta_units,
  source_kind: movement.source_kind,
  notes: movement.notes,
  name: stock.name,
  unit: stock.unit,
  kind: stockKind,
});
/**
 * 系统算不出成本、要人填金额或选对方科目的流水：start 到 end 的，加上 lateIds（跨期补登）。
 * 完工、采购退货、到货入库、成品送货出库由系统算，不在这里。
 */
export function manualMovements(db: DatabaseSync, start: string, end: string, lateIds: string[]) {
  return many(
    db,
    manualMovement,
    `SELECT m.id,m.item_id,m.source_id,m.date,m.delta_units AS quantity,m.source_kind,m.notes,s.name,s.unit,s.kind
        FROM stock_movements m JOIN stock_items s ON s.id=m.item_id
        WHERE (m.date BETWEEN ? AND ? OR m.id IN (SELECT value FROM json_each(?)))
        AND NOT (m.source_kind='flow_production')
        AND NOT (m.source_kind='purchase_return')
        AND NOT (m.delta_units>0 AND m.source_kind='flow_arrival')
        AND NOT (m.delta_units<0 AND s.kind='finished' AND m.source_kind='flow_delivery')
        ORDER BY m.date,m.rowid`,
    start,
    end,
    JSON.stringify(lateIds),
  );
}

/** 冲销对应的一笔原出库：流水几项、库存品种类和产品、订单的客户 */
const reversalOriginal = z.object({
  id: movement.id,
  delta_units: movement.delta_units,
  date: movement.date,
  source_kind: movement.source_kind,
  customer_order_id: movement.customer_order_id,
  kind: stockKind,
  product_id: stock.product_id,
  customer_id: rows.orders.shape.customer_id.nullable(),
});
/** 冲销送货、完工或到货单（flow_reversal）对应的原单据流水：同一张单据、同一个库存品 */
export function reversalOriginals(db: DatabaseSync, sourceId: string, itemId: number) {
  return many(
    db,
    reversalOriginal,
    `SELECT m.id,m.delta_units,m.date,m.source_kind,m.customer_order_id,s.kind,s.product_id,o.customer_id
        FROM flow_documents f JOIN stock_movements m ON m.source_kind='flow_'||f.kind AND m.source_id=?
          AND m.item_id=? AND ((f.kind IN ('delivery','production') AND m.delta_units<0) OR (f.kind='arrival' AND m.delta_units>0))
        JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id
        WHERE f.id=cast(? AS INTEGER) ORDER BY m.date,m.rowid`,
    sourceId,
    itemId,
    sourceId,
  );
}

const completionOriginal = rows.stock_movements.pick({ id: true, delta_units: true, date: true });
/** 冲销完工单扣回的成品（flow_reversal 出库）对应的原完工入库流水 */
export function completionOriginals(db: DatabaseSync, sourceId: string, itemId: number) {
  return many(
    db,
    completionOriginal,
    `SELECT m.id,m.delta_units,m.date FROM flow_documents f JOIN stock_movements m
          ON m.source_kind='flow_production' AND m.source_id=? AND m.item_id=? AND m.delta_units>0
        WHERE f.id=cast(? AS INTEGER) AND f.kind='production'`,
    sourceId,
    itemId,
    sourceId,
  );
}

/** 日期不晚于 ? 的盘点流水编号（子查询） */
export const adjustMovementIds = `SELECT id FROM stock_movements WHERE action='adjust' AND date<=?`;

/** 现在库存流水的最大行号：记进成本计算明细，以后才登记的流水按它认作跨期补登 */
export function maxMovementRowid(db: DatabaseSync) {
  return count(db, 'SELECT coalesce(max(rowid),0) FROM stock_movements');
}

/** 毛利还没算成本时的估算口径：按分组列出这个月成品送货出库的数量，和上个有成本的月份的期初加入库数量、金额 */
const marginGroupKeys = {
  order: 'm.customer_order_id',
  customer: 'o.customer_id',
  product: 's.product_id',
  month: 'substr(m.date,1,7)',
} as const;
/** 分组的值：订单、客户、产品编号，或月份（YYYY-MM）；流水没挂订单、产品的是空 */
const marginGroup = z.union([z.number(), z.string()]).nullable();
/** marginFacts 一行：分组、库存品、出库数量，上个有成本的月份的期初加入库数量和金额（没有成本是空） */
const marginFact = z.object({
  group_id: marginGroup,
  item_id: movement.item_id,
  quantity: z.number(),
  cost_quantity: z.number().nullable(),
  cost_amount: z.number().nullable(),
});
export function marginFacts(
  db: DatabaseSync,
  group: keyof typeof marginGroupKeys,
  period: string,
  selected: z.output<typeof marginGroup>[],
) {
  const key = marginGroupKeys[group];
  return many(
    db,
    marginFact,
    `SELECT ${key} AS group_id,m.item_id,sum(-m.delta_units) AS quantity,
      c.opening_qty+c.in_qty AS cost_quantity,c.opening_cents+c.in_cents AS cost_amount
      FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id
      JOIN flow_documents f ON f.id=cast(m.source_id AS INTEGER) AND f.kind='delivery' AND f.status='confirmed'
      LEFT JOIN fin_inventory_costs c ON c.stock_id=m.item_id AND c.unit=s.unit AND c.period=(
        SELECT max(prior.period) FROM fin_inventory_costs prior WHERE prior.stock_id=m.item_id AND prior.unit=s.unit AND prior.period<?)
      WHERE m.source_kind='flow_delivery' AND m.delta_units<0 AND substr(m.date,1,7)=?
      AND EXISTS(SELECT 1 FROM json_each(?) j WHERE j.value IS ${key}) GROUP BY group_id,m.item_id`,
    period,
    period,
    JSON.stringify(selected),
  );
}
