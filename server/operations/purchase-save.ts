import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RAW_UNIT, rawUnit, rawUnitMessage, quantityUnits, quantityString } from '../../shared/core/index.js';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, audit, inSavepoint, isLocalAdministrator, isSuperMode, nextAutoId } from '../core/index.js';
import { purchaseSchema, requiredPurchaseSize, sameRawSpec, type PurchaseView } from '../../shared/business/index.js';
import { OperationsRepository } from './repository.js';
import { deletePurchaseLines, insertPurchaseLine, setPurchaseLineOrder, updatePurchaseLine } from './ledger.js';
import { OrderBatchService } from './batches.js';
import { adminCascade, arrivalSource } from './hooks.js';
import { businessActor, priorRecord } from './write-base.js';

/**
 * 保存采购单的选项：skipBatch 合并导出订货单时由导出那边建批次；keepStatus 整张保存（PUT）不许改状态；
 * statusAction 是状态动作（purchase-status.ts）在保存，审计记这个动作和原因，不记成普通修改。
 */
export type PurchaseSaveOptions = {
  skipBatch?: boolean;
  keepStatus?: boolean;
  statusAction?: { action: string; reason?: string };
};
/** 保存采购单时校验过的内容（明细的单位已归成“张”） */
type PurchaseInput = z.infer<typeof purchaseSchema>;
type PurchaseLineInput = PurchaseInput['lines'][number];
const purchaseLineInput = purchaseSchema.shape.lines.element;
const sizeNames = { length: '长', width: '宽' } as const;
/** 采购单号 CG-日期-序号 里序号的位数 */
const PURCHASE_SERIAL_DIGITS = 4;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** 比较已到货的明细改没改：订单关联不算明细内容（到货后仍可改，和单头的关联订单一样），数量按规范写法比 */
function comparableLine(l: PurchaseLineInput) {
  const { id: _id, stockItemId, quantity, unitPrice, customerOrderId: _order, ...meta } = l;
  return {
    stockItemId,
    quantity: quantityString(quantityUnits(quantity)),
    unitPrice,
    ...meta,
  };
}
/** 一行明细交给 ledger.ts 写的样子：库存品、关联订单、数量存进列，其余内容存进 document */
function lineOf(l: PurchaseLineInput) {
  const { id: _id, stockItemId, quantity, customerOrderId, ...document } = l;
  return { stockItemId, customerOrderId: customerOrderId ?? null, quantityUnits: quantityUnits(quantity), document };
}

/** 保存采购单：核对、写单头、写明细、跟着调整订货单 */
export class PurchaseWriter {
  readonly repo: OperationsRepository;
  constructor(readonly store: Store) {
    this.repo = new OperationsRepository(store);
  }
  /**
   * 保存采购单。改成已订货时自动建一个只含这张采购单的订货批次，到货页的待到货里就有它；
   * 合并导出订货单时由导出那边一次建好批次，传 skipBatch。
   * 明细按三种情况写（writePurchaseLines）：本机管理员改已有的采购单、已登记到货的只改订单关联、其余整组重写。
   */
  savePurchase(
    raw: unknown,
    who: Actor | null | undefined,
    id?: number,
    options: PurchaseSaveOptions = {},
  ) {
    const actor = businessActor(who),
      parsed = purchaseSchema.parse(raw),
      // 采购的纸板只有“张”
      v = { ...parsed, lines: parsed.lines.map((l) => ({ ...l, unit: rawUnit(l.unit) })) };
    return inSavepoint(this.store.db, () => {
      const before = priorRecord(this.repo, 'purchases', id, raw, actor);
      if (options.keepStatus && before && v.status !== before.baseStatus)
        throw new AppError(
          '保存采购单不改状态。改成待到货、退回待订货、取消、恢复请用采购单详情里的对应按钮（取消要写原因）。',
          409,
        );
      const supplierName = this.checkParties(v, before, actor);
      this.checkLineStock(v, before, actor);
      this.checkLineSizes(v);
      const hasReceipts =
        !!before && (before.receipts.length > 0 || arrivalSource().purchaseReferenced(this.store, before.id));
      if (before && hasReceipts && !isLocalAdministrator(actor)) this.checkReceivedPurchase(v, before);
      const savedId = this.writePurchaseHead(v, before, supplierName);
      this.writePurchaseLines(savedId, v, before, actor, hasReceipts);
      const after = this.repo.purchases(true, savedId)[0];
      audit(this.store, actor, {
        action: options.statusAction?.action ?? (before ? 'update' : 'create'),
        entity: 'purchases',
        id: savedId,
        document: { before, after, ...(options.statusAction?.reason ? { reason: options.statusAction.reason } : {}) },
      });
      this.syncOrderBatch(savedId, v, before, actor, options);
      return after;
    });
  }
  /** 单位、供应商、关联的订单能不能这样存；返回要记的供应商名称 */
  private checkParties(v: PurchaseInput, before: PurchaseView | null, actor: Actor) {
    // 纸板只有“张”，别的单位拒收
    if (v.lines.some((l) => l.unit !== RAW_UNIT)) throw new AppError(rawUnitMessage);
    const supplierName = this.repo.supplierName(v.supplierId, isSuperMode(actor) || !!before);
    if (supplierName === undefined) throw new AppError('供应商不存在或已归档。');
    if (this.store.archived('suppliers', v.supplierId) && !isSuperMode(actor) && before?.supplierId !== v.supplierId)
      throw new AppError('供应商已归档，请先恢复或另选供应商。');
    if (
      v.customerOrderId &&
      !this.store.order(
        v.customerOrderId,
        isSuperMode(actor) || before?.customerOrderId === v.customerOrderId,
      )
    )
      throw new AppError('关联客户订单不存在或已归档。');
    // 明细各自关联的订单（一张采购单给几张订单订料）：每张都要存在
    for (const orderId of new Set(v.lines.flatMap((l) => (l.customerOrderId ? [l.customerOrderId] : []))))
      if (
        !this.store.order(
          orderId,
          isSuperMode(actor) || !!before?.lines.some((old) => old.customerOrderId === orderId),
        )
      )
        throw new AppError('明细关联的客户订单不存在或已归档。');
    return supplierName;
  }
  /**
   * 明细关联的库存品：要是没归档的原材料（到货后、或取消的采购单留着原来关联的不算），规格要和库存品一样。
   * 本机管理员改的规格对不上时，这一行改成不关联库存品（改的是 v 里的这一行）。
   */
  private checkLineStock(v: PurchaseInput, before: PurchaseView | null, actor: Actor) {
    const stock = new Map(this.repo.items(true, v.lines.flatMap((l) => l.stockItemId ? [l.stockItemId] : [])).map((item) => [item.id, item]));
    for (const l of v.lines) {
      if (!l.stockItemId) continue;
      const item = stock.get(l.stockItemId);
      const retaining =
        !!before?.lines.some((old) => old.id === l.id && old.stockItemId === l.stockItemId) &&
        (before.receipts.length > 0 || v.status === '已取消');
      if (!item || (item.archived && !retaining && !isLocalAdministrator(actor)) || item.kind !== 'raw')
        throw new AppError('采购明细须关联正常原材料库存品。');
      // 原材料库存品只有“张”（数据库约束），明细上面也只收“张”，单位不会对不上；
      // 规格按全项目同一套规则比（sameRawSpec：不分大小写和全半角、尺寸换成毫米），和到货自动对应库存品一致
      if (sameRawSpec(item, l)) continue;
      if (!isLocalAdministrator(actor))
        throw new AppError('明细规格与所选库存品不一致，请使用库存品规格或选择新建库存品。');
      l.stockItemId = null;
    }
  }
  /** 没关联库存品的行要写长和宽（requiredPurchaseSize，页面的必填标记也按它）；页面、助手、数据管理都走这里 */
  private checkLineSizes(v: PurchaseInput) {
    v.lines.forEach((l, i) => {
      const missing = requiredPurchaseSize(l).filter((k) => l[k] == null);
      if (missing.length)
        throw new AppError(
          '明细第' + (i + 1) + '项“' + l.name + '”没关联库存品，要填纸板的' + missing.map((k) => sizeNames[k]).join('和') +
            '（按开料尺寸照实填，不知道就先问清楚，不要猜；材质可以不填），或者选一个库存里已有的纸板。',
        );
    });
  }
  /** 已登记到货的采购单（本机管理员以外）：日期、供应商、明细、数量、价格都不能改，也不能退回待订货、全部到货后取消 */
  private checkReceivedPurchase(v: PurchaseInput, before: PurchaseView) {
    if (
      v.orderDate !== before.orderDate ||
      v.supplierId !== before.supplierId ||
      v.lines.length !== before.lines.length ||
      v.lines.some(
        (l, i) =>
          l.id !== before.lines[i].id ||
          digest(comparableLine(l)) !== digest(comparableLine(purchaseLineInput.parse(before.lines[i]))),
      )
    )
      throw new AppError(
        '已登记到货的采购单不能修改采购日期、供应商、明细、数量或价格；可改订货单的到货安排、客户订单关联、备注，或取消未到货部分。',
      );
    if (v.status === '待订货') throw new AppError('已有到货，不能退回待订货状态。');
    if (before.status === '全部到货' && v.status === '已取消')
      throw new AppError('已经全部到货，不能取消；库存不会因取消而回退。');
  }
  /** 写采购单单头，返回编号（新建的编号由数据库分配） */
  private writePurchaseHead(v: PurchaseInput, before: PurchaseView | null, supplierName: string): number {
    const at = new Date().toISOString();
    if (before) {
      this.store.db
        .prepare(
          'UPDATE purchases SET supplier_id=?,supplier_name=?,customer_order_id=?,order_date=?,expected_date=?,status=?,notes=?,version=version+1,updated_at=? WHERE id=?',
        )
        .run(
          v.supplierId,
          before.supplierId === v.supplierId ? before.supplierName : supplierName,
          v.customerOrderId,
          v.orderDate,
          v.expectedDate,
          v.status,
          v.notes,
          at,
          before.id,
        );
      return before.id;
    }
    // 采购单号里的序号就是真正分到的编号：删掉的采购单编号也不复用
    const id = nextAutoId(this.store.db, 'purchases');
    this.store.db
      .prepare('INSERT INTO purchases(id,number,supplier_id,supplier_name,customer_order_id,order_date,expected_date,status,notes,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)')
      .run(
        id,
        'CG-' + v.orderDate.replaceAll('-', '') + '-' + String(id).padStart(PURCHASE_SERIAL_DIGITS, '0'),
        v.supplierId,
        supplierName,
        v.customerOrderId,
        v.orderDate,
        v.expectedDate,
        v.status,
        v.notes,
        at,
        at,
      );
    return id;
  }
  /**
   * 写明细（都走 ledger.ts，这一行关联的订单存进 customer_order_id 列，JSON 里不存），三种情况：
   * - 本机管理员改已有的采购单：按编号逐行改（rewriteLinesAsAdmin）；
   * - 已登记到货（本机管理员以外）：明细其他内容不动，只更新每行关联的订单。checkReceivedPurchase 已核对
   *   明细和原来的一一对应（行数、每行编号都一样），所以按原来的明细编号逐行改；
   * - 其余：整组删掉重写。
   */
  private writePurchaseLines(id: number, v: PurchaseInput, before: PurchaseView | null, actor: Actor, hasReceipts: boolean) {
    if (before && isLocalAdministrator(actor)) {
      this.rewriteLinesAsAdmin(id, v, before, actor);
      return;
    }
    if (before && hasReceipts) {
      before.lines.forEach((old, i) => setPurchaseLineOrder(this.store, id, old.id, v.lines[i].customerOrderId ?? null));
      return;
    }
    deletePurchaseLines(this.store, id);
    for (const l of v.lines) insertPurchaseLine(this.store, id, lineOf(l));
  }
  /** 本机管理员改已有的采购单：改了库存品、规格、供应商或删掉的行，先让挂在上面的到货单解除关联，再按编号逐行删、改、加 */
  private rewriteLinesAsAdmin(id: number, v: PurchaseInput, before: PurchaseView, actor: Actor) {
    const changed = before.lines
      .filter((old) => {
        const next = v.lines.find((l) => l.id === old.id);
        return (
          !next ||
          v.supplierId !== before.supplierId ||
          old.stockItemId !== next.stockItemId ||
          old.unit !== next.unit ||
          !sameRawSpec(old, next)
        );
      })
      .map((l) => l.id);
    if (changed.length) adminCascade().detachPurchaseLines(this.store, id, changed, actor);
    for (const old of before.lines)
      if (!v.lines.some((l) => l.id === old.id)) deletePurchaseLines(this.store, id, old.id);
    for (const l of v.lines) {
      if (l.id) {
        const lineId = l.id;
        if (!before.lines.some((old) => old.id === lineId)) throw new AppError('明细编号不属于当前采购。');
        updatePurchaseLine(this.store, id, lineId, lineOf(l));
      } else insertPurchaseLine(this.store, id, lineOf(l));
    }
  }
  /** 换了供应商的采购单移出原来那家的订货单；改成已订货（或换了供应商）的按新供应商单独建一份 */
  private syncOrderBatch(id: number, v: PurchaseInput, before: PurchaseView | null, actor: Actor, options: PurchaseSaveOptions) {
    // 库里存的状态只有待订货、已订货、已取消（部分到货、全部到货是按到货显示的），订过货就是“已订货”
    const wasOrdered = before?.baseStatus === '已订货';
    const batches = new OrderBatchService(this.store);
    // 换了供应商的采购单移出原来那家的订货单；还是已订货的，按新供应商单独建一份
    const moved = !!before && before.supplierId !== v.supplierId && batches.batchIdOf(id) !== null;
    if (moved) batches.detach(id, actor);
    if (!options.skipBatch && v.status === '已订货' && (!wasOrdered || moved)) {
      if (batches.batchIdOf(id) === null) batches.create([id], actor);
    }
  }
}
