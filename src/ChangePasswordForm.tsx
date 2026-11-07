import { useState } from 'react';
import { managementRequest } from './session';
import PasswordField from './ui/PasswordField';

/** 右上角“修改密码”和临时密码登录后的强制改密共用。 */
export default function ChangePasswordForm({
  currentLabel = '当前密码',
  submitLabel = '保存新密码',
  onDone,
}: {
  currentLabel?: string;
  submitLabel?: string;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await managementRequest('/auth/password', { current, password: next });
          onDone();
        } catch (failure) {
          setError((failure as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <PasswordField
        label={currentLabel}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
        autoFocus
      />
      <PasswordField
        label="新密码"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        rule
      />
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? '正在保存…' : submitLabel}
      </button>
    </form>
  );
}
