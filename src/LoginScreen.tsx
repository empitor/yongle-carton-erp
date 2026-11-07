import { useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ChangePasswordForm from './ChangePasswordForm';
import {
  forgetAccount,
  lastUsedLabel,
  readRecentAccounts,
  rememberAccount,
} from './recent-accounts';
import { signOut, type AuthState } from './session';
import { userError } from '../shared/user-errors';
import BrandLogo from './ui/BrandLogo';
import PasswordField from './ui/PasswordField';

async function post(path: string, csrf: string, body: unknown) {
  let response: Response;
  try {
    response = await fetch('/api/auth/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('连不上服务器，请稍后再试。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(userError(data.message || '操作失败，请刷新后重试。'));
  return data;
}

function Card({ title, subtitle, children }: { title?: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="login-screen" data-agent-private>
      <section className="login-card">
        <header className="login-head">
          <BrandLogo size={56} />
          <h1>宁波甬勒包装制品有限公司</h1>
          {title && <h2>{title}</h2>}
          <p>{subtitle}</p>
        </header>
        {children}
      </section>
    </main>
  );
}

function Alert({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="form-alert" role="alert">
      {text}
    </p>
  );
}

type View = 'accounts' | 'login' | 'apply' | 'forgot' | 'applied' | 'forgot-sent';

export default function LoginScreen({ auth }: { auth: AuthState }) {
  const [recent, setRecent] = useState(() => readRecentAccounts(localStorage));
  const [view, setView] = useState<View>(() => (recent.length ? 'accounts' : 'login'));
  const [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const go = (next: View) => {
    setView(next);
    setError('');
    setPassword('');
    setRepeat('');
  };
  const submit = (job: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nameField = (autoFocus: boolean, placeholder?: string) => (
    <label>
      用户名
      <input
        autoComplete="username"
        autoCapitalize="none"
        required
        maxLength={60}
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </label>
  );

  if (!auth.configured) {
    if (auth.proxyAccess)
      return (
        <Card subtitle="系统还没有管理员">
          <p className="login-note" role="status">
            请到服务器本机打开系统，建立第一个管理员账号。
          </p>
        </Card>
      );
    return (
      <Card subtitle="首次使用，请建立管理员账号">
        <form
          className="auth-form"
          onSubmit={submit(async () => {
            if (password !== repeat) throw new Error('两次密码不一致。');
            await post('setup', auth.csrf, { name, password });
            rememberAccount(localStorage, name.trim());
            location.reload();
          })}
        >
          {nameField(true)}
          <PasswordField
            label="密码"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            rule
          />
          <PasswordField
            label="再次输入密码"
            value={repeat}
            onChange={setRepeat}
            autoComplete="new-password"
            rule
          />
          <Alert text={error} />
          <button className="primary" disabled={busy}>
            {busy ? '正在建立…' : '建立管理账号'}
          </button>
        </form>
      </Card>
    );
  }

  const links = (
    <div className="login-links">
      <button type="button" className="login-link" onClick={() => go('forgot')}>
        忘记密码
      </button>
      <button
        type="button"
        className="login-link"
        onClick={() => {
          setName('');
          go('apply');
        }}
      >
        申请账号
      </button>
    </div>
  );

  if (view === 'accounts')
    return (
      <Card title="选择账号" subtitle="这台设备只记用户名，不记密码">
        <ul className="login-accounts" aria-label="这台设备用过的账号">
          {recent.map((account) => (
            <li key={account.name}>
              <button
                type="button"
                className="login-account"
                onClick={() => {
                  setName(account.name);
                  go('login');
                }}
              >
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
                  if (!list.length) go('login');
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            setName('');
            go('login');
          }}
        >
          使用其他账号
        </button>
        {links}
      </Card>
    );

  if (view === 'apply')
    return (
      <Card title="申请账号" subtitle="管理员通过后才能登录">
        <form
          className="auth-form"
          onSubmit={submit(async () => {
            await post('apply', auth.csrf, { name, password, note });
            setPassword('');
            setNote('');
            go('applied');
          })}
        >
          {nameField(true, '建议用真实姓名')}
          <PasswordField
            label="密码"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            rule
          />
          <label>
            说明
            <input
              maxLength={200}
              placeholder="部门和岗位，方便管理员确认"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <Alert text={error} />
          <button className="primary" disabled={busy}>
            {busy ? '正在提交…' : '提交申请'}
          </button>
        </form>
        <button type="button" className="login-link" onClick={() => go(recent.length ? 'accounts' : 'login')}>
          返回登录
        </button>
      </Card>
    );

  if (view === 'applied')
    return (
      <Card title="申请已提交" subtitle="管理员通过后，用刚才的用户名和密码登录">
        <p className="login-note" role="status">
          可以直接联系管理员，告诉对方你申请了账号。
        </p>
        <button type="button" className="primary" onClick={() => go('login')}>
          返回登录
        </button>
      </Card>
    );

  if (view === 'forgot')
    return (
      <Card title="忘记密码" subtitle="管理员确认后会给你一个临时密码，登录后要马上改掉">
        <form
          className="auth-form"
          onSubmit={submit(async () => {
            await post('forgot', auth.csrf, { name });
            go('forgot-sent');
          })}
        >
          {nameField(true)}
          <Alert text={error} />
          <button className="primary" disabled={busy}>
            {busy ? '正在提交…' : '提交申请'}
          </button>
        </form>
        <p className="login-note">管理员本人忘记密码：到服务器本机运行重置命令。</p>
        <button type="button" className="login-link" onClick={() => go(recent.length ? 'accounts' : 'login')}>
          返回登录
        </button>
      </Card>
    );

  if (view === 'forgot-sent')
    return (
      <Card title="已提交" subtitle="请联系管理员">
        <p className="login-note" role="status">
          管理员确认是你本人后，会告诉你临时密码。在此之前原密码不变，想起来了可以直接登录。
        </p>
        <button type="button" className="primary" onClick={() => go('login')}>
          返回登录
        </button>
      </Card>
    );

  return (
    <Card subtitle="登录管理系统">
      <form
        className="auth-form"
        onSubmit={submit(async () => {
          await post('login', auth.csrf, { name, password });
          rememberAccount(localStorage, name.trim());
          location.reload();
        })}
      >
        {nameField(!name)}
        <PasswordField
          label="密码"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus={!!name}
        />
        <Alert text={error} />
        <button className="primary" disabled={busy}>
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>
      {links}
      {recent.length > 0 && (
        <button type="button" className="login-link login-link-center" onClick={() => go('accounts')}>
          换一个账号
        </button>
      )}
    </Card>
  );
}

/** 用临时密码登录后停在这里，改完才能进系统。服务端同样拒绝这种会话访问业务接口。 */
export function ForcedPasswordChange({ name }: { name: string }) {
  const [error, setError] = useState('');
  return (
    <Card title="先改密码" subtitle={name + '，你现在用的是临时密码，改完才能进入系统'}>
      <ChangePasswordForm
        currentLabel="临时密码"
        submitLabel="保存并进入系统"
        onDone={() => location.reload()}
      />
      <Alert text={error} />
      <button
        type="button"
        className="login-link login-link-center"
        onClick={() => signOut().catch((failure) => setError((failure as Error).message))}
      >
        退出登录
      </button>
    </Card>
  );
}
