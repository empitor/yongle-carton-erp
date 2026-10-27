import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { audit, isSuperMode, requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import {
  supplierSchema,
  stockItemSchema,
  purchaseSchema,
  receiptSchema,
  movementSchema,
  quantityUnits,
  quantityString,
} from '../../shared/operations.js';
import { OperationsRepository } from './repository.js';
import { normalizedDimensions, normalizeDimensionUnit } from '../../shared/product-details.js';
import { flowReference } from '../flow/service.js';
import { isDeveloperActor } from '../developer-capability.js';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const dimensionsKey = (v: any) =>
  JSON.stringify([
    normalizedDimensions(v),
    normalizeDimensionUnit(v.dimensionUnit) ? 'known' : 'unknown',
  ]);
export class OperationsService {
  readonly repo: OperationsRepository;
  constructor(readonly store: Store) {
    this.repo = new OperationsRepository(store);
  }
  private tx<T>(job: () => T): T {
    this.store.db.exec('SAVEPOINT operation_write');
    try {
      const result = job();
      this.store.db.exec('RELEASE operation_write');
      return result;
    } catch (e) {
      this.store.db.exec('ROLLBACK TO operation_write; RELEASE operation_write');
      throw e;
    }
  }
  private actor(who: Actor | null | undefined) {
    return requirePermission(who, 'business:edit');
  }
  private prior(
    entity: 'suppliers' | 'purchases' | 'stock_items',
    id: number | undefined,
    raw: unknown,
    actor: Actor,
  ) {
    if (!id) return null;
    const row = this.store[entity](isSuperMode(actor)).find((r) => r.id === id);
    if (!row) throw new ImportError('记录不存在或已归档，编辑归档记录须进入超级管理员模式。', 404);
    const { version } = z.object({ version: z.number().int().positive() }).parse(raw);
    if (row.version !== version) throw new ImportError('记录已被修改，请刷新后重试。', 409);
    return row;
  }
  saveSupplier(raw: unknown, who: Actor | null | undefined, id?: number) {
    const actor = this.actor(who),
      v = supplierSchema.parse(raw);
    return this.tx(() => {
      const before = this.prior('suppliers', id, raw, actor);
      if (id)
        this.store.db
          .prepare(
            'UPDATE suppliers SET name=?,contact=?,phone=?,address=?,notes=?,version=version+1 WHERE id=?',
          )
          .run(v.name, v.contact, v.phone, v.address, v.notes, id);
      else {
        id = this.repo.nextId('suppliers');
        this.store.db
          .prepare('INSERT INTO suppliers VALUES(?,?,?,?,?,?,1,?)')
          .run(id, v.name, v.contact, v.phone, v.address, v.notes, new Date().toISOString());
      }
      const after = this.repo.suppliers(true).find((r) => r.id === id);
      audit(this.store, actor, 'business-ui', before ? 'update' : 'create', 'suppliers', id!, {
        before,
        after,
      });
      return after;
    });
  }
  saveItem(raw: unknown, who: Actor | null | undefined, id?: number) {
    const actor = this.actor(who),
      v = stockItemSchema.parse(raw);
    return this.tx(() => {
      const before = this.prior('stock_items', id, raw, actor);
      if (v.productId && !this.store.product(v.productId, isSuperMode(actor)))
        throw new ImportError('关联产品不存在或已停用。');
      if (v.productId && v.kind !== 'finished')
        throw new ImportError('只有成品库存可关联纸箱产品。');
      if (before) {
        const used = !!this.store.db
          .prepare(
            'SELECT 1 FROM stock_movements WHERE item_id=? UNION ALL SELECT 1 FROM purchase_lines WHERE stock_item_id=? LIMIT 1',
          )
          .get(id!, id!);
        const fields = ['kind', 'unit', 'material', 'flute', 'productId', 'specification'];
        if (
          used &&
          (dimensionsKey(before) !== dimensionsKey(v) ||
            fields.some((k) => JSON.stringify(before[k]) !== JSON.stringify((v as any)[k])))
        )
          throw new ImportError(
            '已有流水或采购引用，不能改动数量单位、实际规格、类别和产品关联；请新建库存品。等值mm/cm换算、名称和备注仍可编辑。',
          );
      }
      const { name, kind, unit, productId, ...document } = v;
      if (id)
        this.store.db
          .prepare(
            'UPDATE stock_items SET name=?,kind=?,unit=?,product_id=?,document=?,version=version+1 WHERE id=?',
          )
          .run(name, kind, unit, productId, JSON.stringify(document), id);
      else {
        id = this.repo.nextId('stock_items');
        this.store.db
          .prepare('INSERT INTO stock_items VALUES(?,?,?,?,?,?,1,?)')
          .run(id, name, kind, unit, JSON.stringify(document), productId, new Date().toISOString());
      }
      const after = this.repo.items(true).find((r) => r.id === id);
      audit(this.store, actor, 'business-ui', before ? 'update' : 'create', 'stock_items', id!, {
        before,
        after,
      });
      return after;
    });
  }
  savePurchase(raw: unknown, who: Actor | null | undefined, id?: number) {
    const actor = this.actor(who),
      v = purchaseSchema.parse(raw);
    return this.tx(() => {
      const before = this.prior('purchases', id, raw, actor);
      const supplier = this.repo
        .suppliers(isSuperMode(actor) || !!before)
        .find((r) => r.id === v.supplierId);
      if (!supplier) throw new ImportError('供应商不存在或已停用。');
      if (supplier.archived && !isSuperMode(actor) && before?.supplierId !== v.supplierId)
        throw new ImportError('供应商已停用，请选择正常供应商。');
      if (
        v.customerOrderId &&
        !this.store.order(
          v.customerOrderId,
          isSuperMode(actor) || before?.customerOrderId === v.customerOrderId,
        )
      )
        throw new ImportError('关联客户订单不存在或已归档。');
      for (const l of v.lines)
        if (l.stockItemId) {
          const item = this.repo.items(true).find((i) => i.id === l.stockItemId);
          const retaining =
            before?.lines.some(
              (old: any) => old.id === l.id && old.stockItemId === l.stockItemId,
            ) &&
            (before.receipts.length > 0 || v.status === '已取消');
          if (!item || (item.archived && !retaining) || item.kind !== 'raw')
            throw new ImportError('采购明细须关联正常原材料库存品。');
          if (item.unit !== l.unit)
            throw new ImportError(
              '采购数量单位必须与所选库存品一致，系统不会换算张、只或其他数量单位。',
            );
          if (
            dimensionsKey(item) !== dimensionsKey(l) ||
            (['material', 'flute', 'specification'] as const).some(
              (k) => JSON.stringify(item[k]) !== JSON.stringify(l[k]),
            )
          )
            throw new ImportError('明细规格与所选库存品不一致，请使用库存品规格或选择新建库存品。');
        }
      const hasReceipts =
        before && (before.receipts.length > 0 || flowReference(this.store, 'purchases', id!));
      const normalized = (l: any) => {
        const { id, stockItemId, quantity, unitPrice, ...meta } = l;
        return {
          stockItemId,
          quantity: quantityString(quantityUnits(quantity)),
          unitPrice,
          ...meta,
        };
      };
      if (hasReceipts) {
        if (isDeveloperActor(actor)) {
          if (
            v.supplierId !== before.supplierId ||
            v.lines.length !== before.lines.length ||
            v.lines.some((l) => {
              const old = before.lines.find((x: any) => x.id === l.id);
              return (
                !old ||
                old.stockItemId !== l.stockItemId ||
                old.unit !== l.unit ||
                dimensionsKey(old) !== dimensionsKey(l) ||
                ['material', 'flute', 'specification'].some(
                  (k) => (old as any)[k] !== (l as any)[k],
                ) ||
                quantityUnits(l.quantity) < old.receivedUnits
              );
            })
          )
            throw new ImportError(
              '已有到货：保留供应商、明细身份和实物规格，订货数量不能少于已收货数量。请先更正关联到货单。',
            );
        } else {
          if (
            v.orderDate !== before.orderDate ||
            v.supplierId !== before.supplierId ||
            v.lines.length !== before.lines.length ||
            v.lines.some(
              (l, i) =>
                l.id !== before.lines[i].id ||
                digest(normalized(l)) !==
                  digest(normalized(purchaseSchema.shape.lines.element.parse(before.lines[i]))),
            )
          )
            throw new ImportError(
              '已登记到货的采购单不能修改采购日期、供应商、明细、数量或价格；可编辑到货计划、客户订单关联、备注，或取消未到货部分。',
            );
          if (v.status === '待订货') throw new ImportError('已有到货，不能退回待订货状态。');
          if (before.status === '全部到货' && v.status === '已取消')
            throw new ImportError('已经全部到货，不能取消；库存不会因取消而回退。');
        }
      }
      const at = new Date().toISOString();
      if (id)
        this.store.db
          .prepare(
            'UPDATE purchases SET supplier_id=?,supplier_name=?,customer_order_id=?,order_date=?,expected_date=?,status=?,notes=?,version=version+1,updated_at=? WHERE id=?',
          )
          .run(
            v.supplierId,
            before.supplierId === v.supplierId ? before.supplierName : supplier.name,
            v.customerOrderId,
            v.orderDate,
            v.expectedDate,
            v.status,
            v.notes,
            at,
            id,
          );
      else {
        id = this.repo.nextId('purchases');
        this.store.db
          .prepare('INSERT INTO purchases VALUES(?,?,?,?,?,?,?,?,?,1,?,?)')
          .run(
            id,
            'CG-' + v.orderDate.replaceAll('-', '') + '-' + String(id).padStart(4, '0'),
            v.supplierId,
            supplier.name,
            v.customerOrderId,
            v.orderDate,
            v.expectedDate,
            v.status,
            v.notes,
            at,
            at,
          );
      }
      if (hasReceipts && isDeveloperActor(actor)) {
        for (const l of v.lines) {
          const { id: lineId, stockItemId, quantity, ...document } = l;
          this.store.db
            .prepare(
              'UPDATE purchase_lines SET document=?,quantity_units=? WHERE id=? AND purchase_id=?',
            )
            .run(JSON.stringify(document), quantityUnits(quantity), lineId!, id);
        }
      }
      if (!hasReceipts) {
        this.store.db.prepare('DELETE FROM purchase_lines WHERE purchase_id=?').run(id);
        for (const l of v.lines) {
          const { id: _, stockItemId, quantity, ...document } = l;
          this.store.db
            .prepare(
              'INSERT INTO purchase_lines(purchase_id,stock_item_id,document,quantity_units) VALUES(?,?,?,?)',
            )
            .run(id, stockItemId, JSON.stringify(document), quantityUnits(quantity));
        }
      }
      const after = this.repo.purchases(true).find((r) => r.id === id);
      audit(this.store, actor, 'business-ui', before ? 'update' : 'create', 'purchases', id!, {
        before,
        after,
      });
      return after;
    });
  }
  private replay(kind: string, requestId: string, input: unknown) {
    const r = this.store.db
      .prepare('SELECT digest,result FROM operation_requests WHERE kind=? AND request_id=?')
      .get(kind, requestId);
    if (!r) return null;
    if (r.digest !== digest(input))
      throw new ImportError('同一请求凭据已用于不同内容，请核对后重新打开操作窗口。', 409);
    return JSON.parse(String(r.result));
  }
  private remember(kind: string, requestId: string, input: unknown, result: unknown) {
    this.store.db
      .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
      .run(kind, requestId, digest(input), JSON.stringify(result));
  }
  private addMovement(
    item: any,
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
    if (after < 0) throw new ImportError('库存不足，不能出库为负数。', 409);
    if (!Number.isSafeInteger(after) || after > 999999999999)
      throw new ImportError('库存数量超过可保存范围。');
    const id = randomUUID(),
      at = new Date().toISOString();
    this.store.db
      .prepare('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        item.id,
        source.action,
        delta,
        before,
        after,
        source.kind,
        source.id || null,
        source.lineId || null,
        source.orderId || null,
        source.date,
        source.notes,
        actor.id,
        actor.name,
        at,
      );
    this.store.db.prepare('UPDATE stock_items SET version=version+1 WHERE id=?').run(item.id);
    audit(this.store, actor, 'warehouse', source.action, 'stock_items', item.id, {
      movementId: id,
      source,
      before: quantityString(before),
      after: quantityString(after),
      deltaUnits: delta,
    });
    return id;
  }
  receive(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = this.actor(who),
      v = receiptSchema.parse(raw),
      input = { id, ...v };
    return this.tx(() => {
      const prior = this.replay('receipt', v.requestId, input);
      if (prior) return prior;
      const purchase = this.repo.purchases().find((p) => p.id === id);
      if (!purchase) throw new ImportError('采购单不存在或已归档。', 404);
      if (purchase.version !== v.expectedVersion)
        throw new ImportError('采购单已更新，请重新核对到货数量。', 409);
      if (purchase.baseStatus !== '已订货')
        throw new ImportError('只有已订货且未取消的采购单可登记到货。');
      if (v.date < purchase.orderDate) throw new ImportError('到货日期不能早于采购日期。');
      if (
        this.store.db
          .prepare('SELECT 1 FROM flow_receipt_keys WHERE supplier_id=? AND reference=?')
          .get(purchase.supplierId, v.reference.trim().normalize('NFKC').toUpperCase())
      )
        throw new ImportError('此供应商送货单已通过采购到货管理登记，请勿重复入库。', 409);
      if (
        this.store.db
          .prepare('SELECT 1 FROM purchase_receipts WHERE purchase_id=? AND reference=?')
          .get(id, v.reference)
      )
        throw new ImportError('这张采购单的送货单号/到货批次已经登记，不能重复入库。', 409);
      if (new Set(v.items.map((i) => i.lineId)).size !== v.items.length)
        throw new ImportError('同一明细重复出现。');
      const receiptId = randomUUID(),
        movements: string[] = [];
      for (const received of v.items) {
        const line = purchase.lines.find((l: any) => l.id === received.lineId);
        if (!line) throw new ImportError('到货明细不属于当前采购单。');
        const qty = quantityUnits(received.quantity);
        if (line.receivedUnits + qty > line.quantityUnits)
          throw new ImportError('到货数量超过未到货数量，请先核对采购单。', 409);
        let item = line.stockItemId
          ? this.repo.items().find((i) => i.id === line.stockItemId)
          : null;
        if (line.stockItemId && !item) throw new ImportError('原材料库存品已归档，请先恢复。');
        if (!item) {
          item = this.saveItem({ ...line, kind: 'raw', productId: null }, actor);
          this.store.db
            .prepare('UPDATE purchase_lines SET stock_item_id=? WHERE id=?')
            .run(item.id, line.id);
        }
        if (item.kind !== 'raw' || item.unit !== line.unit)
          throw new ImportError('库存类别或数量单位不匹配。');
        movements.push(
          this.addMovement(item, qty, actor, {
            action: 'purchase',
            kind: 'purchase_receipt',
            id: receiptId,
            lineId: line.id,
            date: v.date,
            notes: v.notes || '采购到货：' + v.reference,
            orderId: purchase.customerOrderId,
          }),
        );
        this.store.db
          .prepare('UPDATE purchase_lines SET received_units=received_units+? WHERE id=?')
          .run(qty, line.id);
      }
      this.store.db
        .prepare('INSERT INTO purchase_receipts VALUES(?,?,?,?,?,?,?,?)')
        .run(
          receiptId,
          id,
          v.reference,
          v.date,
          JSON.stringify({ items: v.items, notes: v.notes, movements }),
          actor.id,
          actor.name,
          new Date().toISOString(),
        );
      this.store.db
        .prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      const result = {
        receiptId,
        purchase: this.repo.purchases(true).find((p) => p.id === id),
        movements,
      };
      this.remember('receipt', v.requestId, input, result);
      audit(this.store, actor, 'purchase-receipt', 'receive', 'purchases', id, {
        before: purchase,
        after: result.purchase,
        receiptId,
        reference: v.reference,
        movements,
      });
      return result;
    });
  }
  move(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = this.actor(who),
      v = movementSchema.parse(raw),
      input = { id, ...v };
    return this.tx(() => {
      const prior = this.replay('movement', v.requestId, input);
      if (prior) return prior;
      const item = this.repo.items().find((i) => i.id === id);
      if (!item) throw new ImportError('库存品不存在或已归档。', 404);
      if (item.version !== v.expectedVersion)
        throw new ImportError('库存已变化，请刷新数量后重新确认。', 409);
      if (v.customerOrderId && !this.store.order(v.customerOrderId, isSuperMode(actor)))
        throw new ImportError('关联客户订单不存在或已归档。');
      const qty = quantityUnits(v.quantity);
      if (v.action !== 'adjust' && qty <= 0) throw new ImportError('出入库数量必须大于零。');
      const before = this.repo.balance(id),
        delta = v.action === 'adjust' ? qty - before : v.action === 'out' ? -qty : qty;
      const movementId = this.addMovement(item, delta, actor, {
        action: v.action,
        kind: 'manual',
        date: v.date,
        notes: v.notes,
        orderId: v.customerOrderId,
      });
      const result = { movementId, item: this.repo.items(true).find((i) => i.id === id) };
      this.remember('movement', v.requestId, input, result);
      return result;
    });
  }
}
