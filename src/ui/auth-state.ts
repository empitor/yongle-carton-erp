import { useEffect, useState } from 'react';
import { z } from 'zod';
import { accountLevels, permissionNames, userRoles } from '../../shared/core/index';
import { emit, listen } from './events';
import { readJson } from './read-body';

/* 登录状态：类型、能不能办业务，和请求时用的那份记下的登录状态（含页面凭证）。发请求在 http.ts。 */

/** GET /api/auth/state 的回答（服务端 server/accounts/auth-router.ts）。读到后按它校验，不像登录状态的回答不用。 */
const authStateSchema = z.object({
  configured: z.boolean(),
  deploymentMode: z.boolean().optional(),
  proxyAccess: z.boolean().optional(),
  /** 备案号：从域名进来、服务器填了才有 */
  filing: z.object({ icp: z.string().optional(), police: z.string().optional() }).optional(),
  actor: z
    .object({
      id: z.string(),
      name: z.string(),
      /** 只认权限名单里的（shared/core/accounts.ts），页面上判断权限写错名字编译不过 */
      permissions: z.array(z.enum(permissionNames)),
      role: z.enum(userRoles).optional(),
      superAdminMode: z.boolean().optional(),
      superAdminUntil: z.number().optional(),
      localAdministrator: z.boolean().optional(),
      mustChangePassword: z.boolean().optional(),
    })
    .nullable(),
  csrf: z.string(),
  /** 账号级别，叫法见 shared/core 的 accountLevelNames。 */
  level: z.enum(accountLevels).optional(),
  /** 待管理员处理的账号申请和忘记密码申请，只有管理员能看到。 */
  pendingRequests: z.number().optional(),
});
export type AuthState = z.infer<typeof authStateSchema>;
/** 读到的回答是登录状态就返回它，不是（网关错误页、读不出 JSON、形状不对）返回 null */
export function parseAuthState(body: unknown): AuthState | null {
  const parsed = authStateSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
/** 能不能新建、办理业务单据：有业务编辑权限，或开着超级管理员模式。还没读到登录状态时算不能。 */
export function canEditBusiness(auth: Pick<AuthState, 'actor'> | null | undefined): boolean {
  return !!auth?.actor && (!!auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
}
/** 能不能看财务（财务页、详情里的财务段、到期应收应付）：有财务查看权限。还没读到登录状态时算不能。 */
export function canViewFinance(auth: Pick<AuthState, 'actor'> | null | undefined): boolean {
  return !!auth?.actor?.permissions.includes('finance:view');
}
/** 只读账号从链接、搜索面板或别的页面点了新建、办理类入口时的提示。 */
export const readOnlyNotice = '当前账号只能查看，新建和办理单据需要业务编辑权限。';
/** 登录状态变了（登录、退出、改密码、切换超级管理员模式、接口回 401）：作废记下的登录状态，页面重新读。 */
export function authChanged() {
  forgetAuthState();
  emit('erp-auth-changed');
}
/**
 * 最近读到的登录状态（含页面凭证）。写入时直接用它的凭证，不必每次先读一遍；
 * 登录状态一变（authChanged）就作废，最多用一分钟。页面凭证在服务重启后会换，旧凭证被拒时重读一次（见 http.ts 的 sendWithAuth）。
 */
let knownAuth: { state: AuthState; at: number } | null = null;
const KNOWN_AUTH_FOR = 60_000;
export function rememberAuthState(state: AuthState) {
  knownAuth = { state, at: Date.now() };
}
/** 忘掉记下的登录状态，下次带凭证的请求先重读。 */
export function forgetAuthState() {
  knownAuth = null;
}
/** 记下的登录状态还新、而且是登录着的就返回它；没登录的不算（可能刚在别的标签页登录了），要重读。 */
export function freshAuthState(): AuthState | null {
  return knownAuth?.state.actor && Date.now() - knownAuth.at < KNOWN_AUTH_FOR ? knownAuth.state : null;
}
/** 记下的登录状态里的页面凭证；没登录时是 null。 */
export function knownCsrf(): string | null {
  return knownAuth?.state.actor ? knownAuth.state.csrf : null;
}
export function useAuthState() {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => {
      fetch('/api/auth/state', { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error('登录状态没读到：' + r.status);
          return readJson(r);
        })
        .then((body) => {
          // 网关错误页读不出登录状态时保留上一次的，不把页面当成已退出
          const s = parseAuthState(body);
          if (s) rememberAuthState(s);
          if (active && s) setState(s);
        })
        .catch(() => {
          // 定时、回到窗口时重读的：这次没读到（网断了、服务在重启）保留上一次的登录状态，下次重读；失败的请求不经 request，不上报
        });
    };
    load();
    const stopAuthChanged = listen('erp-auth-changed', load);
    window.addEventListener('focus', load);
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
      stopAuthChanged();
      window.removeEventListener('focus', load);
    };
  }, []);
  return state;
}
