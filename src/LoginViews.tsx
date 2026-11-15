import { PasswordField } from './ui/index';
import { authPost } from './auth-api';
import { LoginAlert, LoginCard } from './LoginCard';
import type { LoginForm } from './login-form';
import { rememberAccount } from './recent-accounts';

/* 登录页里填表的几个视图：首次建管理员、申请账号、忘记密码，和提交以后的“已提交”。登录和选账号在 LoginScreen。 */

export function NameField({ form, autoFocus, placeholder }: { form: LoginForm; autoFocus: boolean; placeholder?: string }) {
  return (
    <label>
      用户名
      <input
        autoComplete="username"
        autoCapitalize="none"
        required
        maxLength={60}
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={form.name}
        onChange={(e) => form.setName(e.target.value)}
      />
    </label>
  );
}

/** 新密码（带规则提示） */
const NewPassword = ({ label, value, change }: { label: string; value: string; change: (v: string) => void }) => (
  <PasswordField label={label} value={value} onChange={change} autoComplete="new-password" rule />
);

/** 首次使用：在服务器本机建立第一个管理员账号；从域名进来的只能看到提示 */
export function SetupView({ form, csrf, proxyAccess }: { form: LoginForm; csrf: string; proxyAccess?: boolean }) {
  if (proxyAccess)
    return (
      <LoginCard subtitle="系统还没有管理员">
        <p className="login-note" role="status">
          请到服务器本机打开系统，建立第一个管理员账号。
        </p>
      </LoginCard>
    );
  return (
    <LoginCard subtitle="首次使用，请建立管理员账号">
      <form
        className="auth-form"
        onSubmit={form.submit(async () => {
          if (form.password !== form.repeat) throw new Error('两次密码不一致。');
          await authPost('setup', csrf, { name: form.name, password: form.password });
          rememberAccount(localStorage, form.name.trim());
          location.reload();
        })}
      >
        <NameField form={form} autoFocus />
        <NewPassword label="密码" value={form.password} change={form.setPassword} />
        <NewPassword label="再次输入密码" value={form.repeat} change={form.setRepeat} />
        <LoginAlert text={form.error} />
        <button className="primary" disabled={form.busy}>
          {form.busy ? '正在建立…' : '建立管理账号'}
        </button>
      </form>
    </LoginCard>
  );
}

const BackLink = ({ back }: { back: () => void }) => (
  <button type="button" className="login-link" onClick={back}>
    返回登录
  </button>
);
const SubmitButton = ({ busy }: { busy: boolean }) => (
  <button className="primary" disabled={busy}>
    {busy ? '正在提交…' : '提交申请'}
  </button>
);

export function ApplyView({ form, csrf, back }: { form: LoginForm; csrf: string; back: () => void }) {
  return (
    <LoginCard title="申请账号" subtitle="管理员通过后才能登录">
      <form
        className="auth-form"
        onSubmit={form.submit(async () => {
          await authPost('apply', csrf, { name: form.name, password: form.password, note: form.note });
          form.setPassword('');
          form.setNote('');
          form.go('applied');
        })}
      >
        <NameField form={form} autoFocus placeholder="建议用真实姓名" />
        <NewPassword label="密码" value={form.password} change={form.setPassword} />
        <label>
          说明
          <input
            maxLength={200}
            placeholder="部门和岗位，方便管理员确认"
            value={form.note}
            onChange={(e) => form.setNote(e.target.value)}
          />
        </label>
        <LoginAlert text={form.error} />
        <SubmitButton busy={form.busy} />
      </form>
      <BackLink back={back} />
    </LoginCard>
  );
}

export function ForgotView({ form, csrf, back }: { form: LoginForm; csrf: string; back: () => void }) {
  return (
    <LoginCard title="忘记密码" subtitle="管理员确认后会给你一个临时密码，登录后要马上改掉">
      <form
        className="auth-form"
        onSubmit={form.submit(async () => {
          await authPost('forgot', csrf, { name: form.name });
          form.go('forgot-sent');
        })}
      >
        <NameField form={form} autoFocus />
        <LoginAlert text={form.error} />
        <SubmitButton busy={form.busy} />
      </form>
      <p className="login-note">管理员本人忘记密码：到服务器本机运行重置命令。</p>
      <BackLink back={back} />
    </LoginCard>
  );
}

/** 申请账号、忘记密码提交以后：说下一步找管理员，主按钮回登录 */
export function SubmittedView({ form }: { form: LoginForm }) {
  const applied = form.view === 'applied';
  return (
    <LoginCard
      title={applied ? '申请已提交' : '已提交'}
      subtitle={applied ? '管理员通过后，用刚才的用户名和密码登录' : '请联系管理员'}
    >
      <p className="login-note" role="status">
        {applied
          ? '可以直接联系管理员，告诉对方你申请了账号。'
          : '管理员确认是你本人后，会告诉你临时密码。在此之前原密码不变，想起来了可以直接登录。'}
      </p>
      <button type="button" className="primary" onClick={() => form.go('login')}>
        返回登录
      </button>
    </LoginCard>
  );
}
