import { sales } from '../sales/index.js';
import { orderSchema, trackedOrderViewSchema } from '../../shared/core/index.js';
import { orderStatusRules, recordStatusActionNames, recordStatusInputSchema, type RecordStatusAction } from '../../shared/business/index.js';
import type { Actor, Store } from '../core/index.js';
import { AppError, audit, onceByRequest, operationRequest, requirePermission } from '../core/index.js';
import { saveOrderWithProgress } from './service.js';
import { trackedOrder } from './tracked-orders.js';

/*
 * 订单的状态动作：确认订单、退回待确认、取消订单、恢复为待确认（POST /api/orders/:id/<动作>）。
 * 和单据的取消一样：要业务编辑权限、核对读到时的版本、同一请求号重试原样返回、写审计；取消必填原因，
 * 原因记在审计里，修改历史里看得到。保存走和整张保存同一个 saveOrderWithProgress（已有送货的不能改状态等规则都在那条路上）。
 * 生产中、待发货、已发货只由有效单据派生，不经这里设置。
 */

const REQUEST_KIND = 'order-status';

export function changeOrderStatus(store: Store, id: number, action: RecordStatusAction, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit'),
    v = recordStatusInputSchema.parse(raw),
    rule = orderStatusRules[action],
    request = operationRequest(REQUEST_KIND, v.requestId, actor, { id, action, ...v });
  if (action === 'cancel' && !v.reason) throw new AppError('请填写取消原因。');
  return onceByRequest(store, request, () => {
    const before = trackedOrder(store, id);
    if (!before) throw new AppError('订单不存在或已归档。', 404);
    if (before.version !== v.expectedVersion) throw new AppError('订单已被修改，请刷新后再操作。', 409);
    if (!rule.from.includes(before.status))
      throw new AppError('订单现在是“' + before.status + '”，不能' + recordStatusActionNames[action] + '。', 409);
    const after = saveOrderWithProgress(store, orderSchema.parse({ ...before, status: rule.to }), id, before.version);
    audit(store, actor, {
      action,
      entity: 'orders',
      id,
      document: { before, after, ...(v.reason ? { reason: v.reason } : {}) },
    });
    return after;
  }, trackedOrderViewSchema);
}

/** 整张保存（PUT /api/orders/:id）不改状态：带了和现在不一样的状态就拒绝，指到详情里的状态动作 */
export function assertOrderStatusKept(store: Store, id: number, raw: unknown, includeArchived = false) {
  const next = typeof raw === 'object' && raw !== null && 'status' in raw ? raw.status : undefined,
    current = sales(store).order(id, includeArchived)?.status;
  if (current !== undefined && typeof next === 'string' && next !== current)
    throw new AppError(
      '保存订单不改状态。确认、退回待确认、取消、恢复请用订单详情里的对应按钮（取消要写原因）。',
      409,
    );
}
