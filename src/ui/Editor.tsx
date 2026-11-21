import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';

/**
 * 编辑窗的版式件：按“做什么、给谁、什么时候、明细、备注”分节，每节一个小标题；
 * 字段标签在上，说明文字放在输入框下面，只写一句必要的话。底部固定一排按钮。
 */

/** 编辑窗里的一节。columns 决定这一节排几列，手机上自动变一列。 */
export function FormSection({
  title,
  hint,
  extra,
  columns = 2,
  children,
}: {
  title?: string;
  hint?: ReactNode;
  extra?: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  children: ReactNode;
}) {
  return (
    <section className="ed-section">
      {(title || extra) && (
        <header>
          {title && <h3>{title}</h3>}
          {extra}
        </header>
      )}
      {hint && <p className="ed-hint">{hint}</p>}
      <div className={'ed-grid cols-' + columns}>{children}</div>
    </section>
  );
}

/**
 * 一个字段：标签、输入控件、一句说明或错误。span 是在这一节里占几列，'full' 占满一行。
 * 用 label 包住控件，点标签就能聚焦。外层的 field 类名给界面检查脚本找输入框（label.field）。
 */
export function FormField({
  label,
  required,
  hint,
  error,
  span = 1,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  span?: 1 | 2 | 3 | 'full';
  children: ReactNode;
}) {
  return (
    <label className={'field form-field span-' + span + (error ? ' has-error' : '')}>
      <span className="form-field-label">
        {label}
        {required && (
          <em className="required-mark" aria-label="必填">
            *
          </em>
        )}
      </span>
      {children}
      {error ? (
        <small className="form-field-error" role="alert">
          {error}
        </small>
      ) : (
        hint && <small className="form-field-hint">{hint}</small>
      )}
    </label>
  );
}

/** 不需要点标签聚焦的一组控件（复选框列表、按钮组）用这个，避免 label 嵌套。 */
export function FormGroup({
  label,
  hint,
  span = 'full',
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  span?: 1 | 2 | 3 | 'full';
  children: ReactNode;
}) {
  return (
    <div className={'form-field span-' + span} role="group">
      {label && <span className="form-field-label">{label}</span>}
      {children}
      {hint && <small className="form-field-hint">{hint}</small>}
    </div>
  );
}

/**
 * 编辑窗底部：左边一句提示（例如“保存草稿不影响库存”），右边按钮从次到主排列，最右是主操作。
 */
export function EditorFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className="editor-footer-note">{note}</span>
      <div className="editor-footer-actions">{children}</div>
    </>
  );
}


/** 明细行尾的删除图标。className 给页面自己的版式（例如财务明细表的 fb-row-delete）。 */
export function RowDelete({
  label,
  onClick,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={'icon-button' + (className ? ' ' + className : '')}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Trash2 size={16} aria-hidden="true" />
    </button>
  );
}
