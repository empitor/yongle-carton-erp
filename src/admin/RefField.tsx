import { Combobox, loadingText } from '../ui/index';
import { refKinds, refOptions, refPlaceholders, type FieldContext } from './field-rules';
import { textOf, type JsonObject } from './record-types';
/** 关联字段：可搜索选择器，显示名称或单号，名称后面小字带能认出来的信息 */
export default function RefField({
  field,
  title,
  value,
  line,
  update,
  disabled,
  ctx,
}: {
  field: string;
  title: string;
  value: unknown;
  /** 这一格所在的那项明细（订单明细的候选按它选的订单列） */
  line?: JsonObject;
  /** 选了：原件是它的编号（文字），别的是记录编号；选“不关联”是 null */
  update: (v: string | number | null) => void;
  disabled?: boolean;
  /** 编辑窗的上下文（正在改的那条、关联候选） */
  ctx: FieldContext;
}) {
  const kind = refKinds[field];
  if (kind === 'batch')
    // 按订货单登记到货时记下的批次：只显示单号
    return (
      <input
        aria-label={'数据管理 ' + title}
        disabled
        value={textOf(ctx.record?.orderBatchNumber) || '已关联订货单'}
      />
    );
  if (kind === 'source') {
    const now = value == null ? '' : String(value);
    return (
      <select
        aria-label={'数据管理 ' + title}
        value={now}
        disabled={disabled}
        onChange={(e) => update(e.target.value || null)}
      >
        <option value="">不挂原件</option>
        {now && <option value={now}>{textOf(ctx.record?.sourceFileName) || '已挂的送货单原件'}</option>}
      </select>
    );
  }
  const options = refOptions(field, value, ctx, line);
  return (
    <Combobox
      ariaLabel={'数据管理 ' + title}
      value={value == null ? '' : String(value)}
      options={options}
      disabled={disabled}
      placeholder={ctx.refs ? refPlaceholders[kind] || '输入名称搜索' : loadingText()}
      onChange={(v) => update(v === '' ? null : Number(v))}
    />
  );
}
