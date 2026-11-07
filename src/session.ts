import { useEffect, useState } from 'react';
import { userError } from '../shared/user-errors';
export type AuthState = {
  configured: boolean;
  deploymentMode?: boolean;
  proxyAccess?: boolean;
  developerAvailable?: boolean;
  actor: {
    id: string;
    name: string;
    permissions: string[];
    role?: 'admin' | 'super_admin';
    superAdminMode?: boolean;
    superAdminUntil?: number;
    developerMode?: boolean;
    localAdministrator?: boolean;
    mustChangePassword?: boolean;
  } | null;
  csrf: string;
  /** 账号级别，见 accountLevelNames。 */
  level?: string;
  /** 待管理员处理的账号申请和忘记密码申请，只有管理员能看到。 */
  pendingRequests?: number;
};
export const accountLevelNames: Record<string, string> = {
  admin: '管理员',
  staff: '业务人员',
  viewer: '只读',
  finance: '财务',
  cashier: '出纳',
};
export function authChanged() {
  window.dispatchEvent(new Event('erp-auth-changed'));
}
export function useAuthState() {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => {
      fetch('/api/auth/state', { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((s) => {
          if (active) setState(s);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('erp-auth-changed', load);
    window.addEventListener('focus', load);
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('erp-auth-changed', load);
      window.removeEventListener('focus', load);
    };
  }, []);
  return state;
}
/** 退出当前账号。下一个登录的人可能没有当前页面的权限，所以回到首页。 */
export async function signOut() {
  await managementRequest('/auth/logout', {});
  history.replaceState(null, '', '#dashboard');
  location.reload();
}
export async function managementRequest<T = any>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const auth = (await fetch('/api/auth/state', { cache: 'no-store' }).then((r) =>
    r.json(),
  )) as AuthState;
  if (!auth.actor) throw new Error('请先登录账号。');
  const r = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) {
    authChanged();
    throw new Error(userError(data.message || '操作失败，请刷新后重试。'));
  }
  return data;
}
