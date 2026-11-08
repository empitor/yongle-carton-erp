import { authChanged } from './session';
import { userError } from '../shared/user-errors';

export function cents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('金额需为非负数，最多两位小数');
  const [a, b = ''] = value.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
export async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  let authToken = '';
  if (body !== undefined) {
    const auth = await fetch('/api/auth/state', { cache: 'no-store' });
    if (auth.ok) {
      const state = await auth.json();
      if (!state.actor) throw new Error('请先在右上角登录管理账号。');
      authToken = state.csrf;
    }
  }
  const res = await fetch(
    '/api' + url,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': authToken },
          body: JSON.stringify(body),
        },
  );
  if (!res.ok) {
    // 会话失效时回到登录页，不把401显示成业务错误。
    if (res.status === 401) authChanged();
    const error = await res.json().catch(() => ({ message: '服务响应异常' }));
    throw new Error(userError(error.message || '操作失败'));
  }
  return res.json();
}
