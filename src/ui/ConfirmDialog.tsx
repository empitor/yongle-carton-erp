import { useCallback, useRef, useState, type ReactNode } from 'react';
import ManagementDialog from './ManagementDialog';
import { EditorFooter } from './Editor';
import { FormMessage } from './Message';

/**
 * 确认窗：标题、说明、底部“取消 / 确认”，危险操作用红色按钮。
 * 代替浏览器自带的 confirm，各模块共用，版式和编辑窗一致。
 */
export default function ConfirmDialog({
  title,
  subtitle,
  children,
  confirmLabel,
  busyLabel = '正在处理…',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  disabled = false,
  error,
  note,
  size = 'sm',
  onConfirm,
  close,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 还不能确认（例如没勾选同意） */
  disabled?: boolean;
  error?: ReactNode;
  note?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  onConfirm: () => void;
  close: () => void;
}) {
  return (
    <ManagementDialog
      title={title}
      subtitle={subtitle}
      size={size}
      danger={danger}
      busy={busy}
      close={close}
      footer={
        <EditorFooter note={note}>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'danger-solid' : 'primary'}
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <div className="confirm-text">{children}</div>
    </ManagementDialog>
  );
}

type ConfirmOptions = {
  title: string;
  /** 一两句说明：会发生什么、能不能恢复 */
  message?: ReactNode;
  /** 主按钮文字，写这一步的结果，例如“删除会话”“移除唛头” */
  confirmLabel: string;
  danger?: boolean;
};

/**
 * 要用 await 的地方代替 window.confirm：
 * const [confirmDialog, confirm] = useConfirm(); 渲染 {confirmDialog}；
 * if (await confirm({ title: '移除唛头', confirmLabel: '移除', danger: true })) …
 */
export function useConfirm(): [ReactNode, (options: ConfirmOptions) => Promise<boolean>] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback(
    (next: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOptions(next);
      }),
    [],
  );
  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  };
  const dialog = options ? (
    <ConfirmDialog
      title={options.title}
      confirmLabel={options.confirmLabel}
      danger={options.danger}
      onConfirm={() => finish(true)}
      close={() => finish(false)}
    >
      {options.message}
    </ConfirmDialog>
  ) : null;
  return [dialog, ask];
}
