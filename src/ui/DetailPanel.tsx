import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** 右侧详情面板：不加遮罩，列表保持可见可操作；Esc 关闭，↑↓ 切换相邻记录。 */
export default function DetailPanel({
  title,
  status,
  actions,
  summary,
  children,
  close,
  previous,
  next,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  const handlers = useRef({ close, previous, next });
  handlers.current = { close, previous, next };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        document.querySelector('[role="dialog"][aria-modal="true"]') ||
        target?.closest?.('input,select,textarea,[contenteditable],[data-global-assistant]')
      )
        return;
      if (e.key === 'Escape') handlers.current.close();
      else if (e.key === 'ArrowDown' && handlers.current.next) {
        e.preventDefault();
        handlers.current.next();
      } else if (e.key === 'ArrowUp' && handlers.current.previous) {
        e.preventDefault();
        handlers.current.previous();
      }
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
  const panel = (
    <aside className="detail-panel" aria-label={title + ' 详情'}>
      <header className="detail-panel-head">
        <h2 title={title}>{title}</h2>
        {status}
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {summary && <div className="detail-chain">{summary}</div>}
      {actions && <div className="detail-panel-actions">{actions}</div>}
      <div className="detail-panel-body">{children}</div>
    </aside>
  );
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
