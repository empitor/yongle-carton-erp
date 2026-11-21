import type { DatabaseSync } from 'node:sqlite';
import { RECORD_PAGE, count, isoTime, many, pageWindow, requireSuperAdmin, rows, type Actor } from '../core/index.js';

/** 一条登录记录：做事的账号名从 LEFT JOIN 来，账号删了是空 */
const eventRow = rows.auth_events.pick({ at: true, action: true }).extend({ name: rows.users.shape.name.nullable() });
const userNameRow = rows.users.pick({ id: true, name: true });

/**
 * 登录记录：读账号库的 auth_events（登录成功、失败、被限流，进出超级管理员模式，改密码，账号和申请的处理）。
 * 写在账号模块（auth-router.ts、auth.ts 的 event）；这里只读，只给超级管理员。不含口令、哈希、会话。
 */

/** 记录里的动作（冒号前那段）对应的叫法 */
const eventNames: Record<string, string> = {
  login: '登录成功',
  'login-failed': '登录失败（密码不对）',
  'login-failed-unknown': '登录失败（没有这个账号）',
  'login-disabled': '登录被拒（账号已停用）',
  'login-expired': '登录失败（临时密码已过期）',
  'login-throttled': '登录被限流（输错次数太多）',
  'super-mode-enter': '进入超级管理员模式',
  'super-mode-exit': '退出超级管理员模式',
  'super-mode-denied': '没进超级管理员模式，管理账号被拦',
  'step-up-failed': '验证本人密码没通过',
  'step-up-throttled': '验证本人密码被限流',
  'password-changed': '改密码',
  'password-reset': '管理员给账号换临时密码',
  'password-reset-cli': '在服务器本机找回密码',
  'password-reset-requested': '申请找回密码',
  'account-created': '建账号',
  'account-updated': '改账号级别或停用',
  'account-requested': '申请账号',
  'account-request-approved': '批准账号申请',
  'account-request-rejected': '拒绝账号申请',
  'account-request-expired': '账号申请过期',
};
/** 冒号后面跟的是被处理的账号编号的几种（批准申请是“申请编号:账号编号”） */
const targetOf = (kind: string, rest: string[]) =>
  kind === 'password-reset' || kind === 'account-created' || kind === 'account-updated'
    ? rest[0]
    : kind === 'account-request-approved'
      ? rest[1]
      : undefined;

export type LoginRecordFilter = { from?: string; to?: string; account?: string; event?: string; limit?: number; offset?: number };

/**
 * 读登录记录。accounts 是账号库（AuthManager 的 db）。筛选：时间段、账号名（做事的人）、事件叫法（如“登录失败”，含这几个字就算）；
 * 分页（默认 20，最多 50），新的在前。
 */
export function readLoginRecords(accounts: DatabaseSync, actor: Actor | null | undefined, filter: LoginRecordFilter = {}) {
  requireSuperAdmin(actor, '登录记录');
  const where: string[] = [],
    args: (string | number)[] = [];
  if (filter.from) where.push('e.at>=?'), args.push(isoTime(filter.from, '开始'));
  if (filter.to) where.push('e.at<=?'), args.push(isoTime(filter.to, '结束'));
  if (filter.account) where.push('u.name=?'), args.push(filter.account);
  const event = filter.event;
  if (event) {
    const kinds = Object.entries(eventNames).filter(([, name]) => name.includes(event)).map(([k]) => k);
    if (!kinds.length) return { total: 0, more: false, items: [] };
    where.push('(' + kinds.map(() => "(e.action=? OR e.action LIKE ? || ':%')").join(' OR ') + ')');
    for (const k of kinds) args.push(k, k);
  }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const base = ' FROM auth_events e LEFT JOIN users u ON u.id=e.actor_id' + clause;
  const { limit, offset } = pageWindow(filter.limit, filter.offset, RECORD_PAGE);
  const total = count(accounts, 'SELECT COUNT(*) AS n' + base, ...args);
  const events = many(accounts, eventRow, 'SELECT e.at,e.action,u.name' + base + ' ORDER BY e.id DESC LIMIT ? OFFSET ?', ...args, limit, offset);
  // 被处理的账号按编号一次查齐
  const parsed = events.map((r) => {
    const [kind, ...rest] = r.action.split(':');
    return { at: r.at, kind, name: r.name, target: targetOf(kind, rest) };
  });
  const ids = [...new Set(parsed.map((p) => p.target).filter((t): t is string => !!t))];
  const names = new Map(
    ids.length
      ? many(accounts, userNameRow, `SELECT id,name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map(
          (u) => [u.id, u.name] as const,
        )
      : [],
  );
  const items = parsed.map((p) => ({
    time: p.at,
    account: p.name ?? '—',
    event: eventNames[p.kind] ?? '其他账号事件',
    ...(p.target ? { target: names.get(p.target) ?? '已删除的账号' } : {}),
  }));
  return { total, more: offset + items.length < total, items };
}
