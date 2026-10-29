import { useEffect, useState } from 'react';
import { userError } from '../shared/user-errors';
export type AuthState = {
  configured: boolean;
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
  } | null;
  csrf: string;
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
export async function managementRequest<T = any>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const auth = (await fetch('/api/auth/state', { cache: 'no-store' }).then((r) =>
    r.json(),
  )) as AuthState;
  if (body !== undefined && !auth.actor) throw new Error('请先在右上角登录管理账号。');
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
