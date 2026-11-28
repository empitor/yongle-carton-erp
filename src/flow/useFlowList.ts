import { useEffect, useState } from 'react';
import { matchesFlowStatus, planDate, type FlowDocView } from '../../shared/business/index';
import { pageIdOf, pageParams, type DatePreset, type FlowKind } from '../../shared/core/index';
import { isPhoneNow, LIST_PAGE_SIZE, useBusinessRevision, useLoad } from '../ui/index';
import { readFlowList } from './flow-api';
import { isOpen } from './flow-dates';

export type FlowScope = 'open' | 'all';

/** 列表的筛选条件：一行符不符合（搜索、状态、日期、待处理） */
function flowFilter(
  kind: FlowKind,
  f: { archived: boolean; scope: FlowScope; q: string; status: string; from: string; to: string },
  dateOf: (r: FlowDocView) => string,
) {
  const q = f.q.toLowerCase();
  return (r: FlowDocView) =>
    r.kind === kind &&
    (f.archived || f.scope === 'all' || isOpen(r)) &&
    (!q || JSON.stringify(r).toLowerCase().includes(q)) &&
    matchesFlowStatus(r, kind, f.status) &&
    (!f.from || dateOf(r) >= f.from) &&
    (!f.to || dateOf(r) <= f.to);
}

/** 地址栏带来的列表条件（日期是合法的 YYYY-MM-DD 才有）：单据页也会从别的页面弹出来，按地址所在那一页的登记表读 */
type FlowRoute = { scope?: string; pending?: boolean; date?: string; view?: string; archived?: boolean; q?: string };
function flowRoute(hash: string): FlowRoute {
  const page = pageIdOf(hash);
  return page ? pageParams(page, hash) : {};
}

/** 地址栏带来的“看哪些”：看全部、某一天的看全部；只看待处理、生产任务默认只看待处理；完工记录默认全部 */
const routeScope = (route: FlowRoute, routeDate: string, kind: FlowKind): FlowScope =>
  route.scope === 'all' || routeDate ? 'all' : route.pending || kind === 'task' ? 'open' : 'all';

/**
 * 单据页的列表：读这一类单据（业务数据变了就重读）、筛选（搜索、状态、日期、待处理）、排序、翻页、勾选。
 * 地址栏带来的条件（看全部、只看待处理、某一天、已归档、完工记录）在打开时用一次。
 */
export function useFlowList({ mode, recycle, dialogOnly }: { mode: FlowKind; recycle: boolean; dialogOnly: boolean }) {
  const route = flowRoute(location.hash);
  const routeDate = route.date ?? '';
  // 排产板靠拖动，手机上默认用列表；从链接带了筛选条件进来的也看列表。
  const [listView, setListView] = useState(
    isPhoneNow() || route.scope === 'all' || !!route.pending || !!routeDate,
  );
  const [kind, setKind] = useState<FlowKind>(
      mode === 'task' && route.view === 'production' ? 'production' : mode,
    ),
    [q, setQ] = useState(''),
    [status, setStatus] = useState(''),
    [archived, setArchived] = useState(recycle || !!route.archived),
    // 待处理：生产任务默认只看没做完的；完工记录默认全部（登记即入库，待入库的很少）
    [scope, setScope] = useState<FlowScope>(() => routeScope(route, routeDate, kind)),
    [datePreset, setDatePreset] = useState<DatePreset>(routeDate ? 'custom' : 'all'),
    [from, setFrom] = useState(routeDate),
    [to, setTo] = useState(routeDate),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<number[]>([]);
  const [revision] = useBusinessRevision();
  // 打开和保存后只读当前列表；对照用的档案见 useFlowDesk 的 ensureLookups。
  const list = useLoad(kind + '|' + archived, () => readFlowList(kind, archived), revision);
  const rows = list.data || [];
  const showBoard = kind === 'task' && mode === 'task' && !listView && !recycle && !archived && !dialogOnly;
  const planned = kind === 'task' || kind === 'delivery';
  const dateOf = (r: FlowDocView) => (planned ? planDate(r) : r.date);
  const filtered = rows
      .filter(flowFilter(kind, { archived, scope, q, status, from, to }, dateOf))
      // 待处理的按计划日先后排，最急的在上面；其余按日期新的在上面（服务端顺序）
      .sort((a, b) =>
        scope === 'open' && !archived && planned ? (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : 0) : 0,
      ),
    sliced = filtered.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);
  useEffect(() => {
    setSelected([]);
    setPage(1);
  }, [q, status, from, to, archived, scope, kind]);
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE))));
  }, [filtered.length]);
  const filterCount = (status ? 1 : 0) + (from || to ? 1 : 0);
  const clearFilters = () => {
    setStatus('');
    setDatePreset('all');
    setFrom('');
    setTo('');
  };
  return {
    kind, setKind, rows, revision, loading: list.loading, error: list.error,
    // 列表读完时记下读的是哪一类、是否归档，用来判断“链接里的单据确实不在列表里”
    listed: list.loading ? '' : kind + '|' + archived,
    listView, setListView, q, setQ, status, setStatus, archived, setArchived, scope, setScope,
    datePreset, setDatePreset, from, setFrom, to, setTo, page, setPage, selected, setSelected,
    showBoard, planned, filtered, sliced, filterCount, clearFilters,
  };
}
