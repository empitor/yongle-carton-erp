import type { FlowKind } from '../../shared/core/index';
import { useEffect, useRef } from 'react';
import type { FlowDocView } from '../../shared/business/index';
import { readOnlyNotice, notify } from '../ui/index';
import type { FlowDesk } from './useFlowDesk';

type LaunchOptions = {
  desk: FlowDesk;
  mode: FlowKind;
  kind: FlowKind;
  setKind: (kind: FlowKind) => void;
  archived: boolean;
  rows: FlowDocView[];
  /** 列表读完时记下的“类别|是否归档”，用来判断链接里的单据确实不在列表里 */
  listed: string;
  onClose?: () => void;
  /** 安排生产只有一个窗口（TaskPlanDialog）：从链接新建生产任务时打开它，带着订单 */
  planTask: (orderIds: number[]) => void;
};

/** 只读账号从链接、搜索面板或别的页面点进来要新建、办理的：不打开编辑窗，说一句为什么 */
function refuse(desk: FlowDesk) {
  desk.setError(readOnlyNotice);
  desk.setOpened(true);
  return true;
}

/** 链接里的单据在列表里：按参数编辑、核对、导出送货单，或只看；只读账号只看这张，不打开编辑和核对 */
function showLinkedRow(desk: FlowDesk, row: FlowDocView, params: URLSearchParams) {
  const writing = ['edit', 'review'].some((key) => params.get(key) === '1');
  if (writing && !desk.canEdit) {
    desk.setError(readOnlyNotice);
    desk.setView(row);
  } else if (params.get('edit') === '1' && row.status === 'draft') void desk.begin(row);
  else if (params.get('review') === '1' && row.status === 'draft') void desk.review(row);
  // 送货单直接打开导出窗（待送货的导出就是出库，已出库的重新下载）
  else if (params.get('export') === '1' && row.kind === 'delivery') desk.setExporting(row);
  else desk.setView(row);
}

/** 打开链接里的那张单据。返回 true 是办完了（打开了，或说了打不开的原因），false 是还要等 */
function openLinkedDoc(o: LaunchOptions, params: URLSearchParams) {
  const { desk } = o;
  const row = o.rows.find((r) => r.id === Number(params.get('doc')));
  if (row) {
    showLinkedRow(desk, row, params);
    desk.setOpened(true);
    return true;
  }
  // 列表还没读完，先等
  if (o.listed !== o.kind + '|' + o.archived) return false;
  if (o.mode === 'task' && o.kind !== 'production') {
    o.setKind('production');
    return false;
  }
  if (!desk.dialogOnly) return false;
  // 从别处点开的单据在列表里找不到（读取失败、已删除或已归档）：说清原因再关窗，不能点了没反应
  if (!desk.error) desk.setError('没找到这张单据，可能已被删除或归档，请刷新后再看。');
  desk.setOpened(true);
  return true;
}

/** 链接要登记完工或新建：返回 true 是办完了，false 是链接里没有这些 */
function openLinkedCreate(o: LaunchOptions, params: URLSearchParams) {
  const { desk, kind } = o;
  if (kind === 'production' && params.get('task')) {
    // 登记完工只有一个窗口：从订单、今日带着任务进来，打开登记完工窗口，只列这一张
    if (!desk.canEdit) return refuse(desk);
    desk.setOpened(true);
    void desk.openCompletion([Number(params.get('task'))]);
    return true;
  }
  if (!(desk.hasLaunch || params.get('create') === '1' || params.get('order'))) return false;
  if (!desk.canEdit) return refuse(desk);
  // 安排生产、登记完工各只有一个窗口；单据编辑窗只用来新建没有采购单的到货
  if (kind === 'task') o.planTask(params.get('order') ? [Number(params.get('order'))] : []);
  else if (kind === 'production') void desk.openCompletion([]);
  else void desk.begin();
  return true;
}

/**
 * 按链接参数（地址栏，或从别处带来的 launch）打开单据窗口：打开某张单据
 * （编辑、核对、导出送货单）、登记某张任务的完工、带着内容新建。只开一次。
 * 从别处弹出（dialogOnly）时，窗口全关了就退出；没办成的事用页面底部提示说出原因，不悄悄关掉。
 */
export function useFlowLaunch(o: LaunchOptions) {
  const { desk, onClose } = o;
  const { auth, busy, error, dialogOnly } = desk;
  const linkedOpened = useRef(false);
  // 每次都按这一次渲染的单据、列表和权限判断；只在档案、列表、登录状态这些变了时去试，办成一次以后不再试
  const attempt = useRef(() => {});
  useEffect(() => {
    attempt.current = () => {
      if (linkedOpened.current || !auth?.actor || busy) return;
      const params = desk.linkParams();
      linkedOpened.current = params.get('doc') ? openLinkedDoc(o, params) : openLinkedCreate(o, params);
    };
  });
  useEffect(() => attempt.current(), [desk.data, o.rows, busy, auth?.actor, o.kind, o.listed]);
  const closing = useRef(false);
  useEffect(() => {
    if (dialogOnly && !closing.current && desk.opened && !busy && !desk.anyOpen) {
      // 从别处弹出的窗口都关了：没办成的事（例如核对时被服务端拒绝）用页面提示说出原因，不能悄悄关掉
      if (error && !desk.errorShown.current) notify(error, 'error');
      closing.current = true;
      onClose?.();
    }
  }, [dialogOnly, desk.opened, busy, desk.anyOpen, onClose, error, desk.errorShown]);
}
