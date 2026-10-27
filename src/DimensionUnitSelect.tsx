import { normalizeDimensionUnit, type DimensionUnit } from '../shared/product-details';
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
  return (
    <span className="dimension-unit-control">
      <select
        aria-label={label}
        value={known || ''}
        disabled={disabled}
        onChange={(e) => {
          const next = normalizeDimensionUnit(e.target.value);
          if (
            !known &&
            next &&
            hasValues &&
            !window.confirm(
              '原尺寸单位未确认，系统无法换算。继续会将当前数值确认为' +
                next +
                '，请先对照原文件确认。是否继续？',
            )
          )
            return;
          onChange(next);
        }}
      >
        <option value="">单位待确认{raw && !known ? '（原文：' + raw + '）' : ''}</option>
        <option value="mm">毫米（mm）</option>
        <option value="cm">厘米（cm）</option>
      </select>
      <small>mm/cm切换按1cm=10mm换算；未知单位不自动换算。</small>
    </span>
  );
}
