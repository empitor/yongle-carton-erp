import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
export default function ManagementDialog({
  title,
  children,
  close,
  busy = false,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
  danger?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const root = ref.current!;
    root.focus();
    const listener = (e: KeyboardEvent) => {
      if (
        [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
          .filter((d) => d.getClientRects().length)
          .at(-1) !== root
      )
        return;
      if ((e.target as HTMLElement)?.closest?.('[data-global-assistant]')) return;
      if (e.key === 'Escape' && !busy) closeRef.current();
      if (e.key === 'Tab') {
        const items = [
          ...root.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary',
          ),
        ];
        const first = items[0],
          last = items.at(-1);
        if (!items.length) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last || document.activeElement === root)
        ) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', listener);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', listener);
      document.body.style.overflow = overflow;
      prior?.focus();
    };
  }, [busy]);
  const dialog = (
    <div className="overlay management-overlay">
      <section
        ref={ref}
        tabIndex={-1}
        className={'modal management-dialog' + (danger ? ' management-danger' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
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
      </section>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
