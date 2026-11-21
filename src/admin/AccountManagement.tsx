import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ConfirmDialog, FormMessage, ListSummary, PageHeading, SuperModeNotice, useAuthState } from '../ui/index';
import { ApproveDialog, CreateDialog, TemporaryPassword } from './AccountDialogs';
import type { AccountRequestView } from '../../shared/core/index';
import AccountDetail from './AccountDetail';
import { AccountTable, RequestTable } from './AccountTables';
import { useAccounts } from './useAccounts';

/** 账号管理：待处理申请、账号列表、右侧账号详情。数据和动作在 useAccounts。 */
export default function AccountManagement({
  selfId,
  isAdmin,
  pending,
}: {
  selfId: string;
  isAdmin: boolean;
  pending: number;
}) {
  const accounts = useAccounts(isAdmin, pending);
  const [selectedId, setSelectedId] = useState(''),
    [approving, setApproving] = useState<AccountRequestView | null>(null),
    [creating, setCreating] = useState(false);
  // 增改账号、处理申请要在超级管理员模式里（本机管理员一直算在模式里）；没进时只能看，顶上给入口
  const changing = !!useAuthState()?.actor?.superAdminMode;
  if (!isAdmin) return <FormMessage>只有管理员能管理账号。</FormMessage>;
  const { users, requests, loaded, busy, error, confirm, temporary } = accounts;
  const selected = users.find((u) => u.id === selectedId) || null;
  const count = (n: number) => (loaded ? n : '—');
  return (
    <div className="accounts-page" data-agent-private>
      <PageHeading
        title="账号管理"
        meta={
          <ListSummary
            items={[
              { label: '待处理', value: count(requests.length) },
              { label: '账号', value: count(users.length) },
              { label: '已停用', value: count(users.filter((u) => u.disabled).length) },
            ]}
          />
        }
        primary={
          changing && { label: '新建账号', icon: <Plus size={15} aria-hidden="true" />, onClick: () => setCreating(true) }
        }
      />
      <SuperModeNotice what="新建和修改账号、处理申请" />
      {!selected && !confirm && error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}
      {requests.length > 0 && (
        <RequestTable
          requests={requests}
          changing={changing}
          busy={busy}
          handle={(request) => {
            accounts.clear();
            if (request.kind === 'register') setApproving(request);
            else accounts.resetForRequest(request);
          }}
          reject={accounts.reject}
        />
      )}
      <AccountTable
        users={users}
        selfId={selfId}
        selectedId={selectedId}
        select={(id) => {
          accounts.clear();
          setSelectedId(id);
        }}
      />
      {selected && (
        <AccountDetail
          user={selected}
          selfId={selfId}
          changing={changing}
          accounts={accounts}
          close={() => setSelectedId('')}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.action}
          danger={confirm.danger}
          busy={busy}
          error={error}
          close={accounts.closeConfirm}
          onConfirm={accounts.runConfirm}
        >
          <p>{confirm.text}</p>
        </ConfirmDialog>
      )}
      {temporary && (
        <TemporaryPassword name={temporary.name} password={temporary.password} close={accounts.closeTemporary} />
      )}
      {approving && (
        <ApproveDialog
          request={approving}
          close={() => setApproving(null)}
          done={(result, name) => {
            setApproving(null);
            accounts.done.changed(result, '已通过申请，账号 ' + name + ' 可以登录了。');
          }}
        />
      )}
      {creating && (
        <CreateDialog
          close={() => setCreating(false)}
          done={(result, name) => {
            setCreating(false);
            accounts.done.changed(result, '已新建账号 ' + name + '。');
          }}
        />
      )}
    </div>
  );
}
