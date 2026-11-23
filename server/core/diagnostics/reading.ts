import type { Actor } from '../http/actor.js';
import { AppError } from '../http/errors.js';

/**
 * 诊断读取函数共用的几样：权限（每个读取函数第一步调）、时间写法、分页条数。
 * 出错记录（这个目录）和系统资料（server/system/ 的运行日志、登录记录、读程序代码）都用，经 core/index.ts 交出去。
 * 超级管理员指管理员级别的账号（和账号管理页一样，不要求开着模式）。
 */

export function requireSignedIn(actor: Actor | null | undefined): Actor {
  if (!actor) throw new AppError('请先登录账号。', 401, 'authentication');
  return actor;
}

export const isSuperAdmin = (actor: Actor | null | undefined) => actor?.role === 'super_admin';

export function requireSuperAdmin(actor: Actor | null | undefined, what: string): Actor {
  const signedIn = requireSignedIn(actor);
  if (!isSuperAdmin(signedIn)) throw new AppError(what + '只给超级管理员看，当前账号没有这个权限。', 403, 'permission');
  return signedIn;
}

/** 筛选用的时间统一成 ISO（UTC）；写错的报给调用方 */
export function isoTime(value: string, label: string) {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw new AppError(label + '的时间写法不对，请用 2026-11-13 或 2026-11-13T08:00 这样的写法。');
  return t.toISOString();
}

/** 一次给几条：没给用 size，最多 max */
export type PageSize = { size: number; max: number };
/** 出错记录、登录记录这类列表一页：默认 20 条，最多 50 */
export const RECORD_PAGE: PageSize = { size: 20, max: 50 };

/** 条数夹在 1 到 page.max 之间（没给用 page.size），跳过的条数不小于 0 */
export const pageWindow = (limit: number | undefined, offset: number | undefined, page: PageSize) => ({
  limit: Math.min(page.max, Math.max(1, Math.trunc(limit ?? page.size))),
  offset: Math.max(0, Math.trunc(offset ?? 0)),
});
