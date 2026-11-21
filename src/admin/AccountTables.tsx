import { beijingTime, DataTable, MenuItem, MoreMenu, type Col } from '../ui/index';
import { levelName } from './account-confirms';
import type { AccountRequestView, AccountView } from '../../shared/core/index';

/** 待处理申请：没进超级管理员模式（changing 为 false）时没有“操作”列。 */
export function RequestTable({
  requests,
  changing,
  busy,
  handle,
  reject,
}: {
  requests: AccountRequestView[];
  changing: boolean;
  busy: boolean;
  handle: (request: AccountRequestView) => void;
  reject: (request: AccountRequestView) => void;
}) {
  const cols: Col<AccountRequestView>[] = [
    { key: 'name', label: '用户名', render: (r) => r.name },
    { key: 'kind', label: '类型', render: (r) => (r.kind === 'register' ? '申请账号' : '忘记密码') },
    { key: 'note', label: '说明', wrap: true, render: (r) => r.note || '—' },
    { key: 'createdAt', label: '提交时间', render: (r) => beijingTime(r.createdAt, 'short') },
    { key: 'client', label: '来源', render: (r) => r.client },
  ];
  if (changing)
    cols.push({
      key: 'actions',
      label: '操作',
      cellClass: 'accounts-actions',
      render: (request) => (
        <>
          <button type="button" disabled={busy} onClick={() => handle(request)}>
            {request.kind === 'register' ? '通过并选级别' : '重置密码'}
          </button>
          <MoreMenu label={'更多操作 ' + request.name}>
            <MenuItem danger disabled={busy} onClick={() => reject(request)}>
              拒绝申请
            </MenuItem>
          </MoreMenu>
        </>
      ),
    });
  return (
    <section className="accounts-section">
      <h2>待处理</h2>
      <DataTable label="待处理申请" cols={cols} rows={requests} empty={null} />
    </section>
  );
}

const accountCols = (selfId: string): Col<AccountView>[] => [
  {
    key: 'name',
    label: '用户名',
    render: (user) => (
      <>
        {user.name}
        {user.id === selfId && <span className="sub"> 当前账号</span>}
      </>
    ),
  },
  { key: 'level', label: '级别', render: (user) => levelName(user.level) },
  { key: 'disabled', label: '状态', render: (user) => (user.disabled ? '已停用' : '正常') },
];

/** 账号列表：点一行（或回车）在右侧打开详情。 */
export function AccountTable({
  users,
  selfId,
  selectedId,
  select,
}: {
  users: AccountView[];
  selfId: string;
  selectedId: string;
  select: (id: string) => void;
}) {
  return (
    <section className="accounts-section">
      <h2>账号</h2>
      <DataTable
        label="账号列表"
        cols={accountCols(selfId)}
        rows={users}
        onRow={(user) => select(user.id)}
        selected={selectedId}
        empty={null}
      />
    </section>
  );
}
