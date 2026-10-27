import { useLayoutEffect, useRef, type ReactNode } from 'react';
export function DraftHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header>
      <strong>{title}</strong>
      <div>{children}</div>
    </header>
  );
}
export function DraftText({
  label,
  field,
  locked,
  change,
}: {
  label: string;
  field: { value: string | null; note?: string };
  locked: boolean;
  change: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    let width = 0;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 2 + 'px';
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [field.value]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      title={field.note || ''}
      rows={2}
      maxLength={2000}
      disabled={locked}
      value={field.value || ''}
      placeholder="待确认"
      onChange={(e) => change(e.target.value)}
    />
  );
}
export function DraftNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={'oi-notice' + (error ? ' oi-bad' : '')} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
