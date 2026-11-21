import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useDialogFocus, useMissingGuide } from './dialog-hooks';
import { useBackLayer } from './back-layers';
import { useBackdropClose } from './backdrop-close';
export default function ManagementDialog({
  title,
  children,
  close,
  busy = false,
  danger = false,
  subtitle,
  size,
  footer,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
  danger?: boolean;
  /** 标题下一行的上下文，例如“来自订单 ZX-…” */
  subtitle?: ReactNode;
  /** 统一编辑窗的宽度档位；不传保持原来的宽度 */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 固定在底部的操作区，内容多时不随正文滚走 */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  // 必填引导要先挂：和原来一样先盯报错、再把焦点移进窗口
  const missing = useMissingGuide(ref);
  useDialogFocus(ref, close, busy);
  // 安卓 App 的返回键、手机上点背后暗处：都和 × 一样关，提交中不关
  useBackLayer(close, { busy });
  const backdrop = useBackdropClose(close, busy);
  const dialog = (
    <div className="overlay management-overlay" {...backdrop}>
      <section
        ref={ref}
        tabIndex={-1}
        className={
          'modal management-dialog' +
          (danger ? ' management-danger' : '') +
          (size ? ' editor-dialog editor-' + size : '')
        }
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          {subtitle ? (
            <div className="modal-titles">
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>
          ) : (
            <h2>{title}</h2>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭窗口"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <div className="management-dialog-body">{children}</div>
        {missing.length > 0 && (
          <p className="missing-note" role="status">
            标红的必填项还没填：{missing.join('、')}
          </p>
        )}
        {footer && <footer className="editor-footer">{footer}</footer>}
      </section>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
