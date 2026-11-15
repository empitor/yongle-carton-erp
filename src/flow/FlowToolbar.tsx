import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import type { FlowKind } from '../../shared/business/index';
import { DateFilter, FilterPopover, Segmented } from '../ui/index';
import { StatusFilter } from './ListParts';
import { title } from './lookups';
import type { useFlowList } from './useFlowList';

/**
 * 单据页列表上方：搜索、一个分段（生产任务多一个“排产板”，其余是待处理 / 全部 / 已归档）、
 * “筛选”里的状态和日期。排产板上只留分段。
 */
export default function FlowToolbar({
  list,
  mode,
  recycle,
  lead,
  closeView,
}: {
  list: ReturnType<typeof useFlowList>;
  mode: FlowKind;
  recycle: boolean;
  /** 嵌在别的页面时放在工具栏最前面的控件 */
  lead?: ReactNode;
  /** 换了看哪些记录：关掉打开着的详情 */
  closeView: () => void;
}) {
  const { kind, showBoard, archived, scope } = list;
  return (
    <div className="flow-toolbar" role="search">
      {!showBoard && (
        <label className="flow-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label={'搜索' + title(kind)}
            placeholder="搜索单号、产品、备注"
            value={list.q}
            onChange={(e) => list.setQ(e.target.value)}
          />
        </label>
      )}
      {lead}
      {!recycle && (
        <Segmented
          label="看哪些记录"
          value={showBoard ? 'board' : archived ? 'archived' : scope}
          onChange={(key) => {
            closeView();
            if (key === 'board') {
              list.setArchived(false);
              list.setListView(false);
              return;
            }
            list.setListView(true);
            if (key === 'archived') list.setArchived(true);
            else if (key === 'open' || key === 'all') {
              list.setArchived(false);
              list.setScope(key);
            }
          }}
          options={[
            ...(mode === 'task' && kind === 'task' ? [['board', '排产板'] as const] : []),
            ['open', '待处理'],
            ['all', '全部'],
            ['archived', '已归档'],
          ]}
        />
      )}
      {!showBoard && (
        <FilterPopover active={list.filterCount} onClear={list.clearFilters}>
          <StatusFilter kind={kind} label="状态" value={list.status} change={list.setStatus} />
          <DateFilter
            label={list.planned ? '计划日期' : '日期'}
            preset={list.datePreset}
            start={list.from}
            end={list.to}
            change={(preset, start, end) => {
              list.setDatePreset(preset);
              list.setFrom(start);
              list.setTo(end);
            }}
          />
        </FilterPopover>
      )}
    </div>
  );
}
