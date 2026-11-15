import type { Actor } from './actor.js';
import { AppError } from './errors.js';
const ownerCapability = Symbol('authenticated-local-administrator');
const proof = Object.freeze({});
/** 盖了本机管理员凭证的账号：凭证是符号属性，请求、模型里的同名字段盖不上 */
type LocalAdministrator = Actor & { [ownerCapability]: typeof proof };
/** 仅由AuthManager对真实本机会话签发，不信任请求或模型中的同名字段。 */
export function localAdministratorActor(actor: Actor): Actor {
  return Object.assign(actor, { localAdministrator: true, [ownerCapability]: proof });
}
export function isLocalAdministrator(actor: Actor | null | undefined): actor is LocalAdministrator {
  return !!actor && actor.role === 'super_admin' && ownerCapability in actor && actor[ownerCapability] === proof;
}
export function requireLocalAdministrator(actor: Actor | null | undefined): Actor {
  // 错误类别 permission：和其它权限不够的拒绝同一类
  if (!isLocalAdministrator(actor)) throw new AppError('仅已登录的本机最高管理员可操作。', 403, 'permission');
  return actor;
}
