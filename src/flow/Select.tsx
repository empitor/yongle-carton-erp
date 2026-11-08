import Field from '../ui/Field';
import Combobox from '../ui/Combobox';

export default function Select({
  label,
  value,
  onChange,
  options,
  empty = '请选择',
}: {
  label: string;
  value: any;
  onChange: (v: number | null) => void;
  options: any[];
  empty?: string;
}) {
  return (
    <Field variant="flow" label={label}>
      <Combobox
        ariaLabel={label}
        placeholder={empty}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(v) => onChange(v ? Number(v) : null)}
        options={[
          { value: '', label: empty },
          ...options.map((o) => ({
            value: String(o.id),
            label: String(o.label || o.name || o.number),
          })),
        ]}
      />
    </Field>
  );
}
