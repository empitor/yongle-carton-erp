import { beijingTime, MoreMenu, TableRegion } from '../ui/index';
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
  return (
    <section className="accounts-section">
      <h2>待处理</h2>
      <TableRegion label="待处理申请">
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>类型</th>
              <th>说明</th>
              <th>提交时间</th>
              <th>来源</th>
              {changing && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>{request.name}</td>
                <td>{request.kind === 'register' ? '申请账号' : '忘记密码'}</td>
                <td className="cell-wrap">{request.note || '—'}</td>
                <td>{beijingTime(request.createdAt, 'short')}</td>
                <td>{request.client}</td>
                {changing && (
                  <td className="accounts-actions">
                    <button type="button" disabled={busy} onClick={() => handle(request)}>
                      {request.kind === 'register' ? '通过并选级别' : '重置密码'}
                    </button>
                    <MoreMenu label={'更多操作 ' + request.name}>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger-text"
                        disabled={busy}
                        onClick={() => reject(request)}
                      >
                        拒绝申请
                      </button>
                    </MoreMenu>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </section>
  );
}

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
      <TableRegion label="账号列表">
        <table>
          <thead>
            <tr>
              <th>用户名</th>
              <th>级别</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={user.id}
                tabIndex={0}
                className={'record-row' + (selectedId === user.id ? ' selected' : '')}
                aria-selected={selectedId === user.id}
                onClick={() => select(user.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) select(user.id);
                }}
              >
                <td>
                  {user.name}
                  {user.id === selfId && <span className="sub"> 当前账号</span>}
                </td>
                <td>{levelName(user.level)}</td>
                <td>{user.disabled ? '已停用' : '正常'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </section>
  );
}
