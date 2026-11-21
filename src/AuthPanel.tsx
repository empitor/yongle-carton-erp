import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Database, Lock, LogOut, ShieldCheck, Wrench } from 'lucide-react';
import { accountLevelNames, errorMessage } from '../shared/core/index';
import { DataManagementEditorSlot, ManagementDialog } from './ui/index';
import { useAuthState, type AuthState } from './ui/index';
import { signOut } from './auth-api';
import ChangePasswordForm from './ChangePasswordForm';
import { useBackLayer, useIsPhone } from './ui/index';
import { EditorFooter, FormMessage } from './ui/index';
import { MaintenancePanel } from './admin/index';
import ThemeSwitcher from './ThemeSwitcher';
import { listen, MenuItem, notify } from './ui/index';

type Dialog = 'password' | 'maintenance' | null;
type Actor = NonNullable<AuthState['actor']>;

/**
 * 右上角账号菜单：改密码、外观（主题）、数据管理或系统维护、退出登录。
 * 账号管理在侧栏；换账号就是退出登录后在登录页选。
 */
export default function AuthPanel() {
  const session = useAuthState();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false),
    [dialog, setDialog] = useState<Dialog>(null),
    [dataManagementOpen, setDataManagementEditor] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null);
  // 页面上“进入超级管理员模式”的入口（SuperModeNotice）打开的也是这里的系统维护窗口
  useEffect(() => listen('erp-open-maintenance', () => setDialog('maintenance')), []);
  useCloseOutside(open, () => setOpen(false), [root, menu]);
  // 安卓 App 的返回键：账号菜单开着时先收起菜单（手机上和点底一样）
  useBackLayer(() => setOpen(false), { active: open });
  if (!session?.actor) return null;
  const actor = session.actor,
    level = session.level ? accountLevelNames[session.level] : '';
  const leave = async () => {
    setBusy(true);
    setError('');
    try {
      await signOut();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  const choose = (next: () => void) => () => {
    setOpen(false);
    setError('');
    next();
  };
  const panel = open && (
    <AccountMenu
      menu={menu}
      actor={actor}
      level={level}
      busy={busy}
      password={choose(() => setDialog('password'))}
      dataManagement={choose(() => setDataManagementEditor(true))}
      maintenance={choose(() => setDialog('maintenance'))}
      leave={choose(() => void leave())}
    />
  );
  return (
    <div className="account-menu-wrap" ref={root}>
      {dataManagementOpen && actor.localAdministrator && (
        <DataManagementEditorSlot close={() => setDataManagementEditor(false)} />
      )}
      <AccountButton
        actor={actor}
        level={level}
        open={open}
        pending={session.pendingRequests || 0}
        toggle={() => setOpen((v) => !v)}
      />
      {panel && (phone ? <PhoneMenu close={() => setOpen(false)}>{panel}</PhoneMenu> : panel)}
      {error && !dialog && <FailureDialog error={error} close={() => setError('')} />}
      {dialog === 'password' && <PasswordDialog name={actor.name} close={() => setDialog(null)} />}
      {dialog === 'maintenance' && (
        // 系统维护窗口自带外壳和底栏（只有超级管理员模式这一件事）
        <MaintenancePanel session={session} busy={busy} setBusy={setBusy} close={() => setDialog(null)} />
      )}
    </div>
  );
}

/** 开着的时候点这几块外面、按 Esc 就关 */
function useCloseOutside(open: boolean, close: () => void, inside: RefObject<HTMLElement | null>[]) {
  const latest = useRef({ close, inside });
  useEffect(() => {
    latest.current = { close, inside };
  });
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!latest.current.inside.some((ref) => ref.current?.contains(target))) latest.current.close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current.close();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
}

/** 顶栏上的账号按钮：头像、名字、级别，超级管理员模式的盾牌，有待处理申请时的小红点 */
function AccountButton(props: { actor: Actor; level: string; open: boolean; pending: number; toggle: () => void }) {
  const { actor, level, open, pending, toggle } = props;
  const superMode = !!actor.superAdminMode;
  return (
    <button
      type="button"
      className={'oi-account' + (superMode ? ' super-account' : '')}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={'账号菜单：' + [actor.name.slice(0, 1), actor.name, level].filter(Boolean).join(' ')}
      onClick={toggle}
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
  );
}

type MenuProps = {
  menu: RefObject<HTMLDivElement | null>;
  actor: Actor;
  level: string;
  busy: boolean;
  password: () => void;
  dataManagement: () => void;
  maintenance: () => void;
  leave: () => void;
};

/** 点开的账号菜单 */
function AccountMenu({ menu, actor, level, busy, password, dataManagement, maintenance, leave }: MenuProps) {
  const admin = actor.role === 'super_admin';
  return (
    <div className="account-menu" role="menu" aria-label="账号菜单" ref={menu} data-agent-private>
      <div className="account-menu-head">
        <span className="account-avatar" aria-hidden="true">
          {actor.name.slice(0, 1)}
        </span>
        <span className="account-menu-who">
          <strong>{actor.name}</strong>
          <small>
            {level}
            {actor.superAdminMode && !actor.localAdministrator ? ' · 超级管理员模式' : ''}
          </small>
        </span>
      </div>
      <MenuItem onClick={password}>
        <Lock size={16} aria-hidden="true" />
        修改密码
      </MenuItem>
      {/* 在服务器本机：直接打开数据管理，不再先弹一个只有一个按钮的窗口 */}
      {admin && actor.localAdministrator && (
        <MenuItem onClick={dataManagement}>
          <Database size={16} aria-hidden="true" />
          数据管理
        </MenuItem>
      )}
      {admin && !actor.localAdministrator && (
        <MenuItem onClick={maintenance}>
          <Wrench size={16} aria-hidden="true" />
          系统维护
        </MenuItem>
      )}
      <div className="account-menu-theme">
        <span>外观</span>
        <ThemeSwitcher />
      </div>
      <hr />
      <MenuItem disabled={busy} onClick={leave}>
        <LogOut size={16} aria-hidden="true" />
        退出登录
      </MenuItem>
    </div>
  );
}

/** 手机上菜单放到页面最外层，后面垫一层点了就关的底 */
function PhoneMenu({ close, children }: { close: () => void; children: ReactNode }) {
  return createPortal(
    <>
      <div className="mobile-backdrop account-menu-backdrop" onClick={close} />
      {children}
    </>,
    document.body,
  );
}

/** 退出登录没办成时的说明 */
function FailureDialog({ error, close }: { error: string; close: () => void }) {
  return (
    <ManagementDialog
      title="操作没有完成"
      size="sm"
      close={close}
      footer={
        <EditorFooter>
          <button className="primary" onClick={close}>
            知道了
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
    </ManagementDialog>
  );
}

/** 修改自己的密码 */
function PasswordDialog({ name, close }: { name: string; close: () => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <ManagementDialog
      title="修改密码"
      subtitle={name}
      size="sm"
      busy={saving}
      close={close}
      footer={
        <EditorFooter note="改好后其他设备要重新登录。">
          <button type="button" className="secondary" disabled={saving} onClick={close}>
            取消
          </button>
          <button type="submit" form="change-password-form" className="primary" disabled={saving}>
            {saving ? '正在保存…' : '保存新密码'}
          </button>
        </EditorFooter>
      }
    >
      <div className="adm-form adm-password">
        <ChangePasswordForm
          id="change-password-form"
          hideSubmit
          onBusyChange={setSaving}
          onDone={() => {
            close();
            notify('密码已修改，其他设备需要重新登录。');
          }}
        />
      </div>
    </ManagementDialog>
  );
}
