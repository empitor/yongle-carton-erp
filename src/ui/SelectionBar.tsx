import type { ReactNode } from 'react';
import MoreMenu from './MoreMenu';
import type { RecordAction } from './Record';

/**
 * 列表勾选后的操作条，全站一个样子：固定在屏幕底部，“已选 N 项”、一个正向主操作、
 * 最多一个次要、“更多”（批量归档、批量删除这类，删除标 danger）、“清除选择”。
 * 归档能恢复，不用红色；只有删除这类不能恢复的标 danger。
 */
export default function SelectionBar({
  count,
  unit = '项',
  primary,
  secondary,
  more = [],
  onClear,
  note,
}: {
  count: number;
  unit?: string;
  primary?: RecordAction;
  secondary?: RecordAction;
  more?: RecordAction[];
  onClear: () => void;
  /** 一句说明，例如“只有待处理的能批量删除” */
  note?: ReactNode;
}) {
  if (!count) return null;
  const items = more.filter((a) => !a.hidden),
    normal = items.filter((a) => !a.danger),
    danger = items.filter((a) => a.danger);
  const button = (a: RecordAction, className: string) => (
    <button type="button" className={className} disabled={a.disabled} title={a.title} onClick={a.onClick}>
      {a.icon}
      {a.label}
    </button>
  );
  return (
    <div className="selection-bar" role="region" aria-label="已选记录的操作">
      <strong className="selection-count">
        已选 {count} {unit}
      </strong>
      {note && <span className="selection-note">{note}</span>}
      <div className="selection-actions">
        {secondary && !secondary.hidden && button(secondary, secondary.emphasis ? 'primary' : 'secondary')}
        {primary && !primary.hidden && button(primary, 'primary')}
        {items.length > 0 && (
          <MoreMenu text="更多" label="更多批量操作">
            {normal.map((a, i) => (
              <button key={'n' + i} type="button" role="menuitem" disabled={a.disabled} onClick={a.onClick}>
                {a.icon}
                {a.label}
              </button>
            ))}
            {normal.length > 0 && danger.length > 0 && <hr className="more-menu-sep" />}
            {danger.map((a, i) => (
              <button
                key={'d' + i}
                type="button"
                role="menuitem"
                className="danger-text"
                disabled={a.disabled}
                onClick={a.onClick}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </MoreMenu>
        )}
        <button type="button" className="selection-clear" onClick={onClear}>
          清除选择
        </button>
      </div>
    </div>
  );
}
