import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useBackLayer } from './back-layers';

/**
 * 列表工具栏的“筛选”：不常用的筛选条件收进这个弹层，工具栏只留搜索、一个分段和最多一个关键下拉。
 * active 是当前生效的条件个数，按钮上显示出来；onClear 清掉弹层里的条件。
 */
export default function FilterPopover({
  active = 0,
  onClear,
  children,
}: {
  active?: number;
  onClear?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // 安卓 App 的返回键：开着时先关这一层（和“完成”一样）
  useBackLayer(() => setOpen(false), { active: open });
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (ref.current && !(e.target instanceof Node && ref.current.contains(e.target))) setOpen(false);
    };
    // 页面滚动才收起；焦点还在弹层里（手机上点输入框弹出键盘会顶得页面滚一下）不收
    const scroll = (e: Event) => {
      if (!(document.activeElement instanceof Node && panel.current?.contains(document.activeElement))) outside(e);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  return (
    <div className="filter-popover" ref={ref}>
      <button
        type="button"
        className={'filter-popover-toggle' + (active ? ' has-active' : '')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        筛选{active ? ' ' + active : ''}
      </button>
      {open && (
        <div className="filter-popover-panel" ref={panel} role="dialog" aria-label="筛选条件">
          <div className="filter-popover-fields">{children}</div>
          {onClear && (
            <div className="filter-popover-foot">
              <button
                type="button"
                className="secondary"
                disabled={!active}
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                清除筛选
              </button>
              <button type="button" className="primary" onClick={() => setOpen(false)}>
                完成
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
