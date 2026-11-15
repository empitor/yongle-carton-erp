import {
  accountLevelNames,
  accountLevels,
  type AccountLevel,
  type AccountRequestView,
  type AccountView,
} from '../../shared/core/index';
import {
  approveRequest,
  rejectRequest,
  resetAccountPassword,
  updateAccount,
  type AccountResult,
} from './account-api';

/** 要先确认的一步：确认窗的标题、说明、按钮，确认后办的事 */
export type Confirm = {
  title: string;
  text: string;
  action: string;
  danger?: boolean;
  run: () => Promise<void>;
};
/** 办完以后：发了临时密码的弹窗给人看（issued），别的在页面底部提示一句（changed） */
export type AccountDone = {
  issued: (name: string, result: AccountResult) => void;
  changed: (result: AccountResult, message: string) => void;
};

/** 认得的账号级别（下拉、库里存的都是这几种）；认不得是 undefined */
export const knownLevel = (level: string) => accountLevels.find((l) => l === level);
export const levelName = (level: string) => {
  const known = knownLevel(level);
  return known ? accountLevelNames[known] : level;
};
/** 级别下拉的选项：[级别, 叫法] */
export const levelOptions = Object.entries(accountLevelNames);
const resetText = (name: string, who: string) =>
  `先确认是 ${name} 本人${who}。重置后会生成一个临时密码，原密码立即失效，对方已登录的设备全部下线。`;

/* 账号页各个要先确认的操作。重置密码：按钮和确认窗都叫“重置密码”，结果窗说生成了临时密码。 */

export const resetForRequest = (request: AccountRequestView, done: AccountDone): Confirm => ({
  title: '重置密码',
  text: resetText(request.name, '在申请'),
  action: '重置密码',
  run: async () => done.issued(request.name, await approveRequest(request.id)),
});
export const rejectConfirm = (request: AccountRequestView, done: AccountDone): Confirm => ({
  title: '拒绝申请',
  text:
    request.kind === 'register'
      ? `拒绝 ${request.name} 的账号申请。对方要用账号就得重新申请。`
      : `拒绝 ${request.name} 的忘记密码申请。原密码不变。`,
  action: '拒绝',
  danger: true,
  run: async () => done.changed(await rejectRequest(request.id), '已拒绝 ' + request.name + ' 的申请。'),
});
export const resetConfirm = (user: AccountView, done: AccountDone): Confirm => ({
  title: '重置密码',
  text: resetText(user.name, '要重置'),
  action: '重置密码',
  run: async () => done.issued(user.name, await resetAccountPassword(user.id)),
});
export const disableConfirm = (user: AccountView, done: AccountDone): Confirm => ({
  title: '停用账号',
  text: `停用后 ${user.name} 立即下线，不能再登录。账号和历史记录都保留，可以随时启用。`,
  action: '停用',
  danger: true,
  run: async () => done.changed(await updateAccount(user.id, { disabled: true }), '已停用 ' + user.name + '。'),
});
export const levelConfirm = (user: AccountView, level: AccountLevel, done: AccountDone): Confirm => {
  const to = levelName(level);
  return {
    title: '修改级别',
    text: `把 ${user.name} 从“${levelName(user.level)}”改成“${to}”？确认后立即按新级别的权限办事。`,
    action: '修改级别',
    run: async () => done.changed(await updateAccount(user.id, { level }), user.name + ' 已改为' + to + '。'),
  };
};
