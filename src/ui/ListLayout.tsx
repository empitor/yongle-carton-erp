import { useState, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
} from 'lucide-react';
import { pageActions, type PageActionProps } from './Actions';

/**
 * 页头：标题、一行统计；右边是 children（月份、日期这类条件）和按钮（“更多”、一个次要、一个主按钮，
 * 规则见 Actions.tsx）。
 */
export function PageHeading({
  title,
  meta,
  children,
  ...actions
}: {
  title: string;
  description?: ReactNode;
  kicker?: string;
  /** 紧跟标题的统计，和标题同一行。 */
  meta?: ReactNode;
  /** 放在按钮左边的条件，例如月份 */
  children?: ReactNode;
} & PageActionProps) {
  const buttons = pageActions(actions);
  return (
    <div className="page-heading unified-heading">
      <div className="page-title">
        <h1>{title}</h1>
        {meta}
      </div>
      {(children || buttons) && (
        <div className="page-actions">
          {children}
          {buttons}
        </div>
      )}
    </div>
  );
}
export function ListSummary({
  items,
}: {
  items: {
    label: string;
    value: ReactNode;
    /** 口径说明：行内统计放不下，平时不显示 */
    hint?: string;
    /** 会改变读数意思的说明（比如“另有 2 种没算进去”）：一直显示，次要文字 */
    note?: string;
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
              {item.note && <small className="list-summary-note">{item.note}</small>}
            </button>
          ) : (
            <>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              {item.hint && <small>{item.hint}</small>}
              {item.note && <small className="list-summary-note">{item.note}</small>}
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

/** 列表每页条数：全站的列表一样，前端分页和按页读的请求都用它。 */
export const LIST_PAGE_SIZE = 50;

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
