import {
  purchaseStatusRules,
  purchaseViewSchema,
  recordStatusActionNames,
  recordStatusInputSchema,
  type RecordStatusAction,
} from '../../shared/business/index.js';
import type { Actor, Store } from '../core/index.js';
import { AppError, onceByRequest, operationRequest } from '../core/index.js';
import { OperationsService } from './service.js';
import { businessActor } from './write-base.js';

/*
 * 采购单的状态动作：改成待到货、退回待订货、取消采购单、恢复（POST /api/purchases/:id/<动作>）。
 * 和单据的取消一样：要业务编辑权限、核对读到时的版本、同一请求号重试原样返回、写审计；取消必填原因，记在审计里。
 * 保存走和整张保存同一个 savePurchase：已有到货不能退回待订货、全部到货不能取消、改成已订货自动建订货单，规则都在那条路上。
 */

/** 状态动作的结果是改完的整张采购单：同一请求号重发时按采购单的完整结构（purchaseViewSchema）读回上次的结果 */
const REQUEST_KIND = 'purchase-status';

export function changePurchaseStatus(store: Store, id: number, action: RecordStatusAction, raw: unknown, who: Actor | null | undefined) {
  const actor = businessActor(who),
    v = recordStatusInputSchema.parse(raw),
    rule = purchaseStatusRules[action],
    ops = new OperationsService(store),
    request = operationRequest(REQUEST_KIND, v.requestId, actor, { id, action, ...v });
  if (action === 'cancel' && !v.reason) throw new AppError('请填写取消原因。');
  return onceByRequest(store, request, () => {
    const before = ops.repo.purchases(false, id)[0];
    if (!before) throw new AppError('采购单不存在或已归档。', 404);
    if (before.version !== v.expectedVersion) throw new AppError('采购单已被修改，请刷新后再操作。', 409);
    if (!rule.from.includes(before.baseStatus))
      throw new AppError('采购单现在是“' + before.status + '”，不能' + recordStatusActionNames[action] + '。', 409);
    // 恢复：已经到过货的回到已订货（到了的货还在），没到过的回到待订货
    const to = action === 'reinstate' && before.receipts.length ? '已订货' : rule.to;
    return ops.savePurchase({ ...before, status: to, version: before.version }, actor, id, {
      statusAction: { action, reason: v.reason },
    });
  }, purchaseViewSchema);
}
