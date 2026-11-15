import { presetRange, type DatePreset } from '../../shared/core/index';

/** 下拉里的几档范围，按显示的先后 */
const presets: { value: DatePreset; label: string }[] = [
  { value: 'all', label: '全部日期' },
  { value: '1', label: '最近一个月' },
  { value: '2', label: '最近两个月' },
  { value: '3', label: '最近三个月' },
  { value: 'custom', label: '自定义' },
];

/** 日期范围筛选：一个下拉选范围，自定义时再给两个日期框。列表“筛选”弹层和今日页的统计日期都用它。 */
export default function DateFilter({
  label,
  preset,
  start,
  end,
  change,
}: {
  label: string;
  preset: DatePreset;
  start: string;
  end: string;
  change: (preset: DatePreset, start: string, end: string) => void;
}) {
  return (
    <div className="list-toolbar-filter">
      <span>{label}</span>
      <select
        aria-label={label + '范围'}
        value={preset}
        onChange={(e) => {
          const next = presets.find((p) => p.value === e.target.value)?.value;
          if (!next) return;
          const range = presetRange(next);
          change(next, next === 'custom' ? start : range.start, next === 'custom' ? end : range.end);
        }}
      >
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {preset === 'custom' && (
        <div className="list-toolbar-dates">
          <input
            aria-label={label + '开始'}
            type="date"
            value={start}
            onChange={(e) => change('custom', e.target.value, end)}
          />
          <span>至</span>
          <input
            aria-label={label + '结束'}
            type="date"
            value={end}
            onChange={(e) => change('custom', start, e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
