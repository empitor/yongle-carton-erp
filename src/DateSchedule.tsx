import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BUSINESS_TIME_ZONE, dateSchema, today } from '../shared/domain';
import { shiftDate } from '../shared/schedule';

export default function DateSchedule({
  value,
  onChange,
  counts,
  label,
}: {
  value: string;
  onChange: (date: string) => void;
  counts: Record<string, { total: number; completed: number }>;
  label: string;
}) {
  const [current, setCurrent] = useState(today());
  useEffect(() => {
    const timer = window.setInterval(() => setCurrent(today()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const relative = (date: string) =>
    date === shiftDate(current, -1)
      ? '昨天'
      : date === current
        ? '今天'
        : date === shiftDate(current, 1)
          ? '明天'
          : date === shiftDate(current, 2)
            ? '后天'
            : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
  return (
    <section className="date-schedule" aria-label={label + '日期排程'}>
      <div className="schedule-heading">
        <strong>{label}排程</strong>
        <span>
          {value} · 业务时区 {BUSINESS_TIME_ZONE}
        </span>
        <button onClick={() => onChange(current)}>回到今天</button>
        <label>
          选择日期
          <input
            type="date"
            min="0000-01-01"
            max="9999-12-31"
            aria-label={label + '计划日期'}
            value={value}
            onChange={(e) =>
              dateSchema.safeParse(e.target.value).success && onChange(e.target.value)
            }
          />
        </label>
      </div>
      <div className="schedule-strip">
        <button aria-label="查看前七天" onClick={() => onChange(shiftDate(value, -7))}>
          <ChevronLeft size={18} />
        </button>
        <div className="schedule-days" role="group" aria-label="选择排程日期">
          {[...new Set(Array.from({ length: 7 }, (_, i) => shiftDate(value, i - 1)))].map(
            (date) => (
              <button
                key={date}
                className={
                  'schedule-day' +
                  (date === value ? ' selected' : '') +
                  (date === current ? ' today' : '')
                }
                aria-pressed={date === value}
                onClick={() => onChange(date)}
              >
                <strong>{relative(date)}</strong>
                <span>{date.slice(5).replace('-', '/')}</span>
                <small>
                  {counts[date]?.total || 0} 项 · 已完成 {counts[date]?.completed || 0}
                </small>
              </button>
            ),
          )}
        </div>
        <button aria-label="查看后七天" onClick={() => onChange(shiftDate(value, 7))}>
          <ChevronRight size={18} />
        </button>
      </div>
    </section>
  );
}
