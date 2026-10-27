import type { Actor } from './auth.js';
import { ImportError } from './import/errors.js';
const capability = Symbol('local-developer-session');
const proof = Object.freeze({});
const ownerCapability = Symbol('authenticated-local-administrator');
/** 仅由AuthManager对真实本机会话签发，不信任请求或模型中的同名字段。 */
export function localAdministratorActor(actor: Actor): Actor {
  return Object.assign(actor, { localAdministrator: true, [ownerCapability]: proof });
}
export function isLocalAdministrator(actor: Actor | null | undefined): boolean {
  return !!actor && actor.role === 'super_admin' && (actor as any)[ownerCapability] === proof;
}
export function requireLocalAdministrator(actor: Actor | null | undefined): Actor {
  if (!isLocalAdministrator(actor)) throw new ImportError('仅已登录的本机最高管理员可操作。', 403);
  return actor!;
}
/** 仅AuthManager在验证本机超级管理员会话后签发；JSON/模型字段无法伪造。 */
export function developerActor(actor: Actor): Actor {
  return Object.assign(actor, { developerMode: true, [capability]: proof });
}
export function isDeveloperActor(actor: Actor | null | undefined): boolean {
  return (
    isLocalAdministrator(actor) ||
    (!!actor && actor.role === 'super_admin' && (actor as any)[capability] === proof)
  );
}
export function requireDeveloper(actor: Actor | null | undefined): Actor {
  if (!isDeveloperActor(actor))
    throw new ImportError('仅已登录的本机最高管理员可操作（兼容原开发者会话）。', 403);
  return actor!;
}
export function localDevelopmentEnabled() {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.APP_ENV !== 'production' &&
    process.env.ERP_DEVELOPER_MODE !== '0'
  );
}
