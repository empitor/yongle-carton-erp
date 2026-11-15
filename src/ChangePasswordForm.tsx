import { useState } from 'react';
import { errorMessage } from '../shared/core/index';
import { PasswordField } from './ui/index';
import { changePassword } from './auth-api';

/**
 * 右上角“修改密码”和临时密码登录后的强制改密共用。
 * 放在窗口里时传 id 和 hideSubmit：提交按钮放到窗口底栏（`<button form={id}>`），onBusyChange 告诉底栏在不在保存。
 */
export default function ChangePasswordForm({
  currentLabel = '当前密码',
  submitLabel = '保存新密码',
  onDone,
  id,
  hideSubmit = false,
  onBusyChange,
}: {
  currentLabel?: string;
  submitLabel?: string;
  onDone: () => void;
  id?: string;
  hideSubmit?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusyChange?.(value);
  };
  return (
    <form
      id={id}
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await changePassword(current, next);
          onDone();
        } catch (failure) {
          setError(errorMessage(failure));
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
      {!hideSubmit && (
        <button className="primary" disabled={busy}>
          {busy ? '正在保存…' : submitLabel}
        </button>
      )}
    </form>
  );
}
