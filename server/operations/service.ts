import { z } from 'zod';
import { RAW_UNIT, UNITS_PER_QUANTITY } from '../../shared/core/index.js';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, audit, inSavepoint, isSuperMode, onceByRequest, operationRequest } from '../core/index.js';
import { supplierSchema, movementSchema, stockItemViewSchema } from '../../shared/business/index.js';
import { MAX_STOCK_UNITS, quantityUnits, quantityString, today } from '../../shared/core/index.js';
import { OperationsRepository } from './repository.js';
import { insertMovement, touchStockItems } from './ledger.js';
import { StockItems, type RawItem } from './stock-items.js';
import { PurchaseWriter, type PurchaseSaveOptions } from './purchase-save.js';
import { businessActor, priorRecord } from './write-base.js';

/** 手工出入库的结果：流水号和出入库以后的库存品；同一请求号重发时按这份结构读回上次的结果 */
const movedResult = z.object({ movementId: z.string(), item: stockItemViewSchema });

/*
 * 采购库存的写入服务：供应商、手工出入库和盘点、防重复提交写在这里；库存品档案规则在 stock-items.ts，
 * 保存采购单在 purchase-save.ts，这里按原来的方法名转调（路由、单据流转、别的模块都通过 OperationsService 用）。
 */
export class OperationsService {
  readonly repo: OperationsRepository;
  private readonly items: StockItems;
  private readonly purchases: PurchaseWriter;
  constructor(readonly store: Store) {
    this.repo = new OperationsRepository(store);
    this.items = new StockItems(store);
    this.purchases = new PurchaseWriter(store);
  }
  saveSupplier(raw: unknown, who: Actor | null | undefined, id?: number) {
    const actor = businessActor(who),
      v = supplierSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      const before = priorRecord(this.repo, 'suppliers', id, raw, actor);
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
  // 库存品档案规则在 stock-items.ts，保存采购单在 purchase-save.ts，这里保留原来的调用方式
  saveItem(raw: unknown, who: Actor | null | undefined, id?: number, origin?: { reason: string; document?: string }) {
    return this.items.saveItem(raw, who, id, origin);
  }
  usage(id: number) {
    return this.items.usage(id);
  }
  usages(ids: readonly number[]) {
    return this.items.usages(ids);
  }
  finishedStockFor(productId: number, who: Actor | null | undefined, expected?: number | null, document?: string) {
    return this.items.finishedStockFor(productId, who, expected, document);
  }
  rawStockFor(item: RawItem, who: Actor | null | undefined, document?: string) {
    return this.items.rawStockFor(item, who, document);
  }
  rawStockMatch(item: RawItem) {
    return this.items.rawStockMatch(item);
  }
  savePurchase(raw: unknown, who: Actor | null | undefined, id?: number, options: PurchaseSaveOptions = {}) {
    return this.purchases.savePurchase(raw, who, id, options);
  }
  /**
   * 记一笔库存流水并更新库存品版本号、写审计（手工出入库、到货更正用）。写流水本身在 ledger.ts。
   * 余额不能为负，超出可保存范围也拒绝。调用方负责外层事务。
   */
  recordMovement(
    item: { id: number },
    delta: number,
    actor: Actor,
    source: {
      action: string;
      kind: string;
      id?: string;
      lineId?: number;
      orderId?: number | null;
      date: string;
      notes: string;
    },
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
      sourceId: source.id || null,
      purchaseLineId: source.lineId || null,
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

  move(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = businessActor(who),
      v = movementSchema.parse(raw);
    return onceByRequest(this.store, operationRequest('movement', v.requestId, actor, { id, ...v }), () => {
      const item = this.repo.items(false, id)[0];
      if (!item) throw new AppError('库存品不存在或已归档。', 404);
      if (item.version !== v.expectedVersion)
        throw new AppError('库存已变化，请刷新数量后重新确认。', 409);
      if (v.customerOrderId && !this.store.order(v.customerOrderId, isSuperMode(actor)))
        throw new AppError('关联客户订单不存在或已归档。');
      const qty = quantityUnits(v.quantity);
      if (v.action !== 'adjust' && qty <= 0) throw new AppError('出入库数量必须大于零。');
      if (v.date > today()) throw new AppError('业务日期不能晚于今天。');
      if (item.unit === RAW_UNIT && qty % UNITS_PER_QUANTITY) throw new AppError('纸板库存按整张登记，不能填写小数张。');
      const before = this.repo.balance(id),
        delta = v.action === 'adjust' ? qty - before : v.action === 'out' ? -qty : qty;
      const movementId = this.recordMovement(item, delta, actor, {
        action: v.action,
        kind: 'manual',
        date: v.date,
        notes: v.notes,
        orderId: v.customerOrderId,
      });
      return { movementId, item: this.repo.items(true, id)[0] };
    }, movedResult);
  }
}
