import { useState } from 'react';
import { pageHref, pageParams, presetRange, type DatePreset } from '../../shared/core/index';
import { Segmented, DateFilter, FormMessage, Loading, useBusinessRevision, useLoad } from '../ui/index';
import { loadDashboard } from './list-api';
import TodayQueue from './TodayQueue';
import BusinessOverview from './BusinessOverview';
import { readListFilters } from './record-filters';

const views = ['todo', 'overview'] as const;
type View = (typeof views)[number];
const isView = (value: string): value is View => (views as readonly string[]).includes(value);
/** 地址里带 view=overview 时直接打开经营概况；切换只改地址不触发重新读取。 */
const initialView = (): View =>
  pageParams('dashboard', location.hash).view === 'overview' ? 'overview' : 'todo';

/**
 * 今日：默认只放待办（自己读，不等经营概况）；经营数字在同一页的“经营概况”里，切过去才读，不另开页面。
 */
export default function DashboardPage() {
  const [view, setView] = useState<View>(initialView);
  const choose = (next: View) => {
    setView(next);
    const current = pageParams('dashboard', location.hash);
    history.replaceState(null, '', pageHref('dashboard', { ...current, view: next === 'overview' ? 'overview' : undefined }));
  };
  return (
    <div className="td-page">
      <Segmented
        tabs
        className="td-switch"
        label="今日内容"
        value={view}
        onChange={(v) => {
          if (isView(v)) choose(v);
        }}
        options={[
          ['todo', '今日待办'],
          ['overview', '经营概况'],
        ]}
      />
      {view === 'todo' ? <TodayQueue /> : <OverviewSection />}
    </div>
  );
}

/** 经营概况的统计日期和数据：日期默认按地址（没写就是最近两个月），业务数据变了重读。 */
function OverviewSection() {
  const [range, setRange] = useState(() => {
    const f = readListFilters();
    return { preset: f.preset, start: f.start, end: f.end, customerId: f.customerId };
  });
  const [revision] = useBusinessRevision();
  const query = {
    customerId: range.customerId || undefined,
    start: range.start || undefined,
    end: range.end || undefined,
  };
  const { data, error } = useLoad([range.customerId, range.start, range.end, revision].join('|'), () =>
    loadDashboard(query),
  );
  const change = (preset: DatePreset, start: string, end: string) => setRange((r) => ({ ...r, preset, start, end }));
  /** 清除筛选：回到最近两个月，不按客户 */
  const reset = () => {
    const r = presetRange('2');
    setRange({ preset: '2', start: r.start, end: r.end, customerId: '' });
  };
  if (error) return <FormMessage>{error}</FormMessage>;
  if (!data)
    return (
      <div className="td-empty">
        <Loading what="经营概况" />
      </div>
    );
  return (
    <BusinessOverview
      data={data}
      rangeFilter={
        <div className="filter-bar">
          <DateFilter label="统计日期" preset={range.preset} start={range.start} end={range.end} change={change} />
          <button onClick={reset}>清除筛选</button>
        </div>
      }
    />
  );
}
