import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import FilterPopover from './FilterPopover';
import Segmented from './Segmented';

type Scope = { value: string; label: string };

/**
 * 列表的工具栏（订单、档案、采购、库存、流水，单据页的生产任务、完工记录，到货、送货，收件箱、财务台账），一行：
 * 搜索 + 一个分段（待处理 / 全部 / 已归档 这类，要带条数就写进分段的字里）+ 最多一个关键下拉
 * + “筛选”（其余条件收进弹层，有条件时按钮上显示个数）。
 * 不给 onSearch 就不放搜索框（排产板、财务台账上只留分段）。统计数只在页头出现，这里不写数字。
 * label 是整条工具栏读屏时的名字（收件箱、台账各叫各的）。
 */
export default function ListToolbar({
  label = '列表筛选',
  search = '',
  onSearch,
  placeholder,
  searchLabel = '搜索',
  scopes,
  scope,
  onScope,
  scopeLabel = '记录范围',
  keyFilter,
  filters,
  filterCount = 0,
  onClearFilters,
  busy = false,
  note,
}: {
  label?: string;
  search?: string;
  onSearch?: (value: string) => void;
  placeholder?: string;
  searchLabel?: string;
  scopes?: readonly Scope[];
  scope?: string;
  onScope?: (value: string) => void;
  scopeLabel?: string;
  /** 工具栏上常驻的那一个关键下拉，例如采购单的供应商 */
  keyFilter?: ReactNode;
  /** 收进“筛选”弹层的条件 */
  filters?: ReactNode;
  filterCount?: number;
  onClearFilters?: () => void;
  busy?: boolean;
  /** 列表上方一句说明，例如“只看零库存 · 显示全部” */
  note?: ReactNode;
}) {
  return (
    <ListToolbarFrame label={label} note={note}>
      {onSearch && <ListSearch value={search} onChange={onSearch} label={searchLabel} placeholder={placeholder} />}
      {scopes && scopes.length > 1 && (
        <Segmented
          tabs
          className="list-toolbar-scope"
          label={scopeLabel}
          value={scope || ''}
          onChange={(v) => onScope?.(v)}
          options={scopes.map((s) => [s.value, s.label] as const)}
        />
      )}
      {keyFilter && <ListToolbarKey>{keyFilter}</ListToolbarKey>}
      {filters && (
        <FilterPopover active={filterCount} onClear={onClearFilters}>
          {filters}
        </FilterPopover>
      )}
      {busy && (
        <span className="list-toolbar-busy" role="status">
          正在更新…
        </span>
      )}
    </ListToolbarFrame>
  );
}

/**
 * 工具栏的外框：一行控件，下面可以有一句说明。ListToolbar 往里放标准的几样；
 * 数据管理窗的一行是模块下拉、搜索、条数、刷新、新建（没有分段和弹层），硬套 ListToolbar 要加只给它用的开关，
 * 所以它只共用外框、搜索框和关键下拉的位置（ListToolbarKey、ListSearch），其余自己放。
 */
export function ListToolbarFrame({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="list-filters list-toolbar" aria-label={label}>
      <div className="list-filters-primary list-toolbar-row">{children}</div>
      {note && <div className="list-toolbar-note">{note}</div>}
    </section>
  );
}

/** 工具栏上常驻的那一个关键下拉的位置（宽度、手机上占满剩下的宽） */
export function ListToolbarKey({ children }: { children: ReactNode }) {
  return <div className="list-toolbar-key">{children}</div>;
}

/** 工具栏里带放大镜的搜索框 */
export function ListSearch({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <label className="list-search">
      <span className="sr-only">{label}</span>
      <div>
        <Search size={16} aria-hidden="true" />
        <input aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}

/** 弹层里的一个条件：上面一行小字标签，下面是控件。 */
export function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="list-toolbar-filter">
      <span>{label}</span>
      {children}
    </label>
  );
}
