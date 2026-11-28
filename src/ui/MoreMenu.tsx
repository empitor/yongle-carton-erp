import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useBackLayer } from './back-layers';
import { hidePopup, placePopup, screenView } from './popup-position';

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
  // 安卓 App 的返回键：菜单开着时先收起菜单
  const [open, setOpen] = useState(false);
  useBackLayer(
    () => {
      if (ref.current) ref.current.open = false;
    },
    { active: open },
  );
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
    // 菜单放进浏览器顶层、按按钮在屏幕上的位置摆（src/ui/popup-position.ts，和可搜索下拉同一套）。
    // 菜单仍在 details 里，点外面关闭、Tab 顺序照旧。
    // 一挂上就标成顶层元素：没打开时不占位，打开的那一下不会先在原地排一遍、把按钮挤开
    if (list && typeof list.showPopover === 'function') list.setAttribute('popover', 'manual');
    const place = () => {
      const summary = details.querySelector('summary');
      if (!list || !summary) return;
      if (details.open) placePopup(list, summary, { align: 'end', view: screenView() });
      else hidePopup(list);
    };
    const onToggle = () => {
      setOpen(details.open);
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
      if (list) hidePopup(list);
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
