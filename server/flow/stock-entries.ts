import { z } from 'zod';
import type { Actor } from '../core/index.js';
import { AppError, inSavepoint, onceByRequest, operationRequest, requirePermission } from '../core/index.js';
import {
  movementSchema,
  purchaseStatusRules,
  purchaseViewSchema,
  recordStatusActionNames,
  recordStatusInputSchema,
  stockItemViewSchema,
  type RecordStatusAction,
  type StockItemBaseView,
} from '../../shared/business/index.js';
import { OrderBatchService, type OperationsService } from '../operations/index.js';
import type { FlowCommands } from './base.js';
import { alignStock, detachPurchaseLines } from './maintenance-cascade.js';
import { batchHasArrivals, purchaseReferenced, referencedStock } from './stock-facts.js';
import type { StockViews } from './stock-views.js';

/*
 * 采购单、库存品的保存入口（页面、助手、数据管理、单据导出、脚本都走这里）：先算好采购库存要的单据事实，
 * 再交给采购库存保存（它管权限、版本、核对、写、审计），本机管理员要连带改的单据作为连带交给它在原位置、同一保存点里做；
 * 回给人的是完整视图。改采购单状态、手工出入库的防重复提交也在这里。
 */

/** 采购库存保存时收的选项（整张保存不许改状态、合并导出不建订货单、状态动作） */
type PurchaseSaveOptions = NonNullable<Parameters<OperationsService['savePurchase']>[3]>;
/** 状态动作的结果是改完的整张采购单：同一请求号重发时按采购单的完整结构读回上次的结果 */
const PURCHASE_STATUS_REQUEST = 'purchase-status';
/** 手工出入库的结果：流水号和出入库以后的库存品；同一请求号重发时按这份结构读回上次的结果 */
const movedResult = z.object({ movementId: z.string(), item: stockItemViewSchema });

export class StockFlowService {
  constructor(
    private readonly flow: FlowCommands,
    private readonly views: StockViews,
  ) {}
  /** 改已有采购单时采购库存要的单据事实和连带（读不到这张采购单时交给采购库存按原来的说法报） */
  private purchaseEdit(id: number) {
    const { store } = this.flow,
      current = this.views.purchases(true, id)[0],
      batchId = new OrderBatchService(store).batchIdOf(id);
    return {
      id,
      receivedUnits: new Map(current?.lines.map((l) => [l.id, l.receivedUnits]) ?? []),
      hasReceipts: !!current?.receipts.length,
      referenced: purchaseReferenced(store, id),
      batchHasArrivals: batchId !== null && batchHasArrivals(store, batchId),
      detachLines: (lineIds: number[], actor: Actor) => detachPurchaseLines(this.flow, id, lineIds, actor),
    };
  }
  /**
   * 保存采购单（新建或整张改）。改成已订货自动建订货单、已有到货的锁明细、本机管理员改明细时解除到货关联，
   * 规则都在采购库存的保存里；回完整采购单。
   */
  savePurchase(raw: unknown, who: Actor | null | undefined, id?: number, options: PurchaseSaveOptions = {}) {
    return inSavepoint(this.flow.store.db, () => {
      const saved = this.flow.ops.savePurchase(raw, who, id === undefined ? undefined : this.purchaseEdit(id), options);
      return this.views.purchases(true, saved.id)[0];
    });
  }
  /**
   * 采购单的状态动作：改成待到货、退回待订货、取消采购单、恢复（POST /api/purchases/:id/<动作>）。
   * 和单据的取消一样：要业务编辑权限、核对读到时的版本、同一请求号重试原样返回、写审计；取消必填原因，记在审计里。
   * 保存走和整张保存同一个 savePurchase：已有到货不能退回待订货、全部到货不能取消、改成已订货自动建订货单，规则都在那条路上。
   */
  changePurchaseStatus(id: number, action: RecordStatusAction, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      v = recordStatusInputSchema.parse(raw),
      rule = purchaseStatusRules[action],
      request = operationRequest(PURCHASE_STATUS_REQUEST, v.requestId, actor, { id, action, ...v });
    if (action === 'cancel' && !v.reason) throw new AppError('请填写取消原因。');
    return onceByRequest(this.flow.store, request, () => {
      const before = this.views.purchases(false, id)[0];
      if (!before) throw new AppError('采购单不存在或已归档。', 404);
      if (before.version !== v.expectedVersion) throw new AppError('采购单已被修改，请刷新后再操作。', 409);
      if (!rule.from.includes(before.baseStatus))
        throw new AppError('采购单现在是“' + before.status + '”，不能' + recordStatusActionNames[action] + '。', 409);
      // 恢复：已经到过货的回到已订货（到了的货还在），没到过的回到待订货
      const to = action === 'reinstate' && before.receipts.length ? '已订货' : rule.to;
      return this.savePurchase({ ...before, status: to, version: before.version }, actor, id, {
        statusAction: { action, reason: v.reason },
      });
    }, purchaseViewSchema);
  }
  /** 保存库存品（新建或改）；改已有的先算被单据引用没有，本机管理员改了让已有单据跟着对齐；回完整库存品 */
  saveItem(raw: unknown, who: Actor | null | undefined, id?: number) {
    return inSavepoint(this.flow.store.db, () => {
      const saved = this.flow.ops.saveItem(raw, who, id === undefined ? undefined : this.itemEdit(id));
      return this.views.items(true, saved.id)[0];
    });
  }
  /** 改已有库存品时采购库存要的单据事实和连带 */
  private itemEdit(id: number) {
    return {
      id,
      referenced: referencedStock(this.flow.store, [id]).has(id),
      alignStock: (before: StockItemBaseView, after: StockItemBaseView, actor: Actor) => alignStock(this.flow, before, after, actor),
    };
  }
  /**
   * 手工入库、出库、盘点（POST /api/warehouse/items/:id/move）：同一请求号重发原样返回上次的结果；
   * 核对和记流水在采购库存（OperationsService.move），回流水号和出入库以后的完整库存品。
   */
  move(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      v = movementSchema.parse(raw);
    return onceByRequest(this.flow.store, operationRequest('movement', v.requestId, actor, { id, ...v }), () => {
      const movementId = this.flow.ops.move(id, v, actor);
      return { movementId, item: this.views.items(true, id)[0] };
    }, movedResult);
  }
}
