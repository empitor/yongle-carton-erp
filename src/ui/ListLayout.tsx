import { useState, type ReactNode } from 'react';
import {
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Inbox,
} from 'lucide-react';
export function PageHeading({
  title,
  description,
  kicker,
  actions,
}: {
  title: string;
  description: ReactNode;
  kicker?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading unified-heading">
      <div>
        {kicker && <div className="heading-kicker">{kicker}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="list-filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function ListFilters({
  search,
  onSearch,
  searchLabel = '搜索业务记录',
  placeholder,
  children,
  dates,
  extras,
  onReset,
  note,
  busy = false,
}: {
  search: string;
  onSearch: (value: string) => void;
  searchLabel?: string;
  placeholder: string;
  children?: ReactNode;
  dates?: ReactNode;
  extras?: ReactNode;
  onReset: () => void;
  note?: ReactNode;
  busy?: boolean;
}) {
  const reset = (
    <button className="filter-reset" onClick={onReset}>
      <RotateCcw size={14} />
      重置筛选
    </button>
  );
  return (
    <section className="list-filters" aria-label="列表筛选">
      <div className="list-filters-primary">
        <label className="list-search">
          <span>关键词</span>
          <div>
            <Search size={16} />
            <input
              aria-label={searchLabel}
              placeholder={placeholder}
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
        </label>
        {children}
        {!dates && reset}
      </div>
      {dates && (
        <div className="list-filters-secondary">
          {dates}
          <div className="list-filter-extras">
            {extras}
            {reset}
          </div>
        </div>
      )}
      {!dates && extras && <div className="list-filter-extras">{extras}</div>}
      {(note || busy) && (
        <div className="list-filter-note">
          <span>{note}</span>
          {busy && <span role="status">正在更新…</span>}
        </div>
      )}
    </section>
  );
}
export function ListSummary({
  items,
}: {
  items: {
    label: string;
    value: ReactNode;
    hint?: string;
    onClick?: () => void;
    active?: boolean;
  }[];
}) {
  return (
    <div className="list-summary" aria-label="列表统计">
      {items.map((item, i) => (
        <div key={i}>
          {item.onClick ? (
            <button className="metric-select" onClick={item.onClick} aria-pressed={!!item.active}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              {item.hint && <small>{item.hint}</small>}
            </button>
          ) : (
            <>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              {item.hint && <small>{item.hint}</small>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
export function EmptyState({
  title = '暂无符合条件的记录',
  description = '可调整日期、状态或关键词，或重置筛选后重试。',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="records-empty">
      <Inbox size={23} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}
export function TableRegion({
  children,
  label = '业务记录表格',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <>
      <p className="table-scroll-hint">表格可左右滚动，查看完整明细与操作。</p>
      <div
        className="table-wrap unified-table-region"
        role="region"
        tabIndex={0}
        aria-label={label + '，可左右滚动'}
      >
        {children}
      </div>
    </>
  );
}
/** 页码随筛选条件复位：条件一变立刻回到第一页，不会先用旧页码多发一次请求。 */
export function useResettingPage(signature: string) {
  const [state, setState] = useState({ signature, page: 1 });
  // 渲染期间更新，确保换回原条件时不会恢复旧页码。
  if (state.signature !== signature) setState({ signature, page: 1 });
  const page = state.signature === signature ? state.page : 1;
  return [page, (next: number) => setState({ signature, page: next })] as const;
}

export function Pagination({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager unified-pager">
      <span>
        共 {total} 条 · 每页 {pageSize} 条
      </span>
      <div>
        <button aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft size={15} />
        </button>
        <span>
          {page} / {pages}
        </span>
        <button aria-label="下一页" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
