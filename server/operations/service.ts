import type { z } from 'zod';
import { RAW_UNIT, UNITS_PER_QUANTITY } from '../../shared/core/index.js';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, audit, inSavepoint, isSuperMode } from '../core/index.js';
import { supplierSchema, type MovementFilters, type movementSchema } from '../../shared/business/index.js';
import { MAX_STOCK_UNITS, quantityUnits, quantityString, today } from '../../shared/core/index.js';
import { OperationsRepository } from './ledger/repository.js';
import type { RecordIds } from './ledger/record-scope.js';
import { insertMovement, touchStockItems } from './ledger/ledger.js';
import { StockItems, type ItemEdit, type RawItem } from './stock/stock-items.js';
import { PurchaseWriter, type PurchaseEdit, type PurchaseSaveOptions } from './purchases/purchase-save.js';
import { businessActor, priorRecord } from './ledger/write-base.js';

/*
 * 采购库存的服务（别的模块只用它和 OrderBatchService）：读供应商、采购单、库存品、流水的基本视图（只有采购库存自己的数据），
 * 写供应商、手工出入库和盘点；库存品档案规则在 stock-items.ts，保存采购单在 purchase-save.ts，这里按原来的方法名转调。
 * 带单据内容的完整视图、要先问单据才能写的保存入口在单据流转（server/flow/stock-views.ts、stock-entries.ts）。
 */
export class OperationsService {
  private readonly repo: OperationsRepository;
  private readonly stock: StockItems;
  private readonly purchaseWriter: PurchaseWriter;
  constructor(readonly store: Store) {
    this.repo = new OperationsRepository(store);
    this.stock = new StockItems(store, this.repo);
    this.purchaseWriter = new PurchaseWriter(store, this.repo);
  }
  // 读：基本视图（repository.ts），列表按范围批量读
  suppliers(include = false, ids?: RecordIds) {
    return this.repo.suppliers(include, ids);
  }
  supplierName(id: number, include = false) {
    return this.repo.supplierName(id, include);
  }
  /** 采购单的基本视图；receivedOf 给了按它取每行已到货（单据流转现算的），不给读明细的缓存列 */
  purchases(include = false, ids?: RecordIds, supplierIds?: RecordIds, receivedOf?: (purchaseIds: number[]) => Map<number, number>) {
    return this.repo.purchases(include, ids, supplierIds, receivedOf);
  }
  items(include = false, ids?: RecordIds) {
    return this.repo.items(include, ids);
  }
  balance(id: number) {
    return this.repo.balance(id);
  }
  productStock(productId: number) {
    return this.repo.productStock(productId);
  }
  movements(query: MovementFilters = {}, page?: { offset?: number; limit?: number }) {
    return this.repo.movements(query, page);
  }
  movementPage(query: MovementFilters, page: number, pageSize: number) {
    return this.repo.movementPage(query, page, pageSize);
  }
  movementCount(query: MovementFilters = {}, extra: { inbound?: boolean; sourceKinds?: readonly string[] } = {}) {
    return this.repo.movementCount(query, extra);
  }
  movementItemIds(query: MovementFilters = {}) {
    return this.repo.movementItemIds(query);
  }
  movementRevisions(movementId: string) {
    return this.repo.movementRevisions(movementId);
  }
  /** 采购库存自己看得到的“用过”（有流水、被采购明细引用）；被单据引用的由单据流转补 */
  localUsages(ids: readonly number[]) {
    return this.stock.localUsages(ids);
  }
  saveSupplier(raw: unknown, who: Actor | null | undefined, id?: number) {
    const actor = businessActor(who),
      v = supplierSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      const before = id ? priorRecord((all) => this.repo.suppliers(all, id)[0], raw, actor) : null;
      const now = new Date().toISOString();
      let savedId: number;
      if (id) {
        this.store.db
          .prepare(
            'UPDATE suppliers SET name=?,contact=?,phone=?,address=?,notes=?,updated_at=?,version=version+1 WHERE id=?',
          )
          .run(v.name, v.contact, v.phone, v.address, v.notes, now, id);
        savedId = id;
      } else
        // 编号由数据库分配（AUTOINCREMENT，删掉的也不复用）
        savedId = Number(
          this.store.db
            .prepare('INSERT INTO suppliers(name,contact,phone,address,notes,version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
            .run(v.name, v.contact, v.phone, v.address, v.notes, now, now).lastInsertRowid,
        );
      const after = this.repo.suppliers(true, savedId)[0];
      audit(this.store, actor, {
        action: before ? 'update' : 'create',
        entity: 'suppliers',
        id: savedId,
        document: { before, after },
      });
      return after;
    });
  }
  // 库存品档案规则在 stock-items.ts，保存采购单在 purchase-save.ts；改已有的要单据流转的保存入口给 edit
  saveItem(raw: unknown, who: Actor | null | undefined, edit?: ItemEdit, origin?: { reason: string; document?: string }) {
    return this.stock.saveItem(raw, who, edit, origin);
  }
  finishedStockFor(productId: number, who: Actor | null | undefined, expected?: number | null, document?: string) {
    return this.stock.finishedStockFor(productId, who, expected, document);
  }
  rawStockFor(item: RawItem, who: Actor | null | undefined, document?: string) {
    return this.stock.rawStockFor(item, who, document);
  }
  rawStockMatch(item: RawItem) {
    return this.stock.rawStockMatch(item);
  }
  savePurchase(raw: unknown, who: Actor | null | undefined, edit?: PurchaseEdit, options: PurchaseSaveOptions = {}) {
    return this.purchaseWriter.savePurchase(raw, who, edit, options);
  }
  /**
   * 记一笔库存流水并更新库存品版本号、写审计（手工出入库用）。写流水本身在 ledger.ts。
   * 余额不能为负，超出可保存范围也拒绝。调用方负责外层事务。
   */
  private recordMovement(
    item: { id: number },
    delta: number,
    actor: Actor,
    source: { action: string; kind: string; orderId?: number | null; date: string; notes: string },
  ) {
    const before = this.repo.balance(item.id),
      after = before + delta;
    if (after < 0) throw new AppError('库存不足，不能出库为负数。', 409);
    if (!Number.isSafeInteger(after) || after > MAX_STOCK_UNITS)
      throw new AppError('库存数量超过可保存范围。');
    const id = insertMovement(this.store, {
      stockId: item.id,
      action: source.action,
      delta,
      before,
      after,
      sourceKind: source.kind,
      sourceId: null,
      purchaseLineId: null,
      orderId: source.orderId || null,
      date: source.date,
      notes: source.notes,
      actor,
    });
    touchStockItems(this.store, [item.id]);
    audit(this.store, actor, {
      action: source.action,
      entity: 'stock_items',
      id: item.id,
      document: {
        movementId: id,
        source,
        before: quantityString(before),
        after: quantityString(after),
        deltaUnits: delta,
      },
    });
    return id;
  }
  /**
   * 手工入库、出库、盘点：核对库存品、版本、关联订单、数量、日期，记一笔流水，回流水号。
   * 防重复提交和回给人的完整库存品在单据流转的入口（server/flow/stock-entries.ts 的 move），这里只在它的保存点里调。
   */
  move(id: number, v: z.output<typeof movementSchema>, who: Actor | null | undefined) {
    const actor = businessActor(who);
    const item = this.repo.items(false, id)[0];
    if (!item) throw new AppError('库存品不存在或已归档。', 404);
    if (item.version !== v.expectedVersion)
      throw new AppError('库存已变化，请刷新数量后重新确认。', 409);
    if (v.customerOrderId && !this.store.order(v.customerOrderId, isSuperMode(actor)))
      throw new AppError('关联订单不存在或已归档。');
    const qty = quantityUnits(v.quantity);
    if (v.action !== 'adjust' && qty <= 0) throw new AppError('出入库数量必须大于零。');
    if (v.date > today()) throw new AppError('业务日期不能晚于今天。');
    if (item.unit === RAW_UNIT && qty % UNITS_PER_QUANTITY) throw new AppError('纸板库存按整张登记，不能填写小数张。');
    const before = this.repo.balance(id),
      delta = v.action === 'adjust' ? qty - before : v.action === 'out' ? -qty : qty;
    return this.recordMovement(item, delta, actor, {
      action: v.action,
      kind: 'manual',
      date: v.date,
      notes: v.notes,
      orderId: v.customerOrderId,
    });
  }
}
