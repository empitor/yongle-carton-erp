import { useEffect, useState } from 'react';
import { managementRequest } from './session';

const levelNames: Record<string, string> = {
  admin: '管理员',
  staff: '业务人员',
  viewer: '只读',
};
type Account = { id: string; name: string; level: string; disabled: boolean };

export function ChangePassword() {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details className="account-section">
      <summary>修改密码</summary>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage('');
          try {
            await managementRequest('/auth/password', { current, password: next });
            setCurrent('');
            setNext('');
            setMessage('密码已修改，其他设备需要重新登录。');
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          当前密码
          <input
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          新密码（至少12位）
          <input
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        {message && <p role="status">{message}</p>}
        <button disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</button>
      </form>
    </details>
  );
}

export function AccountManagement({ selfId }: { selfId: string }) {
  const [users, setUsers] = useState<Account[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [level, setLevel] = useState('staff'),
    [resetting, setResetting] = useState<Account | null>(null),
    [resetPassword, setResetPassword] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    managementRequest<{ users: Account[] }>('/auth/users')
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
  }, []);
  const run = async (job: () => Promise<{ users?: Account[] } | unknown>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = (await job()) as { users?: Account[] };
      if (result?.users) setUsers(result.users);
      setNotice(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="account-section">
      <summary>账号管理（{users.length}）</summary>
      <table className="account-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>级别</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name}
                {u.id === selfId ? '（当前）' : ''}
              </td>
              <td>
                <select
                  aria-label={'设置' + u.name + '的级别'}
                  disabled={busy}
                  value={u.level}
                  onChange={(e) =>
                    void run(
                      () => managementRequest('/auth/users/' + u.id, { level: e.target.value }, 'PUT'),
                      '已修改级别',
                    )
                  }
                >
                  {Object.entries(levelNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td>{u.disabled ? '已停用' : '正常'}</td>
              <td className="account-actions">
                <button type="button" disabled={busy} onClick={() => setResetting(u)}>
                  重置密码
                </button>
                <button
                  type="button"
                  disabled={busy || u.id === selfId}
                  onClick={() =>
                    void run(
                      () =>
                        managementRequest('/auth/users/' + u.id, { disabled: !u.disabled }, 'PUT'),
                      u.disabled ? '已启用' : '已停用，该账号已下线',
                    )
                  }
                >
                  {u.disabled ? '启用' : '停用'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {resetting && (
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(
              () =>
                managementRequest('/auth/users/' + resetting.id + '/password', {
                  password: resetPassword,
                }),
              '已重置' + resetting.name + '的密码，其旧登录已失效。',
            );
            if (ok) {
              setResetting(null);
              setResetPassword('');
            }
          }}
        >
          <label>
            {resetting.name} 的新密码（至少12位）
            <input
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
            />
          </label>
          <button disabled={busy}>确认重置</button>
        </form>
      )}
      <form
        className="auth-form account-create"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(
            () => managementRequest('/auth/users', { name, password, level }),
            '账号已建立',
          );
          if (ok) {
            setName('');
            setPassword('');
          }
        }}
      >
        <label>
          新账号用户名
          <input
            required
            maxLength={60}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          初始密码（至少12位）
          <input
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          级别
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {Object.entries(levelNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy}>建立账号</button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="operation-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
