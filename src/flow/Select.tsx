import { Combobox } from '../ui/index';
import { FormField } from '../ui/index';

/** 下拉里的一项：按编号选，显示 label（没有就用名称、单号），hint 是小字说明 */
type SelectOption = {
  id: number;
  label?: string | null;
  name?: string | null;
  number?: string | null;
  hint?: string;
};

/** 单据编辑窗里的可搜索下拉。标签末尾的“ *”会转成必填标记。 */
export default function Select({
  label,
  value,
  onChange,
  options,
  empty = '请选择',
  required,
  hint,
  span,
}: {
  label: string;
  /** 选中的编号；没选是 null 或没有 */
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  options: readonly SelectOption[];
  empty?: string;
  required?: boolean;
  hint?: string;
  span?: 1 | 2 | 3 | 'full';
}) {
  const star = /\s*\*$/.test(label),
    text = label.replace(/\s*\*$/, '');
  return (
    <FormField label={text} required={required ?? star} hint={hint} span={span}>
      <Combobox
        ariaLabel={text}
        placeholder={empty}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(v) => onChange(v ? Number(v) : null)}
        options={[
          { value: '', label: empty },
          ...options.map((o) => ({
            value: String(o.id),
            label: String(o.label || o.name || o.number),
            hint: o.hint,
          })),
        ]}
      />
    </FormField>
  );
}
