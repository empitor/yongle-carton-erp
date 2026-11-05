import { useState } from 'react';
import { ShieldCheck, LogOut } from 'lucide-react';
import ManagementDialog from './ManagementDialog';
import { authChanged, managementRequest, useAuthState } from './session';
import DeveloperEditor from './DeveloperEditor';
import { AccountManagement, ChangePassword } from './AccountManagement';
export default function AuthPanel() {
  const session = useAuthState();
  const [developerEditor, setDeveloperEditor] = useState(false);
  const [open, setOpen] = useState(false),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (!session) return null;
  const actor = session.actor,
    superMode = !!actor?.superAdminMode;
  const close = () => {
    setOpen(false);
    setPassword('');
    setError('');
  };
  const role = actor?.role === 'super_admin' ? '超级管理员' : '管理员';
  return (
    <>
      {developerEditor && (actor?.developerMode || actor?.localAdministrator) && (
        <DeveloperEditor close={() => setDeveloperEditor(false)} />
      )}
      <button
        className={'oi-account' + (superMode ? ' super-account' : '')}
        onClick={() => setOpen(true)}
      >
        {superMode && <ShieldCheck size={15} />}{' '}
        {actor
          ? (actor.developerMode ? '开发者编辑 · ' : role + '：') + actor.name
          : session.configured
            ? '登录管理账号'
            : '建立管理账号'}
      </button>
      {open && (
        <ManagementDialog
          title={actor ? '账号与权限' : session.configured ? '登录管理账号' : '建立本机管理账号'}
          close={close}
          busy={busy}
        >
          {actor ? (
            <>
              {actor.localAdministrator && (
                <div className="super-access-panel">
                  <h3>本机数据管理</h3>
                  <p>
                    登录期间直接管理全部业务数据。编辑同步维护关联；归档可恢复；删除实际移除数据库记录。
                  </p>
                  <button
                    onClick={() => {
                      setOpen(false);
                      setDeveloperEditor(true);
                    }}
                  >
                    打开数据管理
                  </button>
                </div>
              )}
              {!actor.localAdministrator &&
                actor.role === 'super_admin' &&
                session.developerAvailable && (
                  <div className="super-access-panel">
                    <h3>开发者编辑模式 · {actor.developerMode ? '已开启' : '未开启'}</h3>
                    <p>
                      仅本机开发会话；关闭或重启后恢复正常限制。允许测试数据维护，保留库存流水、关联校验及操作日志。
                    </p>
                    <form
                      className="auth-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setBusy(true);
                        setError('');
                        try {
                          await managementRequest('/auth/developer-mode', {
                            enabled: !actor.developerMode,
                            ...(!superMode && !actor.developerMode ? { password } : {}),
                          });
                          setPassword('');
                          authChanged();
                          close();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {!actor.developerMode && !superMode && (
                        <label>
                          验证当前账号密码
                          <input
                            aria-label="开发者模式验证密码"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                          />
                        </label>
                      )}
                      <button className="primary" disabled={busy}>
                        {actor.developerMode ? '关闭开发者编辑模式' : '开启开发者编辑模式'}
                      </button>
                    </form>
                    {actor.developerMode && (
                      <button
                        onClick={() => {
                          setOpen(false);
                          setDeveloperEditor(true);
                        }}
                      >
                        打开开发者数据维护
                      </button>
                    )}
                  </div>
                )}
              <h3>
                {actor.name} <span className="record-state">{role}</span>
              </h3>
              <p>
                {actor.localAdministrator
                  ? '本机最高管理员已获得完整业务管理权限，登录会话8小时有效。'
                  : '登录会话8小时有效。额外管理权限沿用当前账号的授权范围。'}
              </p>
              {!actor.localAdministrator &&
                actor.role === 'super_admin' &&
                !actor.developerMode && (
                  <div className="super-access-panel">
                    <h3>
                      <ShieldCheck size={18} /> 超级管理员模式
                    </h3>
                    <p>
                      {superMode
                        ? '已开启，可维护归档记录及永久删除。有效至 ' +
                          new Date(actor.superAdminUntil!).toLocaleTimeString('zh-CN')
                        : '当前为常规管理。输入现有账号密码，临时开启15分钟的额外权限。'}
                    </p>
                    <form
                      className="auth-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setBusy(true);
                        setError('');
                        try {
                          await managementRequest(
                            '/auth/super-admin/' + (superMode ? 'exit' : 'enter'),
                            superMode ? {} : { password },
                          );
                          authChanged();
                          close();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setPassword('');
                          setBusy(false);
                        }
                      }}
                    >
                      {!superMode && (
                        <label>
                          当前账号密码
                          <input
                            type="password"
                            required
                            maxLength={128}
                            autoComplete="current-password"
                            aria-label="验证超级管理员密码"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                          />
                        </label>
                      )}
                      <button className={superMode ? '' : 'primary'} disabled={busy}>
                        {busy
                          ? '正在验证…'
                          : superMode
                            ? '退出超级管理员模式'
                            : '验证并进入超级管理员模式'}
                      </button>
                    </form>
                  </div>
                )}
              <ChangePassword />
              {actor.role === 'super_admin' && <AccountManagement selfId={actor.id} />}
              {error && (
                <p className="operation-error" role="alert">
                  {error}
                </p>
              )}
              <div className="management-dialog-actions">
                <button disabled={busy} onClick={close}>
                  返回系统
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await managementRequest('/auth/logout', {});
                      authChanged();
                      location.reload();
                    } catch (e) {
                      setError((e as Error).message);
                      setBusy(false);
                    }
                  }}
                >
                  <LogOut size={15} />
                  退出管理账号
                </button>
              </div>
            </>
          ) : (
            <LoginForm configured={session.configured} csrf={session.csrf} />
          )}
        </ManagementDialog>
      )}
    </>
  );
}

/** 登录页与账号菜单共用的登录/首次建号表单。 */
export function LoginForm({ configured, csrf }: { configured: boolean; csrf: string }) {
  const [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!configured && password !== repeat) {
          setError('两次密码不一致');
          return;
        }
        setBusy(true);
        setError('');
        try {
          const r = await fetch('/api/auth/' + (configured ? 'login' : 'setup'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-ERP-Auth-Token': csrf,
            },
            body: JSON.stringify({ name, password }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.message);
          setPassword('');
          authChanged();
          location.reload();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        用户名
        <input
          autoComplete="username"
          aria-label="核对用户名"
          required
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        密码
        <input
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete={configured ? 'current-password' : 'new-password'}
          aria-label="核对密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {!configured && (
        <label>
          再次输入密码
          <input
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            aria-label="再次输入核对密码"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="operation-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? '正在验证…' : configured ? '登录' : '建立管理账号'}
      </button>
    </form>
  );
}
