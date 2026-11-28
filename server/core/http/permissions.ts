import type { Actor } from './actor.js';
import { AppError } from './errors.js';
import type { Permission } from '../../../shared/core/index.js';

// 权限检查：各模块的写操作都经这里，规则只有一份。权限名只收 shared/core/accounts.ts 列的那几个。
export function requirePermission(actor: Actor | null | undefined, permission: Permission): Actor {
  if (!actor) throw new AppError('请先登录管理账号。', 401, 'authentication');
  if (isSuperMode(actor)) return actor;
  if (!actor.permissions.includes(permission))
    throw new AppError('当前账号没有执行此操作的权限。', 403, 'permission');
  return actor;
}
export function isSuperMode(actor: Actor | null | undefined) {
  return (
    !!actor &&
    canEnterSuperMode(actor) &&
    actor.superAdminMode === true &&
    (actor.superAdminUntil || 0) > Date.now()
  );
}
/**
 * 这个账号能不能进超级管理员模式：只有超级管理员账号能（server/accounts/auth.ts 进入模式的路由按同一个字段判断）。
 * 业务员、只读、财务账号进不了，账号菜单里也没有“系统维护”。
 */
export function canEnterSuperMode(actor: Actor | null | undefined) {
  return !!actor && actor.role === 'super_admin';
}
/**
 * “要超级管理员模式”的事被拒时怎么说，全项目一个分法：
 * - 没登录：401 authentication；
 * - 进不了这个模式的账号：直接说没有权限，不叫人去“系统维护”（403 permission）；
 * - 能进但没进的超级管理员账号：提示去账号菜单的“系统维护”验证密码进入（403 super-mode）。
 * what 是要做的事（比如“撤销生产任务”）；tails 按类别在句末补半句（比如还能做什么）。
 */
export function superModeDenied(
  actor: Actor | null | undefined,
  what: string,
  tails: { permission?: string; superMode?: string } = {},
) {
  if (!actor) return new AppError('请先登录管理账号。', 401, 'authentication');
  const end = (tail?: string) => (tail ? '；' + tail : '') + '。';
  return canEnterSuperMode(actor)
    ? new AppError(
        what + '要先在账号菜单的“系统维护”里验证密码，进入超级管理员模式' + end(tails.superMode),
        403,
        'super-mode',
      )
    : new AppError(what + '要用超级管理员账号，当前账号没有这个权限' + end(tails.permission), 403, 'permission');
}
/** 只给超级管理员账号的事（不要求进模式，比如看设置里的 AI 设置、提示词、工具）：别的账号按 superModeDenied 的说法拒绝。 */
export function requireSuperAdminAccount(actor: Actor | null | undefined, what: string): Actor {
  if (actor && canEnterSuperMode(actor)) return actor;
  throw superModeDenied(actor, what);
}
/** 要超级管理员模式才能做的事：在模式里放行，不在就按 superModeDenied 的分法拒绝。 */
export function requireSuperModeFor(
  actor: Actor | null | undefined,
  what: string,
  tails?: { permission?: string; superMode?: string },
): Actor {
  if (actor && isSuperMode(actor)) return actor;
  throw superModeDenied(actor, what, tails);
}
/**
 * 列表要不要带上已归档的（请求参数 archived）：all 是连同已归档的一起看，要超级管理员模式
 * （拒绝按 superModeDenied 分类，没登录的说请先登录）；1 是只看已归档的，谁都能看。全站列表都用这一个判断，
 * 单条读取跟着它（includeArchivedForRecord）。
 */
export function includeArchivedFor(actor: Actor | null | undefined, archived: unknown): boolean {
  if (archived === 'all') {
    requireSuperModeFor(actor, '查看已归档的记录');
    return true;
  }
  return archived === '1';
}

/**
 * 按编号读一条（客户、产品、订单、采购单……）带不带已归档的：和“只看已归档的”列表同一条线，
 * 在已归档列表里看得到的单条也读得到，不比列表多；列表收紧这里跟着收紧。
 */
export const includeArchivedForRecord = (actor: Actor | null | undefined): boolean => includeArchivedFor(actor, '1');
