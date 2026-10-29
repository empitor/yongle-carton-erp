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
  receiptCorrectionPreviewSchema,
  receiptCorrectionSchema,
  sumMoney,
} from '../../shared/operations.js';
import { receiptEvents, syncReceivedUnits } from './fulfillment.js';
import { purchaseLineAmount, sheetArea } from '../../shared/physical-flow.js';
import { fulfillmentSummary, arrivalLineStatus } from '../../shared/fulfillment.js';
import { today } from '../../shared/domain.js';
import { OperationsRepository } from './repository.js';
import { normalizedDimensions, normalizeDimensionUnit } from '../../shared/product-details.js';
import { flowReference, FlowService } from '../flow/service.js';
import { isDeveloperActor, isLocalAdministrator, requireLocalAdministrator } from '../developer-capability.js';
import { DatabaseMaintenanceService } from '../business/database-maintenance.js';
import { arrivalQuantities } from '../../shared/arrival.js';
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
          !isLocalAdministrator(actor) &&
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
      if (before && isLocalAdministrator(actor))
        new DatabaseMaintenanceService(this.store).alignStock(before, after, actor);
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
          if (
            !item ||
            (item.archived && !retaining && !isLocalAdministrator(actor)) ||
            item.kind !== 'raw'
          )
            throw new ImportError('采购明细须关联正常原材料库存品。');
          if (!isLocalAdministrator(actor) && item.unit !== l.unit)
            throw new ImportError(
              '采购数量单位必须与所选库存品一致，系统不会换算张、只或其他数量单位。',
            );
          if (
            dimensionsKey(item) !== dimensionsKey(l) ||
            (['material', 'flute', 'specification'] as const).some(
              (k) => JSON.stringify(item[k]) !== JSON.stringify(l[k]),
            )
          )
            if (isLocalAdministrator(actor)) l.stockItemId = null;
            else
              throw new ImportError(
                '明细规格与所选库存品不一致，请使用库存品规格或选择新建库存品。',
              );
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
      if (hasReceipts && !isLocalAdministrator(actor)) {
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
      if (id && isLocalAdministrator(actor) && before) {
        const changed = before.lines
          .filter((old: any) => {
            const next = v.lines.find((l) => l.id === old.id);
            return (
              !next ||
              v.supplierId !== before.supplierId ||
              old.stockItemId !== next.stockItemId ||
              old.unit !== next.unit ||
              dimensionsKey(old) !== dimensionsKey(next) ||
              ['material', 'flute', 'specification'].some(
                (k) => (old as any)[k] !== (next as any)[k],
              )
            );
          })
          .map((l: any) => l.id);
        new DatabaseMaintenanceService(this.store).detachPurchaseLines(id, changed, actor);
        for (const old of before.lines)
          if (!v.lines.some((l) => l.id === old.id))
            this.store.db
              .prepare('DELETE FROM purchase_lines WHERE id=? AND purchase_id=?')
              .run(old.id, id);
        for (const l of v.lines) {
          const { id: lineId, stockItemId, quantity, ...document } = l;
          if (lineId) {
            if (!before.lines.some((old: any) => old.id === lineId))
              throw new ImportError('明细编号不属于当前采购。');
            this.store.db
              .prepare(
                'UPDATE purchase_lines SET stock_item_id=?,document=?,quantity_units=? WHERE id=? AND purchase_id=?',
              )
              .run(stockItemId, JSON.stringify(document), quantityUnits(quantity), lineId, id);
          } else
            this.store.db
              .prepare(
                'INSERT INTO purchase_lines(purchase_id,stock_item_id,document,quantity_units) VALUES(?,?,?,?)',
              )
              .run(id, stockItemId, JSON.stringify(document), quantityUnits(quantity));
        }
      } else if (hasReceipts && isDeveloperActor(actor)) {
        for (const l of v.lines) {
          const { id: lineId, stockItemId, quantity, ...document } = l;
          this.store.db
            .prepare(
              'UPDATE purchase_lines SET document=?,quantity_units=? WHERE id=? AND purchase_id=?',
            )
            .run(JSON.stringify(document), quantityUnits(quantity), lineId!, id);
        }
      }
      if (!hasReceipts && !(before && isLocalAdministrator(actor))) {
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
  previewReceiptCorrection(
    purchaseId: number,
    receiptId: string,
    raw: unknown,
    who: Actor | null | undefined,
  ) {
    this.actor(who);
    const input = receiptCorrectionPreviewSchema.parse(raw);
    if (input.mode === 'data-edit') requireLocalAdministrator(who);
    const events = receiptEvents(this.store);
    // 兼容旧接口返回的 flow-ID-purchaseID 投影身份。
    const mirror = this.store.db
      .prepare('SELECT document FROM purchase_receipts WHERE id=? AND purchase_id=?')
      .get(receiptId, purchaseId);
    const flowId = mirror ? JSON.parse(String(mirror.document)).flowId : null;
    const original = events.find((e) => e.id === receiptId || (flowId && e.flowId === flowId));
    const purchases = this.repo.purchases(true),
      purchase = purchases.find((p) => p.id === purchaseId);
    if (
      !purchase ||
      !original ||
      !(
        original.purchaseId === purchaseId ||
        original.lines.some((l) => l.purchaseId === purchaseId)
      )
    )
      throw new ImportError('到货记录不属于这张采购单。', 404);
    if (!original.effective || original.status !== 'confirmed')
      throw new ImportError(
        '只能更正有效的已确认到货；草稿请编辑，已冲销记录请打开最新替代记录。',
        409,
      );
    if (original.missingFlow)
      throw new ImportError('关联的正式到货单缺失，采购到货凭据已保留。请先核对历史关联，不能自动重建或再次入库。', 409);
    if (
      original.version !== input.expectedVersion ||
      purchase.version !== input.expectedPurchaseVersion
    )
      throw new ImportError('到货单或采购单版本已改变，请刷新后重新核对。', 409);
    if (new Set(input.items.map((i) => i.index)).size !== input.items.length)
      throw new ImportError('更正明细重复。');
    const lines = original.lines.map((l) => ({ ...l }));
    for (const change of input.items) {
      const line = lines[change.index];
      if (!line || line.lineId !== change.lineId)
        throw new ImportError('更正明细身份不匹配。', 409);
      if (line.item.unit === '张' && quantityUnits(change.quantity) % 1000)
        throw new ImportError('纸板到货使用整张数量，不能填写小数张。');
      const quantityChanged = quantityUnits(change.quantity) !== quantityUnits(line.quantity);
      const explicitInspection = ['acceptedQuantity', 'rejectedQuantity', 'stockedQuantity'].some((k) => (change as any)[k] !== undefined);
      if (input.mode === 'data-edit' && explicitInspection) throw new ImportError('管理员统计编辑不修改实物验收或实际入库数量。');
      const statisticalEdit = line.quantity !== line.recordedQuantity;
      if (input.mode === 'business' && (quantityChanged || explicitInspection || statisticalEdit)) {
        const mixed = (line.rejectedQuantity != null && quantityUnits(line.rejectedQuantity) > 0) || (line.stockedQuantity != null && quantityUnits(line.stockedQuantity) !== quantityUnits(line.recordedQuantity!));
        if (mixed && (quantityChanged || statisticalEdit) && !explicitInspection) throw new ImportError('原批次含不合格或未入库数量，请同时明确正确的验收合格、不合格和实际入库数量。');
        if (explicitInspection) {
          try { Object.assign(line, arrivalQuantities({ ...line, ...change })); } catch (e) { throw new ImportError((e as Error).message); }
        } else {
          line.stockedQuantity = quantityString(quantityUnits(change.quantity));
          if (line.acceptedQuantity != null) { line.acceptedQuantity = line.stockedQuantity; line.rejectedQuantity = '0'; }
        }
      }
      line.quantity = quantityString(quantityUnits(change.quantity));
      line.amount = purchaseLineAmount({
        ...line.item,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        priceBasis: line.priceBasis,
      });
    }
    if (
      lines.every((l, i) => ['quantity', 'acceptedQuantity', 'rejectedQuantity', 'stockedQuantity'].every((k) => (l as any)[k] === (original.lines[i] as any)[k])) &&
      (input.mode === 'data-edit' || !original.discrepancies?.length)
    )
      throw new ImportError('更正数量与原登记相同，无需提交。');
    const stock = this.repo.items(true),
      stockDeltas = new Map<number, number>();
    for (const [index, l] of lines.entries()) {
      const it = stock.find((s) => s.id === l.stockId);
      if (!it || it.kind !== 'raw' || it.unit !== l.item.unit)
        throw new ImportError('原到货的库存关联或数量单位已变化，请先核对关联记录。', 409);
      const delta = quantityUnits(l.quantity) - quantityUnits(original.lines[index].quantity);
      const physicalDelta = quantityUnits(l.stockedQuantity ?? l.quantity) - quantityUnits(original.lines[index].stockedQuantity ?? original.lines[index].recordedQuantity!);
      stockDeltas.set(it.id, (stockDeltas.get(it.id) || 0) + (input.mode === 'data-edit' ? 0 : physicalDelta));
      if (l.lineId) {
        const p = purchases.find((p) => p.id === l.purchaseId),
          pl = p?.lines.find((x: any) => x.id === l.lineId);
        if (
          !pl ||
          pl.stockItemId !== l.stockId ||
          pl.unit !== it.unit ||
          p.supplierId !== original.supplierId
        )
          throw new ImportError('原采购明细或库存身份已变化，不能自动更正。', 409);
        // 允许减少历史超收量，但不借更正新增超收。
        if (delta > 0 && pl.receivedUnits + delta > pl.quantityUnits)
          throw new ImportError('更正后累计到货超过采购订购数量。', 409);
      }
    }
    const movements = this.store.db
      .prepare('SELECT * FROM stock_movements WHERE source_kind=? AND source_id=?')
      .all(
        original.source === 'flow' ? 'flow_arrival' : 'purchase_receipt',
        original.flowId ? String(original.flowId) : original.id,
      );
    const expected = new Map<number, number>(),
      actual = new Map<number, number>();
    for (const l of original.lines)
      expected.set(l.stockId!, (expected.get(l.stockId!) || 0) + quantityUnits(l.stockedQuantity ?? l.recordedQuantity!));
    for (const m of movements)
      actual.set(Number(m.item_id), (actual.get(Number(m.item_id)) || 0) + Number(m.delta_units));
    if (
      [...new Set([...expected.keys(), ...actual.keys()])].some(
        (id) => (expected.get(id) || 0) !== (actual.get(id) || 0),
      )
    )
      throw new ImportError('原到货与入库流水数量不一致，需先核对历史记录，未执行更正。', 409);
    const stockImpact = [...stockDeltas].map(([id, deltaUnits]) => {
      const it = stock.find((s) => s.id === id)!;
      const afterUnits = it.balanceUnits + deltaUnits;
      if (afterUnits < 0)
        throw new ImportError(
          it.name +
            '库存不足：现有' +
            it.quantity +
            it.unit +
            '，本次需扣减' +
            quantityString(-deltaUnits) +
            it.unit +
            '。原材料已被后续领料或出库使用，请先处理关联业务。',
          409,
        );
      if (!Number.isSafeInteger(afterUnits) || afterUnits > 999999999999)
        throw new ImportError('更正后库存数量超限。');
      return {
        stockId: id,
        name: it.name,
        unit: it.unit,
        version: it.version,
        deltaUnits,
        delta: (deltaUnits < 0 ? '-' : '+') + quantityString(Math.abs(deltaUnits)),
        before: it.quantity,
        after: quantityString(afterUnits),
      };
    });
    const affectedIds = [
      ...new Set(lines.map((l) => l.purchaseId).filter((id): id is number => id !== null)),
    ];
    const purchaseImpact = affectedIds.map((id) => {
      const p = purchases.find((p) => p.id === id)!;
      const changedLines = p.lines.map((pl: any) => {
        const delta = lines.reduce(
          (n, l, i) =>
            n +
            (l.lineId === pl.id
              ? quantityUnits(l.quantity) - quantityUnits(original.lines[i].quantity)
              : 0),
          0,
        );
        const after = pl.receivedUnits + delta;
        return {
          lineId: pl.id,
          name: pl.name,
          unit: pl.unit,
          ordered: pl.quantity,
          before: pl.receivedQuantity,
          after: quantityString(after),
          remaining: quantityString(Math.max(0, pl.quantityUnits - after)),
          arrivalStatus: arrivalLineStatus(pl.quantityUnits, after),
        };
      });
      const summary = fulfillmentSummary(
        changedLines.map((l: any) => l.arrivalStatus),
        '已到齐',
        '部分到货',
        '未到货',
      );
      return {
        id,
        number: p.number,
        version: p.version,
        businessStatus: p.businessStatus,
        lines: changedLines,
        arrivalProgress: summary.progress === '已到齐' ? '全部到货' : summary.progress,
      };
    });
    if (original.source === 'flow') {
      const key = this.store.db
        .prepare('SELECT document_id FROM flow_receipt_keys WHERE supplier_id=? AND reference=?')
        .get(original.supplierId, original.reference.trim().normalize('NFKC').toUpperCase());
      if (key && Number(key.document_id) !== original.flowId)
        throw new ImportError('原批次已关联其他到货单，请刷新核对。', 409);
    }
    const beforeAmount = sumMoney(original.lines.map((l) => l.amount)),
      afterAmount = sumMoney(lines.map((l) => l.amount));
    const snapshot = {
      original,
      input,
      purchaseVersion: purchase.version,
      purchaseVersions: purchaseImpact.map((p) => [p.id, p.version]),
      stockImpact,
    };
    return {
      mode: input.mode,
      receiptId: original.id,
      original,
      lines,
      stockImpact,
      purchaseImpact,
      beforeAmount,
      afterAmount,
      discrepancies: input.mode === 'data-edit' ? lines.filter((l) => l.quantity !== l.recordedQuantity).map((l) => ({
        index: l.index, lineId: l.lineId, purchaseId: l.purchaseId, stockId: l.stockId,
        name: l.item.name, unit: l.item.unit, recordedQuantity: l.recordedQuantity, effectiveQuantity: l.quantity,
        differenceUnits: quantityUnits(l.recordedQuantity!) - quantityUnits(l.quantity), status: '待核对差异',
      })) : [],
      previewDigest: digest(snapshot),
    };
  }
  correctReceipt(
    purchaseId: number,
    receiptId: string,
    raw: unknown,
    who: Actor | null | undefined,
  ) {
    const actor = this.actor(who),
      input = receiptCorrectionSchema.parse(raw);
    return this.tx(() => {
      const request = { actorId: actor.id, purchaseId, receiptId, ...input };
      const prior = this.replay('receipt-correction', input.requestId, request);
      if (prior) return { ...prior, replayed: true };
      const { requestId, previewDigest, ...previewInput } = input;
      const plan = this.previewReceiptCorrection(purchaseId, receiptId, previewInput, actor);
      if (plan.previewDigest !== previewDigest)
        throw new ImportError('到货、采购或库存已变化，请重新核对更正影响。', 409);
      const old = plan.original,
        at = new Date().toISOString(),
        date = today();
      if (input.mode === 'data-edit') {
        requireLocalAdministrator(actor);
        audit(this.store, actor, 'administrator-data-edit', 'receipt-data-edit', 'purchases', purchaseId, {
          receiptId: old.id, requestId, reason: input.reason, mode: input.mode,
          items: plan.lines.map((l) => ({ index: l.index, lineId: l.lineId, quantity: l.quantity })),
          before: old.lines, after: plan.lines, discrepancies: plan.discrepancies,
        });
        syncReceivedUnits(this.store);
        for (const p of plan.purchaseImpact) this.store.db.prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?').run(at, p.id);
        const purchases = this.repo.purchases(true).filter((p) => plan.purchaseImpact.some((i) => i.id === p.id));
        const stock = this.repo.items(true).filter((s) => plan.stockImpact.some((i) => i.stockId === s.id));
        if (plan.purchaseImpact.some((p) => p.lines.some((l: any) => purchases.find((x) => x.id === p.id)?.lines.find((x: any) => x.id === l.lineId)?.receivedQuantity !== l.after)) ||
          plan.stockImpact.some((s) => stock.find((x) => x.id === s.stockId)?.quantity !== s.before))
          throw new ImportError('数据纠偏读回核验失败，事务已回滚。', 409);
        const result = { mode: input.mode, originalReceiptId: old.id, replacementReceiptId: old.id, requestId,
          purchases, stock, stockImpact: plan.stockImpact, discrepancies: plan.discrepancies, movements: { reversal: [], replacement: [] }, verified: true,
          summary: '已仅编辑历史到货统计，库存未调整。' + plan.purchaseImpact.map((p) => p.number + '：' + p.lines.map((l: any) => l.name + '有效到货' + l.after + l.unit + '，待到货' + l.remaining + l.unit).join('；')).join('；') + (plan.discrepancies.length ? '。与原入库流水存在待核对差异，已登记。' : '。与原入库数量一致。'),
        };
        this.remember('receipt-correction', requestId, request, result);
        return result;
      }
      const replacements: string[] = [],
        reversals: string[] = [];
      let replacementId: string,
        replacementFlowId: number | null = null;
      {
        const nextLines = plan.lines.map((l, i) => ({
          ...(old.document.lines?.[i] || { stockId: l.stockId, purchaseLineId: l.lineId, item: l.item, unitPrice: l.unitPrice, priceBasis: l.priceBasis }),
          quantity: l.quantity,
          acceptedQuantity: l.acceptedQuantity,
          rejectedQuantity: l.rejectedQuantity,
          stockedQuantity: l.stockedQuantity ?? l.quantity,
          area: sheetArea(l.item, l.quantity),
          amount: l.amount,
          differenceReason: input.reason,
        }));
        const next = {
          ...old.document,
          supplierId: old.supplierId, reference: old.reference, date: old.date, isPlan: false,
          lines: nextLines,
          correctionOf: old.flowId,
          correctionOfReceiptId: old.id,
          correctionReason: input.reason,
          correctedAt: at,
          confirmedBy: actor.name,
          confirmedAt: at,
        };
        // 不从旧document拷贝系统快照身份。
        for (const field of [
          'id',
          'number',
          'version',
          'status',
          'createdAt',
          'updatedAt',
          'reversal',
          'replacedBy',
          'movements',
        ])
          delete (next as any)[field];
        const n = Number(
          this.store.db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM flow_documents').get()!.n,
        );
        replacementFlowId = Number(
          this.store.db
            .prepare(
              "INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at) VALUES('arrival',?,?,'confirmed',?,?,?,?,?)",
            )
            .run(
              'DH-' + date.replaceAll('-', '') + '-' + String(n).padStart(5, '0'),
              old.date,
              JSON.stringify(next),
              actor.id,
              actor.name,
              at,
              at,
            ).lastInsertRowid,
        );
        replacementId = 'flow-' + replacementFlowId;
        for (const l of plan.lines)
          this.store.db
            .prepare(
              'INSERT INTO flow_refs(document_id,supplier_id,stock_id,purchase_line_id,purchase_id) VALUES(?,?,?,?,?)',
            )
            .run(replacementFlowId, old.supplierId, l.stockId, l.lineId, l.purchaseId);
      }
      // 先写替代入库、再冲销原入库，事务外只看见净变动。这样有后续领料但净库存足够时也可合法更正。
      for (const l of plan.lines)
        if (quantityUnits(l.stockedQuantity ?? l.quantity))
          replacements.push(
            this.addMovement(
              this.repo.items(true).find((s) => s.id === l.stockId),
              quantityUnits(l.stockedQuantity ?? l.quantity),
              actor,
              {
                action: 'purchase',
                kind: 'flow_arrival',
                id: replacementFlowId ? String(replacementFlowId) : replacementId!,
                lineId: l.lineId || undefined,
                orderId: l.purchaseId
                  ? this.repo.purchases(true).find((p) => p.id === l.purchaseId)?.customerOrderId
                  : null,
                date: old.date,
                notes: '到货更正替代：' + old.reference + '；' + input.reason,
              },
            ),
          );
      for (const l of old.lines)
        if (quantityUnits(l.stockedQuantity ?? l.recordedQuantity!))
          reversals.push(
            this.addMovement(
              this.repo.items(true).find((s) => s.id === l.stockId),
              -quantityUnits(l.stockedQuantity ?? l.recordedQuantity!),
              actor,
              {
                action: 'out',
                kind: old.source === 'flow' ? 'flow_reversal' : 'purchase_receipt_reversal',
                id: old.flowId ? String(old.flowId) : old.id,
                lineId: l.lineId || undefined,
                date,
                notes: '到货更正冲销：' + old.reference + '；' + input.reason,
              },
            ),
          );
      const reversal = {
        reason: input.reason,
        by: actor.name,
        at,
        requestId,
        movements: reversals,
      };
      if (replacementFlowId) {
        const row = this.store.db
          .prepare('SELECT document FROM flow_documents WHERE id=?')
          .get(replacementFlowId)!;
        this.store.db
          .prepare('UPDATE flow_documents SET document=? WHERE id=?')
          .run(
            JSON.stringify({ ...JSON.parse(String(row.document)), movements: replacements }),
            replacementFlowId,
          );
        if (old.flowId) this.store.db
          .prepare(
            "UPDATE flow_documents SET status='reversed',version=version+1,document=?,updated_at=? WHERE id=?",
          )
          .run(
            JSON.stringify({ ...old.document, replacedBy: replacementFlowId, reversal }),
            at,
            old.flowId!,
          );
        if (old.flowId) this.store.db
          .prepare(
            "UPDATE purchase_receipts SET document=json_set(document,'$.reversed',1,'$.replacedBy',?,'$.reversal',json(?)) WHERE json_extract(document,'$.flowId')=?",
          )
          .run(replacementId!, JSON.stringify(reversal), old.flowId!);
        if (!old.flowId) this.store.db.prepare('UPDATE purchase_receipts SET document=? WHERE id=?').run(JSON.stringify({ ...old.document, version: (old.document.version || 1) + 1, reversed: true, replacedBy: replacementId!, reversal }), old.id);
        this.store.db
          .prepare(
            'INSERT INTO flow_receipt_keys VALUES(?,?,?) ON CONFLICT(supplier_id,reference) DO UPDATE SET document_id=excluded.document_id',
          )
          .run(
            old.supplierId,
            old.reference.trim().normalize('NFKC').toUpperCase(),
            replacementFlowId,
          );
        this.store.db
          .prepare('UPDATE flow_file_uses SET document_id=? WHERE document_id=?')
          .run(replacementFlowId, old.flowId!);
        for (const p of plan.purchaseImpact)
          this.store.db
            .prepare('INSERT INTO purchase_receipts VALUES(?,?,?,?,?,?,?,?)')
            .run(
              'flow-' + replacementFlowId + '-' + p.id,
              p.id,
              old.reference + ' [收货' + replacementFlowId + ']',
              old.date,
              JSON.stringify({
                flowId: replacementFlowId,
                correctionOf: old.id,
                items: plan.lines
                  .filter((l) => l.purchaseId === p.id)
                  .map((l) => ({ lineId: l.lineId, quantity: l.quantity })),
                movements: replacements,
              }),
              actor.id,
              actor.name,
              at,
            );
      }
      syncReceivedUnits(this.store);
      for (const p of plan.purchaseImpact)
        this.store.db
          .prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?')
          .run(at, p.id);
      const result = {
        mode: 'business' as const,
        discrepancies: [],
        originalReceiptId: old.id,
        replacementReceiptId: replacementId!,
        replacementFlowId,
        requestId,
        stockImpact: plan.stockImpact,
        beforeAmount: plan.beforeAmount,
        afterAmount: plan.afterAmount,
        purchases: this.repo
          .purchases(true)
          .filter((p) => plan.purchaseImpact.some((impact) => impact.id === p.id)),
        stock: this.repo
          .items(true)
          .filter((s) => plan.stockImpact.some((impact) => impact.stockId === s.id)),
        movements: { reversal: reversals, replacement: replacements },
      };
      for (const p of plan.purchaseImpact) {
        const saved = result.purchases.find((row) => row.id === p.id)!;
        if (
          saved.arrivalProgress !== p.arrivalProgress ||
          p.lines.some(
            (l: any) =>
              saved.lines.find((sl: any) => sl.id === l.lineId)?.receivedQuantity !== l.after,
          )
        )
          throw new ImportError('更正后采购到货核验不一致，事务已回滚。', 409);
      }
      if (
        plan.stockImpact.some(
          (s) => result.stock.find((item) => item.id === s.stockId)?.quantity !== s.after,
        )
      )
        throw new ImportError('更正后库存核验不一致，事务已回滚。', 409);
      const corrections = plan.lines.flatMap((l, i) =>
        quantityUnits(l.quantity) === quantityUnits(old.lines[i].quantity)
          ? []
          : [
              {
                name: l.item.name,
                unit: l.item.unit,
                originalQuantity: old.lines[i].quantity,
                correctedQuantity: l.quantity,
                purchaseId: l.purchaseId,
                lineId: l.lineId,
              },
            ],
      );
      const summary =
        (corrections.length ? corrections
          .map((l) => {
            const p = result.purchases.find((p) => p.id === l.purchaseId),
              line = p?.lines.find((pl: any) => pl.id === l.lineId);
            return (
              l.name +
              '原登记' +
              l.originalQuantity +
              l.unit +
              '，更正为' +
              l.correctedQuantity +
              l.unit +
              (line
                ? '；有效累计到货' +
                  line.receivedQuantity +
                  l.unit +
                  '，待到货' +
                  line.remainingQuantity +
                  l.unit +
                  '，采购进度：' +
                  p.arrivalProgress
                : '')
            );
          })
          .join('；') : '有效到货统计保持不变，已按原始入库数量同步库存并完成差异核对') +
        '。' +
        result.stockImpact
          .map((s) => s.name + '库存净变化' + s.delta + s.unit + '，现有' + s.after + s.unit)
          .join('；');
      const verifiedResult = { ...result, corrections, verified: true, summary };
      audit(this.store, actor, 'purchase-receipt', 'correct', 'purchases', purchaseId, {
        requestId,
        reason: input.reason,
        before: old,
        after: receiptEvents(this.store).find((r) => r.id === replacementId),
        result,
      });
      this.remember('receipt-correction', requestId, request, verifiedResult);
      return verifiedResult;
    });
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
    const actor = this.actor(who), v = receiptSchema.parse(raw);
    // 旧HTTP/工具入口保留协议，实际收货统一进入FlowService正式到货事务。
    return this.tx(() => {
      const request = { id, ...v }, prior = this.replay('receipt', v.requestId, request);
      if (prior) return prior;
      let result;
      try { result = new FlowService(this.store).receivePurchase({ purchaseId: id, expectedPurchaseVersion: v.expectedVersion,
      requestId: v.requestId, reference: v.reference, date: v.date, actualTime: v.actualTime,
      notes: v.notes, items: v.items }, actor); }
      catch (e) { if (e instanceof ImportError && e.status === 422) throw new ImportError(e.message, 400); throw e; }
      this.remember('receipt', v.requestId, request, result);
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
