import { CalendarDays } from 'lucide-react';
import { presetRange, type DatePreset } from '../shared/date-ranges';
export default function DateRangeFilter({
  preset,
  start,
  end,
  change,
  label = '下单日期',
}: {
  preset: DatePreset;
  start: string;
  end: string;
  change: (preset: DatePreset, start: string, end: string) => void;
  label?: string;
}) {
  return (
    <div className="range-control">
      <label>
        <CalendarDays size={15} />
        <span>{label}</span>
        <select
          aria-label={label + '范围'}
          value={preset}
          onChange={(e) => {
            const next = e.target.value as DatePreset,
              range = presetRange(next);
            change(
              next,
              next === 'custom' ? start : range.start,
              next === 'custom' ? end : range.end,
            );
          }}
        >
          <option value="2">最近两个月</option>
          <option value="1">最近一个月</option>
          <option value="3">最近三个月</option>
          <option value="all">全部日期</option>
          <option value="custom">自定义日期范围</option>
        </select>
      </label>
      {preset === 'custom' && (
        <div className="range-dates">
          <input
            aria-label="开始日期"
            type="date"
            value={start}
            onChange={(e) => change('custom', e.target.value, end)}
          />
          <span>至</span>
          <input
            aria-label="结束日期"
            type="date"
            value={end}
            onChange={(e) => change('custom', start, e.target.value)}
          />
        </div>
      )}
      {preset !== 'custom' && start && (
        <small>
          {start} 至 {end}（含首尾）
        </small>
      )}
    </div>
  );
}
