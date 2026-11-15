import type { ReactNode } from 'react';

/** 识别前给人看的一句外发说明（不再弹窗确认）。三种识别类型共用。 */
export const SEND_NOTE = '原文件会发给 DeepSeek 识别，识别完立即删除，最长保留 1 小时。';
/** 没配好模型时（服务端没给说明）的那句话 */
export const NO_KEY = '还没填写 DeepSeek 密钥，请先到设置 → API 配置填写。';

/** 需要人明确勾选才算数的确认（正式导入）。 */
export function Agreement({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="aii-agree">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** 一串文件名：最多显示几行，多了可以滚动。 */
export function FileNames({ names }: { names: (string | undefined)[] }) {
  return (
    <ul className="aii-file-names">
      {names.map((n, i) => (
        <li key={i} title={n}>
          {n || '—'}
        </li>
      ))}
    </ul>
  );
}
