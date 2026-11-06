import { useEffect, useRef, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

/** 次要操作收进“更多”。点击菜单项或菜单外时关闭。 */
export default function MoreMenu({ label = '更多操作', children }: { label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  return (
    <details className="more-menu" ref={ref}>
      <summary aria-label={label} title={label}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </summary>
      <div
        className="more-menu-list"
        role="menu"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button,a') && ref.current) ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
