import { useAccounts } from './fin-api';
import { useId, type ReactNode } from 'react';
import { ManagementDialog, EditorFooter, FormMessage, notify, useAction } from '../ui/index';

/*
 * 账务、费用、报表、设置这几页详情和编辑窗共用的小件。
 * 字段、通用表单窗口和状态标签在 fields.tsx、FormDialog.tsx、status.tsx（财务各页统一），这里只放这几页自己要的。
 */

/** 科目编码后面带上名称，例如“560201 办公费”。 */
export function useAccountNames() {
  const names = new Map(useAccounts().map((a) => [a.code, a.name]));
  return (code: unknown) => {
    if (code === null || code === undefined || code === '') return '';
    const name = names.get(String(code));
    return name ? code + ' ' + name : String(code);
  };
}

/** 窗口顶部的几个关键数字，例如工资“实发合计 / 已发 / 还剩”。 */
export function Stats({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="fb-stats">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 明细多、要自己排版的编辑窗外壳：底部固定一排按钮，最右是主操作；
 * 正文是一个表单，回车也能提交。办完关窗，结果在页面底部提示。
 */
export function EditorShell({
  title,
  subtitle,
  size = 'md',
  note,
  submitLabel = '保存',
  danger,
  disabled,
  close,
  submit,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  note?: ReactNode;
  submitLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  close: () => void;
  /** 返回的文字在关窗后提示；抛错时窗口不关，错误显示在顶部 */
  submit: () => Promise<string | void>;
  children: ReactNode;
}) {
  const formId = useId();
  const { busy, error, run } = useAction();
  return (
    <ManagementDialog
      title={title}
      subtitle={subtitle}
      size={size}
      busy={busy}
      danger={danger}
      close={close}
      footer={
        <EditorFooter note={note}>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            form={formId}
            className={danger ? 'danger-solid' : 'primary'}
            disabled={busy || disabled}
          >
            {busy ? '处理中…' : submitLabel}
          </button>
        </EditorFooter>
      }
    >
      <form
        id={formId}
        className="fin-form fin-ed"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const message = await submit();
            close();
            if (message) notify(message);
          });
        }}
      >
        <FormMessage>{error}</FormMessage>
        {children}
      </form>
    </ManagementDialog>
  );
}
