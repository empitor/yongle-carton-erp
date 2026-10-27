import type { Actor } from './auth.js';
import { ImportError } from './import/errors.js';
const capability = Symbol('local-developer-session');
const proof = Object.freeze({});
/** 仅AuthManager在验证本机超级管理员会话后签发；JSON/模型字段无法伪造。 */
export function developerActor(actor: Actor): Actor {
  return Object.assign(actor, { developerMode: true, [capability]: proof });
}
export function isDeveloperActor(actor: Actor | null | undefined): boolean {
  return !!actor && actor.role === 'super_admin' && (actor as any)[capability] === proof;
}
export function requireDeveloper(actor: Actor | null | undefined): Actor {
  if (!isDeveloperActor(actor))
    throw new ImportError('仅本机已开启开发者编辑模式的超级管理员可操作。', 403);
  return actor!;
}
export function localDevelopmentEnabled() {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.APP_ENV !== 'production' &&
    process.env.ERP_DEVELOPER_MODE !== '0'
  );
}
