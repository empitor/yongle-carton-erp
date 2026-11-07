import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { passwordHint, passwordPattern } from '../../shared/password-policy';

/** 密码输入框，右侧可切换显示。手机上输长密码时用得上。 */
export default function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  rule,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  /** 这是要新设的密码：显示并检查密码规则。登录时不检查。 */
  rule?: boolean;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="password-field">
      {label}
      <span className="password-field-box">
        <input
          type={show ? 'text' : 'password'}
          required
          maxLength={128}
          pattern={rule ? passwordPattern : undefined}
          title={rule ? passwordHint : undefined}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={rule ? passwordHint : undefined}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={show ? '隐藏密码' : '显示密码'}
          aria-pressed={show}
          onClick={() => setShow((v) => !v)}
        >
          {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </span>
    </label>
  );
}
