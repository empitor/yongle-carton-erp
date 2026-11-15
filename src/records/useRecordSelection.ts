import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { errorMessage, type RecordSort } from '../../shared/core/index';
import type { RecordEntity } from '../../shared/business/index';
import { emit, listen, useAction, LIST_PAGE_SIZE } from '../ui/index';
import { lifecycleOutcome } from '../recordkit/lifecycle';
import { requestLifecycle } from '../recordkit/record-api';

/** 提供时由服务端分页和排序，rows 只是当前页。 */
export type RecordPaging = {
  page: number;
  total: number;
  onPage: (page: number) => void;
  sort: RecordSort;
  onSort: (sort: RecordSort) => void;
};
/** 列表上方的提示只放没办成的事：读不出、归档或恢复失败。办成的由页面统一提示一次（changed） */
type Message = { text: string; tone: 'warning' | 'danger' } | null;
/** 列表里的一条：这里只读编号、版本、单号或名称（行的类型由列表给） */
type SelectRow = { id: number; version: number; number?: string; name?: string };
type SetView<R> = (row: R | null | ((current: R | null) => R | null)) => void;
type Edge = RefObject<'first' | 'last' | null>;
/** 地址里能直接打开的记录种类（订单 order=，其余 record=） */
const routeEntities: readonly RecordEntity[] = ['orders', 'purchases', 'products', 'stock_items'];
/** 按一条读这一类记录（recordkit/record-api.ts 的 readRecord），由列表传进来：读回来的就是列表里那种行 */
type ReadRow<R> = (id: number | string) => Promise<R>;

/** 详情看哪条，记着是哪类记录：从客户详情点“新建订单”跳到订单页时，旧的客户记录不会被当成订单渲染（会白屏） */
function useEntityView<R extends SelectRow>(entity: RecordEntity): [R | null, SetView<R>] {
  const [viewState, setViewState] = useState<{ entity: RecordEntity; row: R } | null>(null);
  const setView: SetView<R> = (row) =>
    setViewState((s) => {
      const current = s?.entity === entity ? s.row : null,
        next = typeof row === 'function' ? row(current) : row;
      return next ? { entity, row: next } : null;
    });
  return [viewState?.entity === entity ? viewState.row : null, setView];
}

/** 地址里带 order= / record= 时打开那一条（产品详情点附属的产品、库存品 #warehouse?kind=…&record=，含已归档的） */
function useRouteRecord<R extends SelectRow>(
  entity: RecordEntity,
  read: ReadRow<R>,
  open: SetView<R>,
  setMessage: (text: string) => void,
) {
  const routeHash = typeof location === 'undefined' ? '' : location.hash;
  // 只跟着地址和记录类型重读；读、打开、提示用当时最新的那几个函数
  const fetchRow = useEffectEvent(read),
    show = useEffectEvent(open),
    report = useEffectEvent(setMessage);
  useEffect(() => {
    const params = new URLSearchParams(routeHash.split('?')[1] || '');
    const id = params.get(entity === 'orders' ? 'order' : 'record');
    if (!id || !/^\d+$/.test(id) || !routeEntities.includes(entity)) return;
    let active = true;
    fetchRow(id)
      .then((row) => {
        if (!active) return;
        if (row) show(row);
        else report('记录不存在或当前账号不可查看。');
      })
      .catch((e: unknown) => active && report(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [entity, routeHash]);
}

/**
 * 详情跟着数据走：订单、采购单被生产、送货或确认改变后按主键重读（这张单可能已不在当前筛选结果里）；
 * 列表换了一份时换成新的那一行；面板切到页边翻了页的，新一页到达后选首行或末行。
 */
function useFollowRows<R extends SelectRow>(o: {
  entity: RecordEntity;
  read: ReadRow<R>;
  rows: R[];
  view: R | null;
  setView: SetView<R>;
  pendingEdge: Edge;
}) {
  const { entity, rows, view, setView, pendingEdge } = o;
  const replace = useEffectEvent(setView),
    reread = useEffectEvent(o.read);
  useEffect(() => {
    if (!view?.id || (entity !== 'orders' && entity !== 'purchases')) return;
    const refresh = () =>
      void reread(view.id)
        .then((fresh: R) => replace((v) => (v?.id === fresh.id ? fresh : v)))
        // 后台重读没读到（断网、刚被删）：详情留着原来那条，列表重读会带出最新的情况，不另外提示
        .catch(() => {});
    return listen('erp-business-changed', refresh);
  }, [view?.id, entity]);
  // 只跟着 rows 换：页边要选的首行、末行和 setView 用当时最新的
  const follow = useEffectEvent((list: R[]) => {
    if (pendingEdge.current && list.length) {
      setView(pendingEdge.current === 'first' ? list[0] : list[list.length - 1]);
      pendingEdge.current = null;
      return;
    }
    setView((current) => (current ? list.find((r) => r.id === current.id) || current : null));
  });
  useEffect(() => follow(rows), [rows]);
}

/** 批量归档恢复：档案和单据同一个批量接口、同一套说法；全办成页面提示一次，有没办成的只在列表上方说一次，不再交给页面重复 */
function useLifecycle<R extends SelectRow>(o: {
  entity: RecordEntity;
  noun: { noun: string; unit: string };
  changed: (message?: string) => void;
  setMessage: (text: string, tone?: 'warning' | 'danger') => void;
  setSelected: (ids: number[]) => void;
}) {
  const lifecycle = useAction();
  const execute = (selection: { action: 'archive' | 'restore'; rows: R[] }) =>
    void lifecycle.run(async () => {
      try {
        const results = await requestLifecycle(`/${o.entity}/batch`, selection.action, selection.rows);
        const name = (id: number) => {
          const row = selection.rows.find((r) => r.id === id);
          return row?.number || row?.name || o.noun.noun;
        };
        const outcome = lifecycleOutcome(selection.action, results, name, o.noun.unit);
        o.setMessage(outcome.problem, outcome.tone);
        o.setSelected(outcome.failed.map((r) => r.id));
        emit('erp-business-changed');
        o.changed(outcome.notice || undefined);
      } catch (e) {
        o.setMessage(errorMessage(e));
      }
    });
  return { busy: lifecycle.busy, execute };
}

/**
 * 记录列表的选择和翻看：右侧详情看哪条、勾选、本地分页、面板上一条下一条（到页边先翻页）、
 * 批量归档恢复、采购单到货记录的“更正”。
 */
export function useRecordSelection<R extends SelectRow>(o: {
  entity: RecordEntity;
  noun: { noun: string; unit: string };
  rows: R[];
  sortedRows: R[];
  /** 按一条重读（地址里带的那条、业务变了重读详情那条） */
  read: ReadRow<R>;
  /** 范围或筛选变了：清掉勾选、回第一页、关掉详情 */
  resetKey: string;
  paging?: RecordPaging;
  changed: (message?: string) => void;
}) {
  const { entity, rows, paging } = o;
  const [view, setView] = useEntityView<R>(entity);
  const [selected, setSelected] = useState<number[]>([]),
    [localPage, setPage] = useState(1),
    [message, setMessageState] = useState<Message>(null),
    [correction, setCorrection] = useState<{ id: number } | null>(null);
  const setMessage = (text: string, tone: 'warning' | 'danger' = 'danger') =>
    setMessageState(text ? { text, tone } : null);
  const page = paging?.page ?? localPage,
    filteredTotal = paging?.total ?? rows.length;
  const pendingEdge: Edge = useRef<'first' | 'last' | null>(null);
  useRouteRecord(entity, o.read, setView, setMessage);
  useFollowRows({ entity, read: o.read, rows, view, setView, pendingEdge });
  // 范围或筛选变了才清；setMessage、setView 用当时最新的
  const reset = useEffectEvent(() => {
    setSelected([]);
    setPage(1);
    setMessage('');
    setView(null);
  });
  useEffect(() => reset(), [entity, o.resetKey]);
  // 列表里的记录换了（按编号比）才收拢勾选和页码，同一批记录重读不动
  const rowIds = rows.map((r) => r.id).join(',');
  const prune = useEffectEvent(() => {
    setSelected((s) => s.filter((id) => rows.some((r) => r.id === id)));
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(rows.length / LIST_PAGE_SIZE))));
  });
  useEffect(() => prune(), [rowIds]);
  const lifecycle = useLifecycle<R>({ entity, noun: o.noun, changed: o.changed, setMessage, setSelected });
  /** 面板上一条、下一条：到本页边上时由服务端分页的翻一页，新一页到了再选首行或末行 */
  const stepView = (delta: number) => {
    const index = o.sortedRows.findIndex((r) => r.id === view?.id),
      next = o.sortedRows[index + delta];
    if (next) {
      setView(next);
      if (!paging) setPage(Math.floor((index + delta) / LIST_PAGE_SIZE) + 1);
      return;
    }
    const target = page + delta;
    if (!paging || index < 0 || target < 1 || target > Math.ceil(filteredTotal / LIST_PAGE_SIZE)) return;
    pendingEdge.current = delta > 0 ? 'first' : 'last';
    paging.onPage(target);
  };
  /** 采购单详情里到货记录的“更正到货单”：按这次到货的到货单更正（更正窗打开时读最新的内容） */
  const correct = (receipt: { flowId: number }) => {
    setView(null);
    setCorrection({ id: receipt.flowId });
  };
  return {
    view,
    setView,
    selected,
    setSelected,
    page,
    setPage,
    filteredTotal,
    message,
    setMessage,
    busy: lifecycle.busy,
    executeLifecycle: lifecycle.execute,
    stepView,
    correction,
    setCorrection,
    correct,
  };
}
/** 列表的选择和翻看（useRecordSelection 返回的那些） */
export type RecordSelection<R extends SelectRow> = ReturnType<typeof useRecordSelection<R>>;
