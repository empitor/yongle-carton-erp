// 账号管理的请求：账号、待处理申请、超级管理员模式。账号页、申请窗口、系统维护窗口都走这里。
import type { AccountApi, AccountRequestView, AccountView } from '../../shared/core/index';
import { call } from '../ui/index';

const accounts = call<AccountApi>();
/** 改账号、处理申请后服务端回的最新列表（有哪张回哪张）；发了临时密码时带上它 */
export type AccountResult = { users?: AccountView[]; requests?: AccountRequestView[]; temporaryPassword?: string };

export const readAccounts = () => accounts('GET /auth/users');
export const readAccountRequests = () => accounts('GET /auth/requests');

export const createAccount = (body: AccountApi['POST /auth/users']['body']) => accounts('POST /auth/users', { body });
/** 启用、停用、改级别 */
export const updateAccount = (id: string, patch: AccountApi['PUT /auth/users/:id']['body']) =>
  accounts('PUT /auth/users/:id', { params: { id }, body: patch });
/** 重置密码：生成临时密码 */
export const resetAccountPassword = (id: string) =>
  accounts('POST /auth/users/:id/password', { params: { id }, body: {} });

/** 通过申请：开通账号时带用户名和级别；忘记密码的申请不带，回临时密码 */
export const approveRequest = (id: string, body: AccountApi['POST /auth/requests/:id/approve']['body'] = {}) =>
  accounts('POST /auth/requests/:id/approve', { params: { id }, body });
export const rejectRequest = (id: string) => accounts('POST /auth/requests/:id/reject', { params: { id }, body: {} });

/** 进入（验本人密码）或退出超级管理员模式；回的是新的登录账号，页面不读它，改完由 authChanged 重读 */
export const changeSuperMode = (enter: boolean, password: string) =>
  enter
    ? accounts('POST /auth/super-admin/:action', { params: { action: 'enter' }, body: { password } })
    : accounts('POST /auth/super-admin/:action', { params: { action: 'exit' }, body: {} });
