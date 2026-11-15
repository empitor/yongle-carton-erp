import { normalizeDimensionUnit, type DimensionUnit } from '../../shared/core/index';
import { useConfirm } from '../ui/index';

/**
 * 尺寸单位下拉。原来的单位没确认（例如导入时原文写得不清）而又已经有数字时，
 * 选了单位就等于把这些数字认成这个单位，先用确认窗问一句（不用浏览器自带的 confirm）。
 */
export default function DimensionUnitSelect({
  unit,
  hasValues,
  disabled,
  onChange,
  label = '尺寸单位',
}: {
  unit: unknown;
  hasValues: boolean;
  disabled?: boolean;
  onChange: (unit: DimensionUnit | null) => void;
  label?: string;
}) {
  const known = normalizeDimensionUnit(unit),
    raw = typeof unit === 'string' ? unit.trim() : '';
  const [confirmDialog, confirm] = useConfirm();
  return (
    <span className="dimension-unit-control">
      <select
        aria-label={label}
        value={known || ''}
        disabled={disabled}
        onChange={async (e) => {
          const next = normalizeDimensionUnit(e.target.value);
          if (
            !known &&
            next &&
            hasValues &&
            !(await confirm({
              title: '把尺寸认作' + (next === 'mm' ? '毫米' : '厘米'),
              message:
                '原来的尺寸单位没有确认，系统没法换算。继续会把现在填的长宽高当成' +
                (next === 'mm' ? '毫米' : '厘米') +
                '，请先对照原文件看一眼。',
              confirmLabel: '认作' + (next === 'mm' ? '毫米' : '厘米'),
            }))
          )
            return;
          onChange(next);
        }}
      >
        <option value="">单位待确认{raw && !known ? '（原文：' + raw + '）' : ''}</option>
        <option value="mm">毫米（mm）</option>
        <option value="cm">厘米（cm）</option>
      </select>
      {confirmDialog}
    </span>
  );
}
