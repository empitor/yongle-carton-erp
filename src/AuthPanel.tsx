import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Lock, LogOut, Repeat2, ShieldCheck, Users, Wrench } from 'lucide-react';
import ManagementDialog from './ManagementDialog';
import { accountLevelNames, authChanged, managementRequest, signOut, useAuthState, type AuthState } from './session';
import DeveloperEditor from './DeveloperEditor';
import ChangePasswordForm from './ChangePasswordForm';
import { useIsPhone } from './mobile/MobileNav';

type Dialog = 'switch' | 'password' | 'maintenance' | null;

/** 右上角账号菜单。 */
export default function AuthPanel() {
  const session = useAuthState();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false),
    [dialog, setDialog] = useState<Dialog>(null),
    [developerEditor, setDeveloperEditor] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (!session?.actor) return null;
  const actor = session.actor,
    superMode = !!actor.superAdminMode,
    admin = actor.role === 'super_admin',
    pending = session.pendingRequests || 0,
    level = accountLevelNames[session.level || ''] || '';
  const leave = async () => {
    setBusy(true);
    setError('');
    try {
      await signOut();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  const choose = (next: () => void) => () => {
    setOpen(false);
    setError('');
    setNotice('');
    next();
  };
  const panel = open && (
    <div className="account-menu" role="menu" aria-label="账号菜单" ref={menu} data-agent-private>
      <div className="account-menu-head">
        <span className="account-avatar" aria-hidden="true">
          {actor.name.slice(0, 1)}
        </span>
        <span className="account-menu-who">
          <strong>{actor.name}</strong>
          <small>
            {level}
            {actor.developerMode ? ' · 开发者编辑' : superMode && !actor.localAdministrator ? ' · 超级管理员模式' : ''}
          </small>
        </span>
      </div>
      <button type="button" role="menuitem" onClick={choose(() => setDialog('switch'))}>
        <Repeat2 size={16} aria-hidden="true" />
        切换账号
      </button>
      <button type="button" role="menuitem" onClick={choose(() => setDialog('password'))}>
        <Lock size={16} aria-hidden="true" />
        修改密码
      </button>
      {admin && (
        <button
          type="button"
          role="menuitem"
          onClick={choose(() => {
            location.hash = '#accounts';
          })}
        >
          <Users size={16} aria-hidden="true" />
          账号管理
          {pending > 0 && <span className="nav-count">{pending}</span>}
        </button>
      )}
      {admin && (
        <button type="button" role="menuitem" onClick={choose(() => setDialog('maintenance'))}>
          <Wrench size={16} aria-hidden="true" />
          系统维护
        </button>
      )}
      <hr />
      <button type="button" role="menuitem" disabled={busy} onClick={choose(() => void leave())}>
        <LogOut size={16} aria-hidden="true" />
        退出登录
      </button>
    </div>
  );
  return (
    <div className="account-menu-wrap" ref={root}>
      {developerEditor && (actor.developerMode || actor.localAdministrator) && (
        <DeveloperEditor close={() => setDeveloperEditor(false)} />
      )}
      <button
        type="button"
        className={'oi-account' + (superMode ? ' super-account' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={'账号菜单：' + actor.name + (level ? '，' + level : '')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-avatar" aria-hidden="true">
          {actor.name.slice(0, 1)}
        </span>
        <span className="oi-account-name">{actor.name}</span>
        {level && <small className="oi-account-level">{level}</small>}
        {superMode && <ShieldCheck size={14} aria-hidden="true" />}
        {pending > 0 && <span className="account-dot" aria-hidden="true" />}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {panel &&
        (phone
          ? createPortal(
              <>
                <div className="mobile-backdrop account-menu-backdrop" onClick={() => setOpen(false)} />
                {panel}
              </>,
              document.body,
            )
          : panel)}
      {error && !dialog && (
        <ManagementDialog title="操作没有完成" close={() => setError('')}>
          <p className="form-alert" role="alert">
            {error}
          </p>
        </ManagementDialog>
      )}
      {notice && !dialog && (
        <ManagementDialog title="修改密码" close={() => setNotice('')}>
          <p role="status">{notice}</p>
          <div className="management-dialog-actions">
            <button className="primary" onClick={() => setNotice('')}>
              知道了
            </button>
          </div>
        </ManagementDialog>
      )}
      {dialog === 'switch' && (
        <ManagementDialog title="切换账号" close={() => setDialog(null)} busy={busy}>
          <p>会退出 {actor.name}，回到登录页选择账号并输入密码。没有保存的内容会丢失。</p>
          {error && (
            <p className="form-alert" role="alert">
              {error}
            </p>
          )}
          <div className="management-dialog-actions">
            <button disabled={busy} onClick={() => setDialog(null)}>
              取消
            </button>
            <button className="primary" disabled={busy} onClick={() => void leave()}>
              {busy ? '正在退出…' : '切换账号'}
            </button>
          </div>
        </ManagementDialog>
      )}
      {dialog === 'password' && (
        <ManagementDialog title="修改密码" close={() => setDialog(null)}>
          <ChangePasswordForm
            onDone={() => {
              setDialog(null);
              setNotice('密码已修改，其他设备需要重新登录。');
            }}
          />
        </ManagementDialog>
      )}
      {dialog === 'maintenance' && (
        <ManagementDialog title="系统维护" close={() => setDialog(null)} busy={busy}>
          <Maintenance
            session={session}
            busy={busy}
            setBusy={setBusy}
            close={() => setDialog(null)}
            openEditor={() => {
              setDialog(null);
              setDeveloperEditor(true);
            }}
          />
        </ManagementDialog>
      )}
    </div>
  );
}

/** 只给管理员：本机数据管理、开发者编辑模式、超级管理员模式。 */
function Maintenance({
  session,
  busy,
  setBusy,
  close,
  openEditor,
}: {
  session: AuthState;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  close: () => void;
  openEditor: () => void;
}) {
  const actor = session.actor!,
    superMode = !!actor.superAdminMode;
  const [password, setPassword] = useState(''),
    [error, setError] = useState('');
  const showDeveloper = !actor.localAdministrator && session.developerAvailable;
  const showSuper = !actor.localAdministrator && !actor.developerMode;
  return (
    <>
      {actor.localAdministrator && (
        <div className="super-access-panel">
          <h3>本机数据管理</h3>
          <p>登录期间直接管理全部业务数据。编辑同步维护关联；归档可恢复；删除实际移除数据库记录。</p>
          <button onClick={openEditor}>打开数据管理</button>
        </div>
      )}
      {showDeveloper && (
        <div className="super-access-panel">
          <h3>开发者编辑模式 · {actor.developerMode ? '已开启' : '未开启'}</h3>
          <p>仅本机开发会话；关闭或重启后恢复正常限制。允许测试数据维护，保留库存流水、关联校验及操作日志。</p>
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
              } catch (failure) {
                setError((failure as Error).message);
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
          {actor.developerMode && <button onClick={openEditor}>打开开发者数据维护</button>}
        </div>
      )}
      {showSuper && (
        <div className="super-access-panel">
          <h3>
            <ShieldCheck size={18} aria-hidden="true" /> 超级管理员模式
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
              } catch (failure) {
                setError((failure as Error).message);
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
              {busy ? '正在验证…' : superMode ? '退出超级管理员模式' : '验证并进入超级管理员模式'}
            </button>
          </form>
        </div>
      )}
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
