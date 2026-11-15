import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { forgetAccount, lastUsedLabel, readRecentAccounts, rememberAccount, type RecentAccount } from './recent-accounts';
import { PasswordField, type AuthState } from './ui/index';
import { authPost } from './auth-api';
import { LoginAlert, LoginCard } from './LoginCard';
import { useLoginForm, type LoginForm } from './login-form';
import { ApplyView, ForgotView, NameField, SetupView, SubmittedView } from './LoginViews';

/**
 * 登录页：这台设备用过账号时先选账号，再输密码；另有忘记密码、申请账号。
 * 还没有管理员时是建第一个管理员（只能在服务器本机）。填表的几个视图在 LoginViews。
 */
export default function LoginScreen({ auth }: { auth: AuthState }) {
  const [recent, setRecent] = useState(() => readRecentAccounts(localStorage));
  const form = useLoginForm(recent.length ? 'accounts' : 'login');
  if (!auth.configured) return <SetupView form={form} csrf={auth.csrf} proxyAccess={auth.proxyAccess} />;
  const back = () => form.go(recent.length ? 'accounts' : 'login');
  const links = (
    <div className="login-links">
      <button type="button" className="login-link" onClick={() => form.go('forgot')}>
        忘记密码
      </button>
      <button
        type="button"
        className="login-link"
        onClick={() => {
          form.setName('');
          form.go('apply');
        }}
      >
        申请账号
      </button>
    </div>
  );
  switch (form.view) {
    case 'accounts':
      return <AccountsView form={form} recent={recent} setRecent={setRecent} links={links} />;
    case 'apply':
      return <ApplyView form={form} csrf={auth.csrf} back={back} />;
    case 'forgot':
      return <ForgotView form={form} csrf={auth.csrf} back={back} />;
    case 'applied':
    case 'forgot-sent':
      return <SubmittedView form={form} />;
    case 'login':
      // 登录表单在下面
      break;
  }
  return (
    <LoginCard subtitle="登录管理系统">
      <form
        className="auth-form"
        onSubmit={form.submit(async () => {
          await authPost('login', auth.csrf, { name: form.name, password: form.password });
          rememberAccount(localStorage, form.name.trim());
          location.reload();
        })}
      >
        <NameField form={form} autoFocus={!form.name} />
        <PasswordField
          label="密码"
          value={form.password}
          onChange={form.setPassword}
          autoComplete="current-password"
          autoFocus={!!form.name}
        />
        <LoginAlert text={form.error} />
        <button className="primary" disabled={form.busy}>
          {form.busy ? '正在登录…' : '登录'}
        </button>
      </form>
      {links}
      {recent.length > 0 && (
        <button type="button" className="login-link login-link-center" onClick={() => form.go('accounts')}>
          换一个账号
        </button>
      )}
    </LoginCard>
  );
}

/** 选账号：这台设备只记用户名，不记密码；可以从这台设备移除 */
function AccountsView({
  form,
  recent,
  setRecent,
  links,
}: {
  form: LoginForm;
  recent: RecentAccount[];
  setRecent: (list: RecentAccount[]) => void;
  links: ReactNode;
}) {
  const login = (name: string) => {
    form.setName(name);
    form.go('login');
  };
  return (
    <LoginCard title="选择账号" subtitle="这台设备只记用户名，不记密码">
      <ul className="login-accounts" aria-label="这台设备用过的账号">
        {recent.map((account) => (
          <li key={account.name}>
            <button type="button" className="login-account" onClick={() => login(account.name)}>
              <span className="account-avatar" aria-hidden="true">
                {account.name.slice(0, 1)}
              </span>
              <span className="login-account-text">
                <strong>{account.name}</strong>
                <small>{lastUsedLabel(account.at)}</small>
              </span>
            </button>
            <button
              type="button"
              className="login-account-remove"
              aria-label={'从这台设备移除 ' + account.name}
              title="从这台设备移除"
              onClick={() => {
                const list = forgetAccount(localStorage, account.name);
                setRecent(list);
                if (!list.length) form.go('login');
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => login('')}>
        使用其他账号
      </button>
      {links}
    </LoginCard>
  );
}
