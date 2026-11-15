import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { FilterPopover, Segmented } from '../ui/index';

type Scope = { value: string; label: string };

/**
 * 档案、订单、采购、库存列表的工具栏，一行：搜索 + 一个分段（待处理 / 全部 / 已归档 这类）
 * + 最多一个关键下拉 + “筛选”（其余条件收进弹层，有条件时按钮上显示个数）。
 * 统计数只在页头出现，这里不写数字。
 */
export default function ListToolbar({
  search,
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
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
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
    <section className="list-filters list-toolbar" aria-label="列表筛选">
      <div className="list-filters-primary list-toolbar-row">
        <label className="list-search">
          <span className="sr-only">{searchLabel}</span>
          <div>
            <Search size={16} aria-hidden="true" />
            <input
              aria-label={searchLabel}
              placeholder={placeholder}
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
        </label>
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
        {keyFilter && <div className="list-toolbar-key">{keyFilter}</div>}
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
      </div>
      {note && <div className="list-toolbar-note">{note}</div>}
    </section>
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
