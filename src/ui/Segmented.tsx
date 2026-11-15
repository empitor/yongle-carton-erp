import type { ReactNode } from 'react';

/**
 * 分段控件：页内两到四项的切换（待处理 / 全部 / 已归档、原材料 / 成品……），全站同一个样子（record-view-tabs）。
 * tabs 为真时按页签读（tablist、aria-selected），切换的是同一块内容的不同视图；否则是一组按下状态的按钮（aria-pressed）。
 * className 加在外框上（例如财务的 fin-segmented、工具栏里的 list-toolbar-scope）。
 */
export default function Segmented({
  options,
  value,
  onChange,
  label,
  tabs = false,
  className,
}: {
  options: readonly (readonly [string, ReactNode])[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  tabs?: boolean;
  className?: string;
}) {
  return (
    <div
      className={'record-view-tabs' + (className ? ' ' + className : '')}
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
    >
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role={tabs ? 'tab' : undefined}
          aria-selected={tabs ? value === key : undefined}
          aria-pressed={tabs ? undefined : value === key}
          className={value === key ? 'selected' : ''}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
