import { z } from 'zod';
import { type Store } from '../../core/index.js';
import { clampPage, count, many, parseStoredJson, rows } from '../../core/index.js';
import { formatStockSize, matchesMovement, movementColumnsSchema, movementSource, type MovementFilters } from '../../../shared/business/index.js';
import type { MovementBaseView, MovementRevision } from '../../../shared/business/index.js';
import { quantityString, stockKinds } from '../../../shared/core/index.js';
import { readStockDocument } from './stock-document.js';

/*
 * 库存流水的查询：列表（筛选、分页、关键词）、计数、汇总、修订记录。只读，写流水在 ledger.ts。
 * 流水类型的 SQL 写法和 shared/business/operations/movement-filters.ts 的 movementTypeOf 一一对应。
 */

const movementJoins =
  ' FROM stock_movements m JOIN stock_items s ON s.id=m.item_id LEFT JOIN purchase_lines pl ON pl.id=m.purchase_line_id LEFT JOIN purchases p ON p.id=pl.purchase_id LEFT JOIN orders o ON o.id=m.customer_order_id';
const movementSelect =
  'SELECT m.*,s.name AS itemName,s.kind,s.unit,p.number AS purchaseNumber,o.number AS customerOrderNumber' + movementJoins;
/** 整行流水：流水本身加上库存品的名称、种类、单位，关联的采购单号、订单号（没有是 null） */
const movementRow = rows.stock_movements.extend({
  itemName: rows.stock_items.shape.name,
  kind: z.enum(stockKinds),
  unit: rows.stock_items.shape.unit,
  purchaseNumber: z.string().nullable(),
  customerOrderNumber: z.string().nullable(),
});
type MovementRow = z.output<typeof movementRow>;
/** 汇总只要的两列：哪个库存品、数量变化 */
const totalRow = rows.stock_movements.pick({ item_id: true, delta_units: true });
/** 筛选和汇总要的几列，movementRowid 用来再取整行 */
const keyRow = totalRow.extend({ movementRowid: z.number(), source_kind: rows.stock_movements.shape.source_kind });
type MovementKey = z.output<typeof keyRow>;
/** 有关键词时，关键词匹配还要看的字段 */
const keywordRow = keyRow.extend({
  ...rows.stock_movements.pick({ action: true, date: true, notes: true, actor_name: true }).shape,
  ...movementRow.pick({ itemName: true, kind: true, purchaseNumber: true, customerOrderNumber: true }).shape,
});
const revisionCountRow = z.object({ movement_id: z.string(), n: z.number() });
const revisionRow = rows.stock_movement_revisions
  .pick({ at: true, reason: true })
  .extend({ actorName: z.string(), before: z.string(), after: z.string().nullable() });
/** 流水多于这么多条时，修订次数一次按全表数，不把这么多流水号列出来查 */
const COUNT_ALL_REVISIONS_FROM = 500;

/** 流水列表的顺序：业务日期最新在前，同一天按记录时间、写入顺序最新在前。 */
const movementOrder = ' ORDER BY m.date DESC,m.created_at DESC,m.rowid DESC';
/**
 * 流水类型（m 是流水，s 是库存品），与 shared/business/operations/movement-filters.ts 的 movementTypeOf 一一对应：
 * 有来源单据的按来源分，生产单再按库存品和方向分；没有来源单据的才按动作分。
 */
const movementTypeSql = `CASE
  WHEN m.source_kind='${movementSource.arrival}' THEN 'purchase'
  WHEN m.source_kind='${movementSource.production}' THEN CASE WHEN s.kind='finished' THEN 'production_output' WHEN m.delta_units<0 THEN 'production_issue' ELSE 'production_return' END
  WHEN m.source_kind='${movementSource.delivery}' THEN 'delivery'
  WHEN m.source_kind='${movementSource.purchaseReturn}' THEN CASE WHEN m.delta_units<0 THEN 'purchase_return' ELSE 'reversal' END
  WHEN m.source_kind='${movementSource.reversal}' THEN 'reversal'
  WHEN m.source_kind='${movementSource.maintenance}' THEN 'maintenance'
  WHEN m.action IN ('in','out','adjust','purchase') THEN m.action
  WHEN m.delta_units<0 THEN 'out'
  ELSE 'in'
END`;
/**
 * 流水筛选中能直接交给 SQL 的条件，判断规则与 matchesMovement 相同；关键词不在这里。
 * inbound / sourceKinds 供只要计数的调用方使用。
 */
function movementWhere(
  query: MovementFilters,
  extra: { inbound?: boolean; sourceKinds?: readonly string[] } = {},
) {
  const clauses: string[] = [],
    params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    clauses.push(sql);
    params.push(...values);
  };
  if (query.itemId) add('m.item_id=?', query.itemId);
  if (query.kind) add('s.kind=?', query.kind);
  if (query.action) add('(' + movementTypeSql + ')=?', query.action);
  if (query.start) add('m.date>=?', query.start);
  if (query.end) add('m.date<=?', query.end);
  if (extra.inbound) add('m.delta_units>=0');
  if (extra.sourceKinds) add('m.source_kind IN (SELECT value FROM json_each(?))', JSON.stringify(extra.sourceKinds));
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

/** 流水上显示的库存品规格、材质、楞型 */
type ItemDetail = { itemSpecification: string; material: string; flute: string };
type PresentedRow = { row: MovementRow; detail: ItemDetail };

export class MovementQueries {
  constructor(readonly store: Store) {}
  /** 一笔流水被管理员改写、删除的修订记录，新的在前 */
  movementRevisions(movementId: string): MovementRevision[] {
    const where = (column: string) => 'stock_movement_revisions.' + column + '（流水 ' + movementId + '）';
    return many(
      this.store.db,
      revisionRow,
      'SELECT at,actor_name AS actorName,reason,before_document AS before,after_document AS after FROM stock_movement_revisions WHERE movement_id=? ORDER BY id DESC',
      movementId,
    ).map((r) => ({
      ...r,
      before: parseStoredJson(movementColumnsSchema, r.before, where('before_document')),
      after: r.after ? parseStoredJson(movementColumnsSchema, r.after, where('after_document')) : null,
    }));
  }
  /** 库存品的规格、材质、楞型按库存品各解析一次，同一库存品的流水共用；返回按库存品编号取的函数。 */
  private itemDetails(itemIds: readonly number[]) {
    const details = new Map<number, ItemDetail>();
    if (itemIds.length)
      for (const r of many(
        this.store.db,
        rows.stock_items.pick({ id: true, document: true }),
        'SELECT id,document FROM stock_items WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(itemIds),
      )) {
        const document = readStockDocument(r.document, r.id);
        details.set(r.id, {
          itemSpecification: document.specification || formatStockSize(document),
          material: document.material,
          flute: document.flute,
        });
      }
    return (itemId: number) => {
      const detail = details.get(itemId);
      // 流水和库存品是联表查出来的，库存品一定在
      if (!detail) throw new Error('流水的库存品 ' + itemId + ' 没有读到');
      return detail;
    };
  }
  /** 这些流水各自的库存品资料 */
  private withDetails(found: MovementRow[]): PresentedRow[] {
    const detailOf = this.itemDetails([...new Set(found.map((r) => r.item_id))]);
    return found.map((row) => ({ row, detail: detailOf(row.item_id) }));
  }
  /**
   * 按筛选条件取整行流水，日期、库存品、类型、动作在 SQL 里筛；关键词要用库存品规格等派生字段，
   * 仍按 matchesMovement 匹配。没有关键词时分页也在 SQL 里做。
   */
  private movementRows(query: MovementFilters, page?: { offset?: number; limit?: number }) {
    const { where, params } = movementWhere(query);
    const offset = page?.offset ?? 0,
      limit = page?.limit,
      paged = !query.q && limit !== undefined;
    const found = many(
      this.store.db,
      movementRow,
      movementSelect + where + movementOrder + (paged ? ' LIMIT ? OFFSET ?' : ''),
      ...params,
      ...(paged ? [limit, offset] : []),
    );
    const matched = this.withDetails(found).filter(({ row, detail }) => !query.q || matchesMovement({ ...row, ...detail }, query));
    if (paged) return matched;
    return limit === undefined ? matched.slice(offset) : matched.slice(offset, offset + limit);
  }
  /**
   * 符合条件的流水只取筛选和汇总要用的列（不组装整行），顺序与列表相同（最新在前）。
   * 有关键词时取关键词匹配要看的字段，按 matchesMovement 匹配。
   */
  private movementKeys(query: MovementFilters): MovementKey[] {
    const { where, params } = movementWhere(query);
    const keys = 'SELECT m.rowid AS movementRowid,m.item_id,m.delta_units,m.source_kind';
    if (!query.q)
      return many(this.store.db, keyRow, keys + ' FROM stock_movements m JOIN stock_items s ON s.id=m.item_id' + where + movementOrder, ...params);
    const found = many(
      this.store.db,
      keywordRow,
      keys + ',m.action,m.date,m.notes,m.actor_name,s.name AS itemName,s.kind,p.number AS purchaseNumber,o.number AS customerOrderNumber' + movementJoins + where + movementOrder,
      ...params,
    );
    const detailOf = this.itemDetails([...new Set(found.map((r) => r.item_id))]);
    return found.filter((r) => matchesMovement({ ...r, ...detailOf(r.item_id) }, query));
  }
  /** 按 rowid 取整行流水，顺序与列表相同。 */
  private movementsByRowid(rowids: readonly number[]) {
    if (!rowids.length) return [];
    const found = many(this.store.db, movementRow, movementSelect + ' WHERE m.rowid IN (SELECT value FROM json_each(?))' + movementOrder, JSON.stringify(rowids));
    return this.presentMovements(this.withDetails(found));
  }
  /** 这些流水各被改写过几次；流水多时一次数全部修订记录 */
  private revisionCounts(movementIds: string[]) {
    const counted =
      movementIds.length > COUNT_ALL_REVISIONS_FROM
        ? many(this.store.db, revisionCountRow, 'SELECT movement_id,COUNT(*) AS n FROM stock_movement_revisions GROUP BY movement_id')
        : many(
            this.store.db,
            revisionCountRow,
            'SELECT movement_id,COUNT(*) AS n FROM stock_movement_revisions WHERE movement_id IN (SELECT value FROM json_each(?)) GROUP BY movement_id',
            JSON.stringify(movementIds),
          );
    return new Map(counted.map((r) => [r.movement_id, r.n]));
  }
  /** 补上修订次数和数量文字；修订次数只为这些流水查询。来源单据的单号由单据流转补（server/flow/stock-views.ts）。 */
  private presentMovements(found: PresentedRow[]): MovementBaseView[] {
    const revisions = this.revisionCounts(found.map(({ row }) => row.id));
    return found.map(({ row, detail }) => {
      return {
        ...row,
        revisionCount: revisions.get(row.id) || 0,
        ...detail,
        delta: quantityString(Math.abs(row.delta_units)),
        direction: row.delta_units < 0 ? '-' : '+',
        before: quantityString(row.before_units),
        after: quantityString(row.after_units),
      };
    });
  }
  /**
   * 库存流水列表（业务日期最新在前，同一天按记录时间）。page 只取其中一段，只组装这一段。
   * 结果与读出全部流水后按 matchesMovement 筛选、再截取的相同。
   */
  movements(query: MovementFilters = {}, page?: { offset?: number; limit?: number }) {
    if (query.q && page?.limit !== undefined) {
      const offset = page.offset ?? 0;
      return this.movementsByRowid(this.movementKeys(query).slice(offset, offset + page.limit).map((r) => r.movementRowid));
    }
    return this.presentMovements(this.movementRows(query, page));
  }
  /**
   * 带汇总的一页流水：全部符合条件的流水只取库存品和数量变化（汇总用），整行只组装这一页。
   * 页码超出范围时落到最后一页，与 pageRows 相同。
   */
  movementPage(query: MovementFilters, page: number, pageSize: number) {
    const keys = query.q ? this.movementKeys(query) : null,
      totals = keys ?? this.movementTotals(query);
    const current = clampPage(page, pageSize, totals.length),
      offset = (current - 1) * pageSize;
    return {
      totals,
      page: current,
      rows: keys
        ? this.movementsByRowid(keys.slice(offset, offset + pageSize).map((r) => r.movementRowid))
        : this.movements(query, { offset, limit: pageSize }),
    };
  }
  /**
   * 符合条件的流水条数，与 movements(query).length 相同。
   * inbound：只算数量不为负（“+”方向）的；sourceKinds：只算这些来源。
   */
  movementCount(query: MovementFilters = {}, extra: { inbound?: boolean; sourceKinds?: readonly string[] } = {}) {
    if (query.q)
      return this.movementKeys(query).filter(
        (row) => (!extra.inbound || row.delta_units >= 0) && (!extra.sourceKinds || extra.sourceKinds.includes(row.source_kind)),
      ).length;
    const { where, params } = movementWhere(query, extra);
    return count(this.store.db, 'SELECT COUNT(*) FROM stock_movements m JOIN stock_items s ON s.id=m.item_id' + where, ...params);
  }
  /** 符合条件的全部流水的库存品和数量变化，只用于汇总统计（不保证顺序）。 */
  movementTotals(query: MovementFilters = {}): z.output<typeof totalRow>[] {
    if (query.q) return this.movementKeys(query);
    const { where, params } = movementWhere(query);
    return many(this.store.db, totalRow, 'SELECT m.item_id,m.delta_units FROM stock_movements m JOIN stock_items s ON s.id=m.item_id' + where, ...params);
  }
  /** 有符合条件流水的库存品编号。 */
  movementItemIds(query: MovementFilters = {}) {
    if (query.q) return new Set(this.movementKeys(query).map((row) => row.item_id));
    const { where, params } = movementWhere(query);
    return new Set(
      many(this.store.db, totalRow.pick({ item_id: true }), 'SELECT DISTINCT m.item_id FROM stock_movements m JOIN stock_items s ON s.id=m.item_id' + where, ...params).map(
        (r) => r.item_id,
      ),
    );
  }
}
