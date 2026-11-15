import { useEffect, useState } from 'react';
import { errorMessage, type AccountRequestView, type AccountView } from '../../shared/core/index';
import { authChanged, notify, useAction } from '../ui/index';
import { readAccountRequests, readAccounts, updateAccount, type AccountResult } from './account-api';
import {
  disableConfirm,
  knownLevel,
  levelConfirm,
  rejectConfirm,
  resetConfirm,
  resetForRequest,
  type AccountDone,
  type Confirm,
} from './account-confirms';

/**
 * 账号管理的数据和动作：账号、待处理申请两张表，审批、拒绝、启停、重置密码、改级别。
 * pending 来自定时刷新的登录状态：有新申请时跟着重读。操作失败时原因留在页面上，不让人以为成功了。
 */
export function useAccounts(isAdmin: boolean, pending: number) {
  const [users, setUsers] = useState<AccountView[]>([]),
    [requests, setRequests] = useState<AccountRequestView[]>([]),
    [loaded, setLoaded] = useState(false),
    [loadError, setLoadError] = useState(''),
    [confirm, setConfirm] = useState<Confirm | null>(null),
    [temporary, setTemporary] = useState<{ name: string; password: string } | null>(null);
  const action = useAction();
  useEffect(() => {
    if (!isAdmin) return;
    Promise.all([readAccounts(), readAccountRequests()])
      .then(([accounts, list]) => {
        setUsers(accounts.users);
        setRequests(list.requests);
        setLoaded(true);
      })
      .catch((failure: unknown) => setLoadError(errorMessage(failure)));
  }, [isAdmin, pending]);
  const apply = (result: AccountResult) => {
    if (result.users) setUsers(result.users);
    if (result.requests) setRequests(result.requests);
    authChanged();
  };
  const done: AccountDone = {
    issued: (name, result) => {
      apply(result);
      setTemporary({ name, password: result.temporaryPassword || '' });
    },
    changed: (result, message) => {
      apply(result);
      notify(message);
    },
  };
  const clear = () => {
    action.clear();
    setLoadError('');
  };
  return {
    users,
    requests,
    loaded,
    busy: action.busy,
    error: action.error || loadError,
    clear,
    done,
    confirm,
    closeConfirm: () => setConfirm(null),
    /** 确认窗点了确认：办成了才关窗（确认窗只在有待确认的一步时打开） */
    runConfirm: () =>
      action.run(async () => {
        if (!confirm) return;
        await confirm.run();
        setConfirm(null);
      }),
    temporary,
    closeTemporary: () => setTemporary(null),
    resetForRequest: (request: AccountRequestView) => setConfirm(resetForRequest(request, done)),
    reject: (request: AccountRequestView) => setConfirm(rejectConfirm(request, done)),
    enable: (user: AccountView) =>
      void action.run(async () =>
        done.changed(await updateAccount(user.id, { disabled: false }), '已启用 ' + user.name + '。'),
      ),
    resetPassword: (user: AccountView) => setConfirm(resetConfirm(user, done)),
    disable: (user: AccountView) => setConfirm(disableConfirm(user, done)),
    /** 下拉里选了别的级别：先确认（下拉里只有认得的几种） */
    changeLevel: (user: AccountView, level: string) => {
      const next = knownLevel(level);
      if (!next || next === user.level) return;
      clear();
      setConfirm(levelConfirm(user, next, done));
    },
  };
}
export type AccountsState = ReturnType<typeof useAccounts>;
