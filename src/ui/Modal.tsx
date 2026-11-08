import { useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Save } from 'lucide-react';

export function Modal({
  wide = false,
  title,
  children,
  close,
}: {
  wide?: boolean;
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const root = ref.current!;
    (
      (root.querySelector('input,select,textarea') as HTMLElement) || root.querySelector('button')
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (
        [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
          .filter((d) => d.getClientRects().length)
          .at(-1) !== root
      )
        return;
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const els = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        );
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      prior?.focus();
    };
  }, [close]);
  const dialog = (
    <div className="overlay">
      <div
        ref={ref}
        className={'modal' + (wide ? ' modal-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <small>业务记录</small>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭表单" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

export function FormFooter({
  error,
  saving,
  close,
}: {
  error: string;
  saving: boolean;
  close: () => void;
}) {
  return (
    <>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>* 为必填项</span>
        <button type="button" disabled={saving} onClick={close}>
          取消
        </button>
        <button type="submit" className="primary" disabled={saving}>
          <Save size={16} />
          {saving ? '正在保存…' : '保存'}
        </button>
      </div>
    </>
  );
}
