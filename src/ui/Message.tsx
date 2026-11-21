import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * 全站的出错和说明提示：一块浅色底的话。出错（danger）红色、读屏立刻念；warning、info 是提醒和说明。
 * 窗口里、页面上、详情里都用这一个。close 给一个“关闭提示”的叉；action 是排在右边的一个按钮（例如“重新加载”）。
 */
export function FormMessage({
  tone = 'danger',
  close,
  action,
  children,
}: {
  tone?: 'danger' | 'warning' | 'info';
  close?: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  if (!children) return null;
  const side = !!(close || action);
  return (
    <div
      className={'form-message tone-' + tone + (side ? ' has-side' : '')}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {side ? <span>{children}</span> : children}
      {action}
      {close && (
        <button type="button" className="form-message-close" aria-label="关闭提示" onClick={close}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** “正在读取…”这句话；what 写读的是什么（“订单”→“正在读取订单…”）。放进别的件里（空表格、下拉的提示字）时用它。 */
export const loadingText = (what = '') => '正在读取' + what + '…';

/** 数据还没读到时占位的一句小字，读屏会念。 */
export function Loading({ what }: { what?: string }) {
  return (
    <p className="loading-note" role="status">
      {loadingText(what)}
    </p>
  );
}
