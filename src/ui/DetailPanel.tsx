import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { emit } from './events';

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
  kicker,
  subtitle,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  close: () => void;
  previous?: () => void;
  next?: () => void;
  /** 编号上面的一行小字，写单据或档案类型，例如“生产任务” */
  kicker?: string;
  /** 编号下面一行，写最关键的上下文，例如“水壶外箱 · 计划 1000 只” */
  subtitle?: ReactNode;
}) {
  const handlers = useRef({ close, previous, next });
  handlers.current = { close, previous, next };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        document.querySelector('[role="dialog"][aria-modal="true"]') ||
        target?.closest('input,select,textarea,[contenteditable],[data-global-assistant]')
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
  // 告诉助手当前正在看哪条记录，只用于显示上下文提示。
  useEffect(() => {
    emit('erp-panel-focus', title);
    return () => {
      emit('erp-panel-focus', null);
    };
  }, [title]);
  const panel = (
    <aside className="detail-panel" aria-label={title + ' 详情'}>
      <header className="detail-panel-head">
        {kicker ? (
          <div className="detail-panel-titles">
            <span className="detail-panel-kicker">{kicker}</span>
            <h2 title={title}>{title}</h2>
          </div>
        ) : (
          <h2 title={title}>{title}</h2>
        )}
        {status}
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={close}>
          <X size={18} />
        </button>
      </header>
      {subtitle && <div className="detail-panel-subtitle">{subtitle}</div>}
      {summary && <div className="detail-chain">{summary}</div>}
      {actions && <div className="detail-panel-actions">{actions}</div>}
      <div className="detail-panel-body">{children}</div>
    </aside>
  );
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
