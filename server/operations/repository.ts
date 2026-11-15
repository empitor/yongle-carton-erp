import { z } from 'zod';
import type { Store } from '../core/index.js';
import { many, one, partyView, rows } from '../core/index.js';
import { stockKinds, type MovementFilters } from '../../shared/business/index.js';
import type { PurchaseRowView, PurchaseView, StockItemView, SupplierView } from '../../shared/business/index.js';
import { quantityString } from '../../shared/core/index.js';
import { arrivalSource } from './hooks.js';
import { MovementQueries } from './movements.js';
import { assemblePurchases, purchaseHeads, purchaseScope } from './purchase-rows.js';
import { noRecords, recordScope, type RecordIds } from './record-scope.js';
import { readStockDocument } from './stock-document.js';

const totalRow = z.object({ n: z.number() });
const stockTotalRow = z.object({ id: z.number(), n: z.number() });
const stockRow = rows.stock_items.extend({ kind: z.enum(stockKinds) });

/** 一个库存品的样子：库里的一行加上结余、已安排、在途（千分整数），archived 是否已归档 */
function stockItemView(
  r: z.output<typeof stockRow>,
  n: { balance: number; reserved: number; onOrder: number; archived: boolean },
): StockItemView {
  return {
    ...readStockDocument(r.document, r.id),
    id: r.id,
    name: r.name,
    kind: r.kind,
    unit: r.unit,
    productId: r.product_id,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    quantity: quantityString(n.balance),
    balanceUnits: n.balance,
    reservedUnits: n.reserved,
    reserved: quantityString(n.reserved),
    // 可用量只用于提示，可能因还没核对的单据超排而为负；实际扣减仍在确认时校验。
    availableUnits: n.balance - n.reserved,
    onOrderUnits: n.onOrder,
    onOrder: quantityString(n.onOrder),
    archived: n.archived,
  };
}

/** 采购库存的读取：供应商、采购单、库存品、库存流水。列表按范围批量读、批量组装，不逐条查。 */
export class OperationsRepository {
  private readonly moves: MovementQueries;
  constructor(readonly store: Store) {
    this.moves = new MovementQueries(store);
  }
  suppliers(include = false, ids?: RecordIds): SupplierView[] {
    if (noRecords(ids)) return [];
    const { predicate, params } = recordScope(ids);
    const history = this.purchaseHistory(ids);
    const archived = this.store.archivedIds('suppliers');
    return many(this.store.db, rows.suppliers, 'SELECT * FROM suppliers' + (predicate ? ' WHERE id ' + predicate : '') + ' ORDER BY id DESC', ...params)
      .filter((r) => include || !archived.has(r.id))
      .map((r) => ({
        ...partyView(r),
        archived: archived.has(r.id),
        purchaseHistory: history.get(r.id) || [],
      }));
  }
  /** 这几家供应商的采购历史（归档的采购单也算），按供应商分组 */
  private purchaseHistory(supplierIds: RecordIds) {
    const history = new Map<number, SupplierView['purchaseHistory']>();
    // 已到货和到货进度与采购单完整视图同一个口径（单据流转没加载时读明细的缓存列，见 purchaseRows）
    const arrivals = arrivalSource(false);
    for (const p of this.purchaseRows(true, undefined, supplierIds, arrivals ? (pids) => arrivals.purchases(this.store, pids).receivedUnits : undefined)) {
      const group = history.get(p.supplierId) || [];
      group.push({
        id: p.id,
        number: p.number,
        orderDate: p.orderDate,
        status: p.status,
        businessStatus: p.businessStatus,
        arrivalProgress: p.arrivalProgress,
      });
      history.set(p.supplierId, group);
    }
    return history;
  }
  /** 只需要确认供应商或取名称时不必加载全部采购历史。 */
  supplierName(id: number, include = false): string | undefined {
    if (!include && this.store.archived('suppliers', id)) return undefined;
    return one(this.store.db, rows.suppliers.pick({ name: true }), 'SELECT name FROM suppliers WHERE id=?', id)?.name;
  }
  /**
   * 采购单的完整视图：已到货按有效到货单现算，再补上到货单的信息（到货记录、待核对差异、有效到货金额），
   * 两样都由单据流转提供（hooks.ts 的 ArrivalSource.purchases）。主记录、明细和到货历史均按同一范围组装；列表仍批量读取。
   */
  purchases(include = false, ids?: RecordIds, supplierIds?: RecordIds): PurchaseView[] {
    const arrivals = arrivalSource();
    if (noRecords(ids)) return [];
    const scope = purchaseScope(ids, supplierIds),
      { heads, archived } = purchaseHeads(this.store, scope, include);
    const loaded = arrivals.purchases(this.store, heads.map((h) => h.id));
    return loaded.apply(assemblePurchases(this.store, { heads, scope, archived, received: loaded.receivedUnits }));
  }
  /**
   * 采购单本身：单头、明细、已到货和到货进度，不读单据流转的表。
   * receivedOf：按这批采购单的编号给出每条明细的已到货（千分整数）；不给时取明细的缓存列 received_units
   * （单据流转按有效到货单、退货维护，见 server/flow/receipt-events.ts 的 syncReceivedUnits）。
   */
  purchaseRows(
    include = false,
    ids?: RecordIds,
    supplierIds?: RecordIds,
    receivedOf?: (purchaseIds: number[]) => Map<number, number>,
  ): PurchaseRowView[] {
    if (noRecords(ids)) return [];
    const scope = purchaseScope(ids, supplierIds),
      { heads, archived } = purchaseHeads(this.store, scope, include);
    return assemblePurchases(this.store, { heads, scope, archived, received: receivedOf?.(heads.map((h) => h.id)) });
  }
  /** 这个产品的成品库存（一个产品只有一个，归档的也算），没有是 null */
  productStock(productId: number) {
    const row = one(this.store.db, rows.stock_items.pick({ id: true, name: true }), 'SELECT id,name FROM stock_items WHERE product_id=?', productId);
    return row ? { id: row.id, name: row.name, archived: this.store.archived('stock_items', row.id) } : null;
  }
  /** 一个库存品现在的结余（千分整数），由流水合计 */
  balance(id: number) {
    const row = one(this.store.db, totalRow, 'SELECT COALESCE(SUM(delta_units),0) AS n FROM stock_movements WHERE item_id=?', id);
    // 合计的查询总有一行
    if (!row) throw new Error('合计库存流水的查询没有返回行');
    return row.n;
  }
  /** 已安排：待送货的送货单和待入库的完工登记将要用掉、但尚未确认出库的数量（单据在单据流转，经 ArrivalSource 读）。 */
  private reservedUnits(ids: RecordIds) {
    return arrivalSource().reservedUnits(this.store, ids === undefined ? undefined : typeof ids === 'number' ? [ids] : ids);
  }
  /** 在途：已订货采购尚未到齐的数量。 */
  private onOrderUnits(ids: RecordIds) {
    const { predicate, params } = recordScope(ids);
    return new Map(
      many(
        this.store.db,
        stockTotalRow,
        "SELECT l.stock_item_id AS id,SUM(MAX(0,l.quantity_units-l.received_units)) AS n FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE p.status='已订货' AND l.stock_item_id IS NOT NULL AND p.id NOT IN (SELECT record_id FROM record_lifecycle WHERE entity='purchases')" +
          (predicate ? ' AND l.stock_item_id ' + predicate : '') + ' GROUP BY l.stock_item_id',
        ...params,
      ).map((r) => [r.id, r.n]),
    );
  }
  items(include = false, ids?: RecordIds): StockItemView[] {
    if (noRecords(ids)) return [];
    const { predicate, params } = recordScope(ids);
    const archived = this.store.archivedIds('stock_items'),
      balances = new Map(
        many(
          this.store.db,
          stockTotalRow,
          'SELECT item_id AS id,SUM(delta_units) AS n FROM stock_movements' + (predicate ? ' WHERE item_id ' + predicate : '') + ' GROUP BY item_id',
          ...params,
        ).map((r) => [r.id, r.n]),
      ),
      reserved = this.reservedUnits(ids),
      onOrder = this.onOrderUnits(ids);
    return many(this.store.db, stockRow, 'SELECT * FROM stock_items' + (predicate ? ' WHERE id ' + predicate : '') + ' ORDER BY id DESC', ...params)
      .filter((r) => include || !archived.has(r.id))
      .map((r) =>
        stockItemView(r, {
          balance: balances.get(r.id) || 0,
          reserved: reserved.get(r.id) || 0,
          onOrder: onOrder.get(r.id) || 0,
          archived: archived.has(r.id),
        }),
      );
  }
  // 库存流水的查询在 movements.ts，这里保留原来的调用方式
  movements(query: MovementFilters = {}, page?: { offset?: number; limit?: number }) {
    return this.moves.movements(query, page);
  }
  movementPage(query: MovementFilters, page: number, pageSize: number) {
    return this.moves.movementPage(query, page, pageSize);
  }
  movementCount(query: MovementFilters = {}, extra: { inbound?: boolean; sourceKinds?: readonly string[] } = {}) {
    return this.moves.movementCount(query, extra);
  }
  movementTotals(query: MovementFilters = {}) {
    return this.moves.movementTotals(query);
  }
  movementItemIds(query: MovementFilters = {}) {
    return this.moves.movementItemIds(query);
  }
  movementRevisions(movementId: string) {
    return this.moves.movementRevisions(movementId);
  }
}
