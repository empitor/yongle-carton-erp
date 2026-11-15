import { useEffect, useRef, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * 次要操作收进“更多”。点击菜单项或菜单外、按 Esc、页面滚动时关闭。
 * 菜单放进浏览器顶层、按按钮在屏幕上的位置定位：在弹窗、可滚动面板、带毛玻璃的底栏里都不会被裁掉或推偏；
 * 下面放不下就往上开，贴着屏幕边也不出界。
 * text：按钮上写字（详情面板用“更多”，删除、撤销都在里面，只有图标容易找不到）。
 */
export default function MoreMenu({
  label = '更多操作',
  text,
  children,
}: {
  label?: string;
  text?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const close = () => {
      if (details.open) details.open = false;
    };
    const outside = (e: MouseEvent) => {
      if (details.open && !(e.target instanceof Node && details.contains(e.target))) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && details.open) {
        e.stopPropagation();
        close();
        details.querySelector('summary')?.focus();
      }
    };
    const list = details.querySelector<HTMLElement>('.more-menu-list');
    // 菜单放进浏览器顶层（popover）：祖先元素的 transform、filter、backdrop-filter 会让 fixed 改按祖先定位，
    // overflow 会把菜单裁掉，放到顶层后这些都影响不到它。菜单仍在 details 里，点外面关闭、Tab 顺序照旧。
    const topLayer = !!list && typeof list.showPopover === 'function';
    if (list && topLayer) list.setAttribute('popover', 'manual');
    const shown = () => !!list && topLayer && list.matches(':popover-open');
    const place = () => {
      const summary = details.querySelector('summary');
      if (!list || !summary) return;
      if (!details.open) {
        if (shown()) list.hidePopover();
        list.style.cssText = '';
        return;
      }
      if (topLayer && !shown()) list.showPopover();
      const r = summary.getBoundingClientRect(),
        gap = 4,
        edge = 8,
        width = window.innerWidth,
        screen = window.innerHeight;
      list.style.position = 'fixed';
      list.style.right = 'auto';
      list.style.bottom = 'auto';
      list.style.maxHeight = '';
      list.style.overflowY = 'auto';
      const natural = list.offsetHeight,
        below = screen - r.bottom - gap - edge,
        above = r.top - gap - edge;
      // 下面放不下、上面更宽敞就往上开；还放不下就限高、菜单里滚动
      const up = natural > below && above > below;
      list.style.maxHeight = Math.max(below, above) + 'px';
      const height = list.offsetHeight,
        menuWidth = list.offsetWidth;
      // 和按钮右边对齐；伸出屏幕左边时改成从按钮左边起，两边都不出界
      let left = r.right - menuWidth;
      if (left < edge) left = r.left;
      left = Math.max(edge, Math.min(left, width - menuWidth - edge));
      const top = Math.max(edge, Math.min(up ? r.top - gap - height : r.bottom + gap, screen - height - edge));
      list.style.left = left + 'px';
      list.style.top = top + 'px';
      // 不支持顶层的浏览器：祖先让 fixed 改了定位基准时，按实际偏出去的距离拉回来
      const actual = list.getBoundingClientRect();
      if (Math.abs(actual.left - left) > 0.5) list.style.left = left - (actual.left - left) + 'px';
      if (Math.abs(actual.top - top) > 0.5) list.style.top = top - (actual.top - top) + 'px';
    };
    const onToggle = () => {
      place();
      if (details.open) requestAnimationFrame(place);
    };
    // 菜单固定在屏幕上，页面或弹窗滚动后位置就不对了：直接关掉
    const onScroll = (e: Event) => {
      if (details.open && !(e.target instanceof Node && details.contains(e.target))) close();
    };
    details.addEventListener('toggle', onToggle);
    document.addEventListener('click', outside);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      details.removeEventListener('toggle', onToggle);
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      if (list && shown()) list.hidePopover();
    };
  }, []);
  return (
    <details className="more-menu" ref={ref}>
      <summary aria-label={label} title={label} className={text ? 'more-menu-text' : undefined}>
        <MoreHorizontal size={16} aria-hidden="true" />
        {text}
      </summary>
      <div
        className="more-menu-list"
        role="menu"
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button,a') && ref.current) ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
