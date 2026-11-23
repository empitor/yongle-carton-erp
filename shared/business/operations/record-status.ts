import { z } from 'zod';

/*
 * 订单、采购单的状态动作：确认、退回、取消、恢复，各是一个动作，各走自己的接口
 * （POST /api/orders/:id/<动作>、/api/purchases/:id/<动作>）。整张保存不改状态。
 * 页面、助手、服务端都按这里的动作名和“从哪个状态到哪个状态”办，不各写一份。
 */
export const recordStatusActions = ['confirm', 'revert', 'cancel', 'reinstate'] as const;
export type RecordStatusAction = (typeof recordStatusActions)[number];

/** 动作的叫法（修改历史、提示里用） */
export const recordStatusActionNames: Record<RecordStatusAction, string> = {
  confirm: '确认',
  revert: '退回',
  cancel: '取消',
  reinstate: '恢复',
};

type Rule = { from: readonly string[]; to: string };
/** 订单：生产中、待发货、已发货只由有效单据派生，不在这里 */
export const orderStatusRules: Record<RecordStatusAction, Rule> = {
  confirm: { from: ['待确认'], to: '已确认' },
  revert: { from: ['已确认'], to: '待确认' },
  cancel: { from: ['待确认', '已确认', '生产中', '待发货'], to: '已取消' },
  reinstate: { from: ['已取消'], to: '待确认' },
};
/** 采购单（按单头的状态 baseStatus）：恢复时已经到过货的回到已订货，没到过的回到待订货（服务端定） */
export const purchaseStatusRules: Record<RecordStatusAction, Rule> = {
  confirm: { from: ['待订货'], to: '已订货' },
  revert: { from: ['已订货'], to: '待订货' },
  cancel: { from: ['待订货', '已订货'], to: '已取消' },
  reinstate: { from: ['已取消'], to: '待订货' },
};

/** 从 from 改成 to 是哪个动作；不是这四个动作之一返回 null（比如改成生产中） */
export function statusActionFor(entity: 'orders' | 'purchases', from: string, to: string): RecordStatusAction | null {
  const rules = entity === 'orders' ? orderStatusRules : purchaseStatusRules;
  for (const action of recordStatusActions) {
    const rule = rules[action];
    const target = entity === 'purchases' && action === 'reinstate' ? ['待订货', '已订货'] : [rule.to];
    if (rule.from.includes(from) && target.includes(to)) return action;
  }
  return null;
}

/** 状态动作提交的内容：读到时的版本号、这次请求的编号（重试不重复办）、原因（取消必填） */
export const recordStatusInputSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  requestId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
});
