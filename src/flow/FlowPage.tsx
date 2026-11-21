import { Suspense, lazy, useState } from 'react';
import type { FlowKind, FlowDocView as DocView } from '../../shared/business/index';
import { DateFilter, FormMessage, LIST_PAGE_SIZE, ListToolbar, Pagination, loadingText, stepper } from '../ui/index';
import FlowPageHeading from './FlowPageHeading';
import FlowSelectionBar from './FlowSelectionBar';
import FlowDocView from './FlowDocView';
import FlowTable from './FlowTable';
import FlowDeskDialogs from './FlowDeskDialogs';
import ProductionBoard from './ProductionBoard';
import { ListEmpty, StatusFilter } from './ListParts';
import { title } from './lookups';
import { useFlowDesk, type FlowDesk } from './useFlowDesk';
import { useFlowLaunch } from './useFlowLaunch';
import { useFlowList, type FlowScope } from './useFlowList';

// 安排生产只有这一个窗口，点了才加载
const TaskPlanDialog = lazy(() => import('./TaskPlanDialog'));

/**
 * 生产任务、完工记录页；到货、送货页借它打开编辑窗和核对窗（dialogOnly）；归档页里列已归档的单据（recycle）。
 * 页头一个主按钮（安排生产 / 登记完工），列表默认只看待处理的，日期条件收在“筛选”里。
 * 列表在 useFlowList，办理（编辑、核对、撤销……）在 useFlowDesk，窗口在 FlowDeskDialogs，按链接打开窗口在 useFlowLaunch。
 */
export default function FlowPage({
  mode,
  recycle = false,
  embedded = false,
  dialogOnly = false,
  launch,
  onClose,
}: {
  mode: FlowKind;
  recycle?: boolean;
  /** 嵌在别的页面里：不显示页头 */
  embedded?: boolean;
  dialogOnly?: boolean;
  launch?: {
    order?: string;
    product?: string;
    stock?: string;
    doc?: string;
    plannedDate?: string;
    /** 和 doc 一起：打开编辑窗 */
    edit?: string;
    /** 和 doc 一起：核对入库 / 不导出直接出库 */
    review?: string;
    lines?: string;
    /** 完工：带着这张任务打开登记完工窗口 */
    task?: string;
    /** 和 doc 一起：送货单直接打开导出窗 */
    export?: string;
  };
  onClose?: () => void;
}) {
  const list = useFlowList({ mode, recycle, dialogOnly });
  const { kind, rows, archived, showBoard, filtered, selected, setSelected } = list;
  const [notice, setNotice] = useState('');
  const desk = useFlowDesk({
    kind,
    setKind: list.setKind,
    dialogOnly,
    launch,
    rows,
    archived,
    revision: list.revision,
    shownRows: dialogOnly || showBoard ? [] : list.sliced,
    showBoard,
    loading: list.loading,
    setSelected,
    setNotice,
  });
  const { view, setView } = desk;
  // 安排生产窗口：页头进来什么都没选（按产品排），链接带着订单进来按订单排
  const [planning, setPlanning] = useState<number[] | null>(null);
  useFlowLaunch({ desk, mode, kind, setKind: list.setKind, archived, rows, listed: list.listed, onClose, planTask: setPlanning });
  const steps = stepper(filtered, (r) => r.id, view?.id, (r, i) => {
    setView(r);
    list.setPage(Math.floor(i / LIST_PAGE_SIZE) + 1);
  });
  return (
    <div className="flow-page">
      {!dialogOnly && (
        <>
          {!embedded && !recycle && (
            <FlowPageHeading desk={desk} kind={kind} rows={rows} plan={() => setPlanning([])} />
          )}
          <FormMessage>{desk.error || list.error}</FormMessage>
          {notice && (
            <div className="success-banner" role="status">
              {notice}
            </div>
          )}
          <FlowToolbar list={list} mode={mode} recycle={recycle} closeView={() => setView(null)} />
          <FlowListBody list={list} desk={desk} recycle={recycle} plan={() => setPlanning([])} />
          <FlowSelectionBar
            desk={desk}
            kind={kind}
            archived={archived}
            count={showBoard ? 0 : selected.length}
            selected={selected}
            selectedRows={rows.filter((r) => selected.includes(r.id))}
            clear={() => setSelected([])}
          />
        </>
      )}
      <FlowDeskDialogs desk={desk} />
      {planning && (
        <Suspense fallback={null}>
          <TaskPlanDialog
            orderIds={planning}
            close={() => setPlanning(null)}
            done={(message) => {
              setPlanning(null);
              setNotice(message);
            }}
          />
        </Suspense>
      )}
      <FlowDocView desk={desk} dialog={dialogOnly} {...steps} />
    </div>
  );
}

/**
 * 列表上方：搜索、一个分段（生产任务多一个“排产板”，其余是待处理 / 全部 / 已归档；归档页不显示）、
 * “筛选”里的状态和日期。排产板上只留分段。换了看哪些记录就关掉打开着的详情。
 */
function FlowToolbar({
  list,
  mode,
  recycle,
  closeView,
}: {
  list: ReturnType<typeof useFlowList>;
  mode: FlowKind;
  recycle: boolean;
  closeView: () => void;
}) {
  const { kind, showBoard, archived, scope } = list;
  const pick = (key: string) => {
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
  };
  return (
    <ListToolbar
      search={list.q}
      onSearch={showBoard ? undefined : list.setQ}
      placeholder="搜索单号、产品、备注"
      searchLabel={'搜索' + title(kind)}
      scopes={recycle ? undefined : flowScopes(mode === 'task' && kind === 'task')}
      scope={showBoard ? 'board' : archived ? 'archived' : scope}
      onScope={pick}
      scopeLabel="看哪些记录"
      filters={
        !showBoard && (
          <>
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
          </>
        )
      }
      filterCount={list.filterCount}
      onClearFilters={list.clearFilters}
    />
  );
}

/** 单据页的分段：生产任务页多一个排产板 */
const flowScopes = (board: boolean) => [
  ...(board ? [{ value: 'board', label: '排产板' }] : []),
  { value: 'open', label: '待处理' },
  { value: 'all', label: '全部' },
  { value: 'archived', label: '已归档' },
];

/** 列表区：生产任务的排产板，或单据表格（空着时说为什么、给下一步）加翻页 */
function FlowListBody({
  list,
  desk,
  recycle,
  plan,
}: {
  list: ReturnType<typeof useFlowList>;
  desk: FlowDesk;
  recycle: boolean;
  plan: () => void;
}) {
  const { kind, rows, archived, showBoard, filtered, sliced, selected, setSelected } = list;
  const { canEdit, busy, data, view, setView } = desk;
  const searched = !!(list.q || list.filterCount);
  return showBoard ? (
    <ProductionBoard
      tasks={rows.filter((r) => r.kind === 'task')}
      // 产品档案读到之前先用任务单里存的产品名，避免卡片先显示“产品 编号”。
      products={desk.loaded('products') ? data.products : taskProducts(rows)}
      canEdit={canEdit}
      open={setView}
      reschedule={desk.reschedule}
    />
  ) : (
    <section className="panel business-records flow-records">
      <FlowTable
        kind={kind}
        filtered={filtered}
        sliced={sliced}
        selected={selected}
        setSelected={setSelected}
        view={view}
        setView={setView}
        labelRow={desk.labelRow}
      />
      {!sliced.length && (
        <ListEmpty
          text={busy ? loadingText() : emptyText(kind, searched, archived, list.scope)}
          busy={busy}
          filtered={searched}
          clear={() => {
            list.setQ('');
            list.clearFilters();
          }}
          next={
            canEdit && !archived && !recycle && (
              <EmptyNext kind={kind} plan={plan} complete={() => void desk.openCompletion([])} />
            )
          }
        />
      )}
      <Pagination page={list.page} total={filtered.length} pageSize={LIST_PAGE_SIZE} onChange={list.setPage} />
    </section>
  );
}

/** 产品档案读到之前，排产板上的产品名先用任务单里存的 */
function taskProducts(rows: DocView[]) {
  return rows.flatMap((r) => (r.kind === 'task' && r.productName ? [{ id: r.productId, name: r.productName }] : []));
}

/** 列表空着时说的那句（读取中另说） */
function emptyText(kind: FlowKind, searched: boolean, archived: boolean, scope: FlowScope) {
  if (searched) return '没有符合条件的记录。';
  if (archived) return '没有已归档的' + title(kind) + '。';
  if (scope === 'all') return '还没有' + title(kind) + '。';
  return kind === 'task' ? '没有待处理的生产任务。' : '没有待入库的完工记录。';
}

/** 列表空着、也没筛选时的下一步：生产任务页安排生产，完工记录页登记完工 */
function EmptyNext({ kind, plan, complete }: { kind: FlowKind; plan: () => void; complete: () => void }) {
  if (kind === 'task')
    return (
      <button className="secondary" onClick={plan}>
        安排生产
      </button>
    );
  if (kind === 'production')
    return (
      <button className="secondary" onClick={complete}>
        登记完工
      </button>
    );
  return null;
}
