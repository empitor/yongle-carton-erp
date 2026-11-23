// 登录页和账号菜单的请求：建第一个管理员、登录、申请账号、忘记密码、改自己的密码、退出登录。
import { pageHref, userError, type AccountApi } from '../shared/core/index';
import { call, readJson, request, retryWhenBusy, serviceUnavailable, textField } from './ui/index';

const account = call<AccountApi>();

/**
 * 登录页的请求（还没登录，带的是登录页拿到的页面凭证）。登录失败是正常的 401，这里不通知回登录页；
 * 网关错误页读不出 JSON 时说服务暂时不可用。网断时 request 已经换成中文“连不上服务器，请检查网络后再试。”；
 * 服务器正忙时停一下自动再试一次，第二次还忙才显示（retryWhenBusy），按钮一直是“正在……”。
 */
export async function authPost(
  path: 'setup' | 'login' | 'apply' | 'forgot',
  csrf: string,
  body: unknown,
): Promise<void> {
  const response = await retryWhenBusy(() =>
    request('/api/auth/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf },
      body: JSON.stringify(body),
    }),
  );
  if (response.ok) return;
  const message = textField(await readJson(response), 'message');
  throw new Error(userError(message || (response.status >= 500 ? serviceUnavailable : '操作失败，请刷新后重试。')));
}

/** 改自己的密码（右上角“修改密码”和临时密码登录后的强制改密） */
export const changePassword = (current: string, password: string) =>
  account('POST /auth/password', { body: { current, password } });

/** 退出当前账号。下一个登录的人可能没有当前页面的权限，所以回到首页。 */
export async function signOut() {
  await account('POST /auth/logout', { body: {} });
  history.replaceState(null, '', pageHref('dashboard'));
  location.reload();
}
