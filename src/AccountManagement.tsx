import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import ManagementDialog from './ManagementDialog';
import { accountLevelNames, authChanged, managementRequest } from './session';
import DetailPanel from './ui/DetailPanel';
import { ListSummary, PageHeading, TableRegion } from './ui/ListLayout';
import PasswordField from './ui/PasswordField';

type Account = { id: string; name: string; level: string; disabled: boolean };
type AccountRequest = {
  id: string;
  kind: 'register' | 'reset';
  name: string;
  note: string;
  client: string;
  createdAt: string;
  nameTaken: boolean;
};
type Confirm = { title: string; text: string; action: string; danger?: boolean; run: () => Promise<void> };

const levelOptions = Object.entries(accountLevelNames);
const when = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

function TemporaryPassword({ name, password, close }: { name: string; password: string; close: () => void }) {
  const [copied, setCopied] = useState('');
  return (
    <ManagementDialog title="临时密码" close={close}>
      <div className="temp-password-body" data-agent-private>
        <p>
          告诉 {name}。这个密码只显示这一次，24 小时内有效，对方登录后必须先改掉。
        </p>
        <code className="temp-password">{password}</code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied('已复制');
            } catch {
              setCopied('浏览器不允许复制，请手动选中');
            }
          }}
        >
          <Copy size={15} aria-hidden="true" />
          复制
        </button>
        {copied && <span role="status">{copied}</span>}
      </div>
      <div className="management-dialog-actions">
        <button className="primary" onClick={close}>
          完成
        </button>
      </div>
    </ManagementDialog>
  );
}

export default function AccountManagement({
  selfId,
  isAdmin,
  pending,
}: {
  selfId: string;
  isAdmin: boolean;
  pending: number;
}) {
  const [users, setUsers] = useState<Account[]>([]),
    [requests, setRequests] = useState<AccountRequest[]>([]),
    [loaded, setLoaded] = useState(false),
    [selectedId, setSelectedId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<Confirm | null>(null),
    [temporary, setTemporary] = useState<{ name: string; password: string } | null>(null),
    [approving, setApproving] = useState<AccountRequest | null>(null),
    [creating, setCreating] = useState(false);
  const refresh = useCallback(async () => {
    const [accounts, list] = await Promise.all([
      managementRequest<{ users: Account[] }>('/auth/users'),
      managementRequest<{ requests: AccountRequest[] }>('/auth/requests'),
    ]);
    setUsers(accounts.users);
    setRequests(list.requests);
    setLoaded(true);
  }, []);
  // pending 来自定时刷新的登录状态：有新申请时这里跟着更新。
  useEffect(() => {
    if (isAdmin) refresh().catch((failure) => setError(failure.message));
  }, [isAdmin, pending, refresh]);
  if (!isAdmin)
    return (
      <div className="error" role="alert">
        只有管理员能管理账号。
      </div>
    );
  const apply = (result: { users?: Account[]; requests?: AccountRequest[] }) => {
    if (result.users) setUsers(result.users);
    if (result.requests) setRequests(result.requests);
    authChanged();
  };
  /** 操作失败时错误留在页面上，不让人以为成功了。 */
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await job();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const selected = users.find((u) => u.id === selectedId) || null;
  const disabledCount = users.filter((u) => u.disabled).length;
  const issueForRequest = (request: AccountRequest) =>
    setConfirm({
      title: '生成临时密码',
      text: `先确认是 ${request.name} 本人在申请。生成后原密码立即失效，对方已登录的设备全部下线。`,
      action: '生成临时密码',
      run: async () => {
        const result = await managementRequest('/auth/requests/' + request.id + '/approve', {});
        apply(result);
        setTemporary({ name: request.name, password: result.temporaryPassword });
      },
    });
  const reject = (request: AccountRequest) =>
    setConfirm({
      title: '拒绝申请',
      text:
        request.kind === 'register'
          ? `拒绝 ${request.name} 的账号申请。对方要用账号就得重新申请。`
          : `拒绝 ${request.name} 的忘记密码申请。原密码不变。`,
      action: '拒绝',
      danger: true,
      run: async () => apply(await managementRequest('/auth/requests/' + request.id + '/reject', {})),
    });
  const message = error && (
    <p className="form-alert" role="alert">
      {error}
    </p>
  );
  return (
    <div className="accounts-page" data-agent-private>
      <PageHeading
        title="账号管理"
        meta={
          <ListSummary
            items={[
              { label: '待处理', value: loaded ? requests.length : '—' },
              { label: '账号', value: loaded ? users.length : '—' },
              { label: '已停用', value: loaded ? disabledCount : '—' },
            ]}
          />
        }
        actions={
          <button className="primary" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" />
            建立账号
          </button>
        }
      />
      {!selected && !confirm && message}
      {requests.length > 0 && (
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
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td>{request.name}</td>
                    <td>{request.kind === 'register' ? '申请账号' : '忘记密码'}</td>
                    <td className="cell-wrap">{request.note || '—'}</td>
                    <td>{when(request.createdAt)}</td>
                    <td>{request.client}</td>
                    <td className="accounts-actions">
                      <button type="button" disabled={busy} onClick={() => reject(request)}>
                        拒绝
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setError('');
                          if (request.kind === 'register') setApproving(request);
                          else issueForRequest(request);
                        }}
                      >
                        {request.kind === 'register' ? '通过并选级别' : '生成临时密码'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableRegion>
        </section>
      )}
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
                  onClick={() => {
                    setError('');
                    setSelectedId(user.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target === e.currentTarget) setSelectedId(user.id);
                  }}
                >
                  <td>
                    {user.name}
                    {user.id === selfId && <span className="sub"> 当前账号</span>}
                  </td>
                  <td>{accountLevelNames[user.level] || user.level}</td>
                  <td>{user.disabled ? '已停用' : '正常'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      </section>

      {selected && (
        <DetailPanel
          title={selected.name}
          status={<span className="record-state">{selected.disabled ? '已停用' : '正常'}</span>}
          close={() => setSelectedId('')}
          actions={
            selected.id === selfId ? undefined : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      title: '重置密码',
                      text: `先确认是 ${selected.name} 本人要重置。生成后原密码立即失效，对方已登录的设备全部下线。`,
                      action: '生成临时密码',
                      run: async () => {
                        const result = await managementRequest('/auth/users/' + selected.id + '/password', {});
                        apply(result);
                        setTemporary({ name: selected.name, password: result.temporaryPassword });
                      },
                    })
                  }
                >
                  重置密码
                </button>
                <button
                  type="button"
                  className={selected.disabled ? '' : 'danger-text'}
                  disabled={busy}
                  onClick={() =>
                    selected.disabled
                      ? void run(async () =>
                          apply(await managementRequest('/auth/users/' + selected.id, { disabled: false }, 'PUT')),
                        )
                      : setConfirm({
                          title: '停用账号',
                          text: `停用后 ${selected.name} 立即下线，不能再登录。账号和历史记录都保留，可以随时启用。`,
                          action: '停用',
                          danger: true,
                          run: async () =>
                            apply(await managementRequest('/auth/users/' + selected.id, { disabled: true }, 'PUT')),
                        })
                  }
                >
                  {selected.disabled ? '启用' : '停用'}
                </button>
              </>
            )
          }
        >
          <div data-agent-private className="accounts-detail">
            <label>
              级别
              <select
                disabled={busy}
                value={selected.level}
                onChange={(e) => {
                  const level = e.target.value;
                  void run(async () =>
                    apply(await managementRequest('/auth/users/' + selected.id, { level }, 'PUT')),
                  );
                }}
              >
                {levelOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {selected.id === selfId && <p className="sub">自己的密码在右上角菜单修改。</p>}
            {!confirm && message}
          </div>
        </DetailPanel>
      )}

      {confirm && (
        <ManagementDialog title={confirm.title} close={() => setConfirm(null)} busy={busy} danger={confirm.danger}>
          <p>{confirm.text}</p>
          {message}
          <div className="management-dialog-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              className={confirm.danger ? 'danger' : 'primary'}
              disabled={busy}
              onClick={async () => {
                if (await run(confirm.run)) setConfirm(null);
              }}
            >
              {busy ? '正在处理…' : confirm.action}
            </button>
          </div>
        </ManagementDialog>
      )}
      {temporary && (
        <TemporaryPassword
          name={temporary.name}
          password={temporary.password}
          close={() => setTemporary(null)}
        />
      )}
      {approving && (
        <ApproveDialog
          request={approving}
          close={() => setApproving(null)}
          done={(result) => {
            apply(result);
            setApproving(null);
          }}
        />
      )}
      {creating && (
        <CreateDialog
          close={() => setCreating(false)}
          done={(result) => {
            apply(result);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

type Result = { users?: Account[]; requests?: AccountRequest[] };

function LevelSelect({ value, change }: { value: string; change: (value: string) => void }) {
  return (
    <label>
      级别
      <select required value={value} onChange={(e) => change(e.target.value)}>
        <option value="" disabled>
          请选择
        </option>
        {levelOptions.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ApproveDialog({
  request,
  close,
  done,
}: {
  request: AccountRequest;
  close: () => void;
  done: (result: Result) => void;
}) {
  const [name, setName] = useState(request.name),
    [level, setLevel] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <ManagementDialog title="通过账号申请" close={close} busy={busy}>
      <p>任何人都能填别人的名字，请先线下确认申请人是谁。</p>
      <dl className="record-detail-grid">
        <div>
          <dt>说明</dt>
          <dd>{request.note || '—'}</dd>
        </div>
        <div>
          <dt>提交时间</dt>
          <dd>{when(request.createdAt)}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{request.client}</dd>
        </div>
      </dl>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            done(await managementRequest('/auth/requests/' + request.id + '/approve', { name, level }));
          } catch (failure) {
            setError((failure as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          用户名
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {request.nameTaken && name === request.name && (
          <p className="form-alert" role="alert">
            这个用户名已经有人用了，请改一个。
          </p>
        )}
        <LevelSelect value={level} change={setLevel} />
        {error && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在处理…' : '通过'}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}

function CreateDialog({ close, done }: { close: () => void; done: (result: Result) => void }) {
  const [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [level, setLevel] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <ManagementDialog title="建立账号" close={close} busy={busy}>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            done(await managementRequest('/auth/users', { name, password, level }));
          } catch (failure) {
            setError((failure as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          用户名
          <input
            required
            autoFocus
            maxLength={60}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <PasswordField
          label="初始密码"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          rule
        />
        <LevelSelect value={level} change={setLevel} />
        {error && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在建立…' : '建立账号'}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
