/**
 * 窗口的库存一组：成本计算和毛利要的库存流水（带库存品、订单的客户）、库存品的结存、冲销对应的原流水、
 * 撤销冲回过的到货、已撤销的到货单、盘点流水编号、流水最大行号、成品送货出库量。
 * 到货“记没记过账”是财务的判断：财务算出不计成本的到货单编号（exclude），这里只按编号去掉它们的入库和冲回流水。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { flowEntityPrefix, flowStatus, movementSource, movementSourceKinds, stockKinds, type FlowKind } from '../../../shared/business/index.js';
import { count, many, rows } from '../../core/index.js';

/** SQL 里写的流水来源（stock_movements.source_kind）：只收 movementSourceKinds 里有的 */
const source = (kind: (typeof movementSourceKinds)[number]) => `'${kind}'`;
/** SQL 里比的单据种类（flow_documents.kind）：只收单据种类 */
const doc = (kind: FlowKind) => `'${kind}'`;

/** 一个登记时间点（财务记下的某次成本计算）：那时的时间和库存流水的最大行号 */
type Recorded = { ranAt: string; maxRowid: number };
type Clause = { sql: string; args: (string | number)[] };
/**
 * 这个时间点以前已经登记的流水（SQL 条件）。登记时间和行号两个都看：补登时手工写早了登记时间的、
 * 或者行号被重用的，只要有一个对不上就算之后才登记的。
 */
const recordedBy = (mark: Recorded, alias: string): Clause => ({
  sql: '(' + alias + '.created_at<=? AND ' + alias + '.rowid<=?)',
  args: [mark.ranAt, mark.maxRowid],
});
const everything: Clause = { sql: '1', args: [] };
const existedBy = (asOf: Recorded | undefined, alias: string) => (asOf ? recordedBy(asOf, alias) : everything);

/**
 * 不要的流水（SQL 条件，参数是 exclude 的 JSON）：到货单编号在 exclude 里的到货入库和冲回。
 * 写成不相关的 IN：列表只建一次，不随每条流水重扫；coalesce 让来源编号空着的流水（IN 得 NULL）留下。
 */
const excluded = (m: string) => `(${m}.source_kind IN (${source(movementSource.arrival)},${source(movementSource.reversal)})
  AND coalesce(${m}.source_id IN (SELECT value FROM json_each(?)),0))`;

const movement = rows.stock_movements.shape;
const item = rows.stock_items.shape;
/** 库存品的种类（原材料、成品），建表 CHECK 只收这两种 */
const stockKind = z.enum(stockKinds);

/** 一条库存流水，带库存品和订单资料（来源编号库里可能空着） */
const movementRow = z.object({
  id: movement.id,
  item_id: movement.item_id,
  delta_units: movement.delta_units,
  source_kind: movement.source_kind,
  source_id: movement.source_id,
  date: movement.date,
  customer_order_id: movement.customer_order_id,
  stock_name: item.name,
  kind: stockKind,
  unit: item.unit,
  product_id: item.product_id,
  customer_id: rows.orders.shape.customer_id.nullable(),
});
const movementColumns = `SELECT m.id,m.item_id,m.delta_units,m.source_kind,m.source_id,m.date,m.customer_order_id,
        s.name AS stock_name,s.kind,s.unit,s.product_id,o.customer_id
        FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id`;

/**
 * 流水（按日期、行号排）：日期段（含两头）或某日以前；after 只要那个时间点以后才登记的（跨期补登），
 * asOf 只要那个时间点以前登记的（结账检查）；exclude 的到货入库和冲回不要。
 */
function movements(
  db: DatabaseSync,
  q: { dates: { from: string; to: string } | { before: string }; after?: Recorded; asOf?: Recorded; exclude: readonly string[] },
) {
  const range: Clause =
    'before' in q.dates ? { sql: 'm.date<?', args: [q.dates.before] } : { sql: 'm.date BETWEEN ? AND ?', args: [q.dates.from, q.dates.to] };
  const later: Clause = q.after ? { sql: 'NOT ' + recordedBy(q.after, 'm').sql, args: recordedBy(q.after, 'm').args } : everything;
  const existed = existedBy(q.asOf, 'm');
  return many(
    db,
    movementRow,
    `${movementColumns}
        WHERE ${range.sql} AND ${later.sql} AND ${existed.sql} AND NOT ${excluded('m')} ORDER BY m.date,m.rowid`,
    ...range.args,
    ...later.args,
    ...existed.args,
    JSON.stringify(q.exclude),
  );
}

/** balancesBefore 一行：库存品，带 start 以前的结存数量 */
const stockWithQty = rows.stock_items.extend({ kind: stockKind, qty: z.number() });
/** end 以前有流水的库存品，带 start 以前的结存数量（qty，不算 exclude 的）。asOf 只算那个时间点以前登记的流水。 */
function balancesBefore(db: DatabaseSync, q: { start: string; end: string; asOf?: Recorded; exclude: readonly string[] }) {
  const existed = existedBy(q.asOf, 'x');
  return many(
    db,
    stockWithQty,
    `SELECT s.*,coalesce((SELECT sum(x.delta_units) FROM stock_movements x WHERE x.item_id=s.id AND x.date<?
          AND ${existed.sql} AND NOT ${excluded('x')}),0) AS qty
        FROM stock_items s WHERE EXISTS(SELECT 1 FROM stock_movements WHERE item_id=s.id AND date<=?)`,
    q.start,
    ...existed.args,
    JSON.stringify(q.exclude),
    q.end,
  );
}

/** start 以前结存不是 0 的一个库存品：编号、名称、单位、结存数量 */
const openingBalance = z.object({ stockId: item.id, name: item.name, unit: item.unit, quantity: z.number() });
/** start 以前结存不是 0 的库存品（不算 exclude 的），原材料在前、按名称排 */
function openingBalances(db: DatabaseSync, start: string, exclude: readonly string[]) {
  return many(
    db,
    openingBalance,
    `SELECT s.id AS stockId,s.name,s.unit,coalesce(sum(m.delta_units),0) AS quantity
        FROM stock_items s JOIN stock_movements m ON m.item_id=s.id AND m.date<? AND NOT ${excluded('m')}
        GROUP BY s.id HAVING quantity<>0 ORDER BY s.kind DESC,s.name`,
    start,
    JSON.stringify(exclude),
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
  name: item.name,
  unit: item.unit,
  kind: stockKind,
});
/**
 * 成本算不出来、要人填金额或选对方科目的流水：from 到 to 的，加上 ids（跨期补登），不算 exclude 的。
 * 完工、采购退货、到货入库、成品送货出库有原单据可算，不在这里。
 */
function manualMovements(db: DatabaseSync, q: { from: string; to: string; ids: readonly string[]; exclude: readonly string[] }) {
  return many(
    db,
    manualMovement,
    `SELECT m.id,m.item_id,m.source_id,m.date,m.delta_units AS quantity,m.source_kind,m.notes,s.name,s.unit,s.kind
        FROM stock_movements m JOIN stock_items s ON s.id=m.item_id
        WHERE (m.date BETWEEN ? AND ? OR m.id IN (SELECT value FROM json_each(?)))
        AND NOT ${excluded('m')}
        AND NOT (m.source_kind=${source(movementSource.production)})
        AND NOT (m.source_kind=${source(movementSource.purchaseReturn)})
        AND NOT (m.delta_units>0 AND m.source_kind=${source(movementSource.arrival)})
        AND NOT (m.delta_units<0 AND s.kind='finished' AND m.source_kind=${source(movementSource.delivery)})
        ORDER BY m.date,m.rowid`,
    q.from,
    q.to,
    JSON.stringify(q.ids),
    JSON.stringify(q.exclude),
  );
}

/** 一条冲销流水要找原流水的：原单据编号（冲销流水的来源编号）和库存品 */
type ReversalKey = { sourceId: string; itemId: number };
/** keys 里第 i 个的编号、库存品（json_each 的参数） */
const keyOn = (field: 'sourceId' | 'itemId') => `json_extract(j.value,'$.${field}')`;
/** 按 keys 的位置分开：第 i 个是 keys[i] 的那些行 */
function byKey<R extends { i: number }>(keys: readonly ReversalKey[], found: R[]): Omit<R, 'i'>[][] {
  const out = keys.map((): Omit<R, 'i'>[] => []);
  for (const { i, ...row } of found) out[i]?.push(row);
  return out;
}

/** 冲销对应的一笔原流水：流水几项、原单据种类（送货、完工、到货）、库存品种类和产品、订单的客户 */
const reversalOriginal = z.object({
  i: z.number(),
  id: movement.id,
  delta_units: movement.delta_units,
  date: movement.date,
  source_kind: movement.source_kind,
  customer_order_id: movement.customer_order_id,
  document_kind: rows.flow_documents.shape.kind,
  kind: stockKind,
  product_id: item.product_id,
  customer_id: rows.orders.shape.customer_id.nullable(),
});
/**
 * 冲销送货、完工或到货单（flow_reversal）对应的原单据流水，一批一次查完：同一张单据、同一个库存品，
 * 送货、完工找出库，到货找入库（原单据的流水来源是 flow_ 加单据种类，同 flowEntity）。第 i 个是 keys[i] 的，按日期、行号排。
 */
function reversalOriginals(db: DatabaseSync, keys: readonly ReversalKey[]) {
  const found = many(
    db,
    reversalOriginal,
    `SELECT j.key AS i,m.id,m.delta_units,m.date,m.source_kind,m.customer_order_id,f.kind AS document_kind,s.kind,s.product_id,o.customer_id
        FROM json_each(?) j JOIN flow_documents f ON f.id=cast(${keyOn('sourceId')} AS INTEGER)
        JOIN stock_movements m ON m.source_kind='${flowEntityPrefix}'||f.kind AND m.source_id=${keyOn('sourceId')} AND m.item_id=${keyOn('itemId')}
          AND ((f.kind IN (${doc('delivery')},${doc('production')}) AND m.delta_units<0) OR (f.kind=${doc('arrival')} AND m.delta_units>0))
        JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id
        ORDER BY j.key,m.date,m.rowid`,
    JSON.stringify(keys),
  );
  return byKey(keys, found);
}

const completionOriginal = rows.stock_movements.pick({ id: true, delta_units: true, date: true }).extend({ i: z.number() });
/** 冲销完工单扣回的成品（flow_reversal 出库）对应的原完工入库流水，一批一次查完。第 i 个是 keys[i] 的。 */
function completionOriginals(db: DatabaseSync, keys: readonly ReversalKey[]) {
  const found = many(
    db,
    completionOriginal,
    `SELECT j.key AS i,m.id,m.delta_units,m.date FROM json_each(?) j
        JOIN flow_documents f ON f.id=cast(${keyOn('sourceId')} AS INTEGER) AND f.kind=${doc('production')}
        JOIN stock_movements m ON m.source_kind=${source(movementSource.production)} AND m.source_id=${keyOn('sourceId')}
          AND m.item_id=${keyOn('itemId')} AND m.delta_units>0
        ORDER BY j.key,m.rowid`,
    JSON.stringify(keys),
  );
  return byKey(keys, found);
}

const undoneArrival = z.object({ source_id: z.string(), item_id: movement.item_id });
/**
 * 这些库存品上撤销或更正冲回过的到货（到货单编号、库存品）：到货单已撤销（被更正替代的也是），冲回流水不晚于 end，
 * 不算 exclude 的。asOf 只算那个时间点以前登记的流水（结账检查用）。
 */
function undoneArrivals(
  db: DatabaseSync,
  q: { stockIds: readonly number[]; end: string; asOf?: Recorded; exclude: readonly string[] },
) {
  const existed = existedBy(q.asOf, 'm');
  return many(
    db,
    undoneArrival,
    `SELECT DISTINCT m.source_id,m.item_id FROM stock_movements m
      WHERE m.source_kind=${source(movementSource.reversal)} AND m.source_id IS NOT NULL AND m.date<=?
      AND m.item_id IN (SELECT value FROM json_each(?)) AND ${existed.sql}
      AND EXISTS(SELECT 1 FROM flow_documents f WHERE f.id=cast(m.source_id AS INTEGER) AND f.kind=${doc('arrival')} AND f.status='${flowStatus.reversed}')
      AND NOT ${excluded('m')}`,
    q.end,
    JSON.stringify(q.stockIds),
    ...existed.args,
    JSON.stringify(q.exclude),
  );
}

const idRow = z.object({ id: z.string() });
/** 已撤销的到货单编号（被更正替代的原单也是已撤销），编号是文字，和流水的来源编号同一个写法 */
function reversedArrivals(db: DatabaseSync) {
  return many(db, idRow, `SELECT cast(id AS TEXT) AS id FROM flow_documents WHERE kind=${doc('arrival')} AND status='${flowStatus.reversed}'`).map(
    (r) => r.id,
  );
}

/** 日期不晚于 date 的盘点流水编号 */
function adjustIds(db: DatabaseSync, date: string) {
  return many(db, idRow, "SELECT id FROM stock_movements WHERE action='adjust' AND date<=?", date).map((r) => r.id);
}

/** 现在库存流水的最大行号：财务记进成本计算明细，以后才登记的流水按它认作跨期补登 */
function maxRowid(db: DatabaseSync) {
  return count(db, 'SELECT coalesce(max(rowid),0) FROM stock_movements');
}

/** 成品送货出库量一行：订单、订单的客户、库存品的产品，库存品、单位、出库数量（流水没挂订单、产品的是空） */
const deliveryOutflow = z.object({
  orderId: movement.customer_order_id,
  customerId: rows.orders.shape.customer_id.nullable(),
  productId: item.product_id,
  itemId: movement.item_id,
  unit: item.unit,
  quantity: z.number(),
});
/** period（YYYY-MM）这个月有效送货单的送货出库量，按订单、客户、产品、库存品合计 */
function deliveryOutflows(db: DatabaseSync, period: string) {
  return many(
    db,
    deliveryOutflow,
    `SELECT m.customer_order_id AS orderId,o.customer_id AS customerId,s.product_id AS productId,m.item_id AS itemId,s.unit,
        sum(-m.delta_units) AS quantity
      FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN orders o ON o.id=m.customer_order_id
      JOIN flow_documents f ON f.id=cast(m.source_id AS INTEGER) AND f.kind=${doc('delivery')} AND f.status='${flowStatus.confirmed}'
      WHERE m.source_kind=${source(movementSource.delivery)} AND m.delta_units<0 AND substr(m.date,1,7)=?
      GROUP BY m.customer_order_id,o.customer_id,s.product_id,m.item_id`,
    period,
  );
}

export const stock = {
  movements,
  balancesBefore,
  openingBalances,
  manualMovements,
  reversalOriginals,
  completionOriginals,
  undoneArrivals,
  reversedArrivals,
  adjustIds,
  maxRowid,
  deliveryOutflows,
};
