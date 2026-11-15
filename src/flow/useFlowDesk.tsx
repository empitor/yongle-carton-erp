import { useEffect, useMemo, useRef } from 'react';
import type { FlowDocView, FlowKind } from '../../shared/business/index';
import { errorMessage } from '../../shared/core/index';
import { canEditBusiness, emit, notify as bottomNotice, useAuthState, hashParams } from '../ui/index';
import type { FlowActionContext } from './FlowActions';
import { useDeskWindows } from './desk-windows';
import { deskActions, useDeskWork } from './flow-desk-actions';
import { flowDocumentFor } from './flow-prefill';
import { isCorrectable } from './flow-words';
import { editorLookups, latest, lookupNeedKey, needsOfKey, type NamedRow } from './lookups';
import type { CatalogLists } from '../recordkit/catalog-api';
import { useCatalog } from '../recordkit/useCatalog';

type DeskOptions = {
  kind: FlowKind;
  setKind: (kind: FlowKind) => void;
  dialogOnly: boolean;
  /** 从别处带来的参数（没有时看地址栏） */
  launch?: Readonly<Record<string, string | undefined>>;
  /** 当前读到的这一类单据 */
  rows: FlowDocView[];
  archived: boolean;
  revision: number;
  /** 列表这一页显示的行：没存名称的要读档案补上 */
  shownRows: FlowDocView[];
  showBoard: boolean;
  /** 列表正在读：和办理中一样，按钮先不让点 */
  loading: boolean;
  setSelected: (ids: number[]) => void;
  setNotice: (message: string) => void;
};

/** 采购单到货记录上的“更正到货单”带的是到货记录（flowId 是它的到货单），单据详情带的是单据本身 */
const isReceipt = (target: FlowDocView | { flowId: number }): target is { flowId: number } => 'flowId' in target;

/**
 * 档案按需读取并缓存：业务变化（revision 变了）后旧值仍可用来显示名称，编辑窗、核对、登记完工要用时再读最新的。
 * 同一份档案同时只读一次。当前打开的窗口和列表要用哪些档案写成一个键，键变了（或业务变了）才去读。
 */
function useDeskLookups(o: DeskOptions, w: ReturnType<typeof useDeskWindows>, setError: (message: string) => void) {
  const { kind, rows, archived, revision } = o;
  const auth = useAuthState();
  // 连同已归档的一起读要超级管理员模式（服务端 includeArchivedFor，全站列表同一个判断）
  const lookupAll = !!auth?.actor?.superAdminMode;
  // 生产任务列表（非归档、看不了已归档的）本身就是任务清单，不再重复读一遍。
  const tasksFromRows = kind === 'task' && !archived && !lookupAll;
  const taskList = useMemo(
    () => (tasksFromRows ? { tasks: rows.filter((r): r is FlowDocView<'task'> => r.kind === 'task') } : undefined),
    [tasksFromRows, rows],
  );
  const catalog = useCatalog({ all: lookupAll, revision, given: taskList });
  // 编辑窗的单据类型：编辑已有单据时跟着那张单据，新建时就是这个页面的类型
  const editorKind: FlowKind = w.editor?.kind || kind;
  const needKey = lookupNeedKey({
    kind,
    editorKind: w.editor ? editorKind : null,
    preview: w.preview?.document,
    batch: !!w.batch,
    view: w.view,
    showBoard: o.showBoard,
    unnamed: [...o.shownRows, w.scheduling],
    tasksFromRows,
  });
  // 读档案用这一次渲染的读法（读法每次渲染都是新函数，不当作重读的理由）
  const ensureNow = useRef(catalog.ensure);
  useEffect(() => {
    ensureNow.current = catalog.ensure;
  });
  const signedIn = !!auth?.actor;
  useEffect(() => {
    if (!needKey || !signedIn) return;
    let active = true;
    ensureNow.current(needsOfKey(needKey)).catch((e: unknown) => {
      if (active) setError(errorMessage(e));
    });
    return () => {
      active = false;
    };
  }, [needKey, revision, lookupAll, signedIn, setError]);
  return { ...catalog, auth, editorKind };
}

/** 列表里一行的往来方或产品：单据上存了名称的用存的，没存的按档案补上（档案里也查不到时没有） */
function rowLabel(kind: FlowKind, data: CatalogLists, r: NamedRow): string | undefined {
  if (kind === 'arrival') return r.supplierName || data.suppliers.find((s) => s.id === r.supplierId)?.name;
  if (kind === 'delivery') return r.customerName || data.customers.find((s) => s.id === r.customerId)?.name;
  return r.productName || data.products.find((s) => s.id === r.productId)?.name;
}

/**
 * 详情操作条要用的：账号情况和办理的函数。按钮只给对应种类的单据（FlowActionBar），
 * 这里按种类收窄后交给对应的窗口。
 */
function deskActionContext(o: {
  w: ReturnType<typeof useDeskWindows>;
  actions: ReturnType<typeof deskActions>;
  begin: (value?: FlowDocView) => Promise<void>;
  data: CatalogLists;
  flags: Pick<FlowActionContext<FlowDocView>, 'local' | 'superMode' | 'canEdit' | 'busy'>;
}): FlowActionContext<FlowDocView> {
  const { w, actions, data } = o;
  return {
    ...o.flags,
    begin: (doc) => void o.begin(doc),
    setView: w.setView,
    review: (doc) => void actions.review(doc),
    openCompletion: (ids) => void actions.openCompletion(ids),
    exportDelivery: (doc) => {
      if (doc.kind === 'delivery') w.setExporting(doc);
    },
    setScheduling: (doc) => {
      if (doc.kind === 'task' || doc.kind === 'delivery') actions.startScheduling(doc);
    },
    setReturning: (doc) => {
      if (doc.kind === 'arrival') w.setReturning(doc);
    },
    // 详情留着：更正、编辑窗口办完只关自己，详情跟着列表刷新（原单显示“已更正为 ××”）
    correct: (target) => {
      if (isReceipt(target)) w.setCorrecting({ id: target.flowId, kind: 'arrival' });
      else if (isCorrectable(target.kind)) w.setCorrecting({ id: target.id, kind: target.kind });
    },
    editInfo: (doc) => {
      if (doc.kind !== 'task') w.setEditingInfo(doc);
    },
    ask: actions.ask,
    setContextId: w.setContextId,
    markDelivered: (doc) => {
      if (doc.kind === 'delivery') w.setDelivering(doc);
    },
    // 任务详情读到的完工记录里，这张任务名下还待核对入库的（剩下的都在等核对入库时，主按钮直接核对）
    pendingCompletions: (taskId) => data.productions.filter((p) => p.taskId === taskId && p.status === 'draft' && !p.archived),
  };
}

/**
 * 单据（生产任务、完工、到货、送货）的办理：读档案、编辑窗、核对、登记完工、撤销取消归档、调整排程……
 * 单据页（FlowPage）和从别处弹出来的单据窗口都用它；窗口本身在 FlowDeskDialogs.tsx。
 * 办完一件事后：从别的页面弹出来的窗口直接关掉、提示显示在页面底部；单据页里在右侧面板显示刚办完的单据。
 */
export function useFlowDesk(o: DeskOptions) {
  const { kind, setKind, dialogOnly, launch, rows, setSelected, setNotice } = o;
  const w = useDeskWindows();
  const { busy: workBusy, error, setError, work } = useDeskWork();
  const busy = workBusy || o.loading;
  const { ensure: ensureLookups, data, loaded, ready, auth, editorKind } = useDeskLookups(o, w, setError);
  const canEdit = canEditBusiness(auth);
  const local = !!auth?.actor?.localAdministrator;
  const superMode = !!auth?.actor?.superAdminMode;
  // 业务数据变了：列表、详情、今日页都靠这个事件重读（单据页自己也在听）
  const refresh = () => emit('erp-business-changed');
  const { setView } = w;
  useEffect(() => {
    setView((current) => (current && rows.find((r) => r.id === current.id)) || current);
  }, [rows, setView]);
  /** 链接参数：从别处带来的，或地址栏里的 */
  const linkParams = () =>
    launch
      ? new URLSearchParams(Object.entries(launch).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])))
      : hashParams();
  /**
   * 打开编辑窗：先读这类单据要用的最新档案，再装进单据（编辑已有的；新建只剩没有采购单的到货）。
   * 读档案期间 opening 大于 0；档案没读到也打开编辑窗，原因显示在窗里，可以取消后重试。
   */
  const begin = async (value?: FlowDocView) => {
    w.saveRequest.current = crypto.randomUUID();
    setError('');
    w.setOpening((n) => n + 1);
    const k = value?.kind || kind;
    try {
      await ensureLookups(latest(editorLookups[k])).catch((e: unknown) => setError(errorMessage(e)));
      const next = flowDocumentFor(k, value);
      w.setOpened(true);
      w.setEditor(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      w.setOpening((n) => n - 1);
    }
  };
  const notify = (message: string) => (dialogOnly ? bottomNotice(message) : setNotice(message));
  const actions = deskActions({
    ...w, kind, dialogOnly, editorKind, setSelected, setNotice, setError, notify, refresh, ensureLookups, work,
  });
  const actionContext = deskActionContext({ w, actions, begin, data, flags: { local, superMode, canEdit, busy } });
  // 报错时开着的窗口（详情、核对、编辑、确认、调整排程）会把原因显示出来，关窗时就不再重复提示。
  // 按报错那一刻开着的窗口算：窗口的开关记在 windowOpen 里，只在报错变了时记下
  const errorShown = useRef(false);
  const windowOpen = useRef(false);
  useEffect(() => {
    windowOpen.current = !!(w.editor || w.view || w.preview || w.action || w.scheduling);
  });
  useEffect(() => {
    errorShown.current = !!error && windowOpen.current;
  }, [error]);
  // 给页面和窗口用的：窗口状态、档案、办理动作
  return {
    ...w, ...actions,
    auth, canEdit, local, superMode,
    data, loaded, ready, busy, error, setError, editorKind,
    editorReady: ready(latest(editorLookups[editorKind])),
    errorShown, kind, setKind, dialogOnly, refresh, notify,
    clearSelection: () => setSelected([]),
    hasLaunch: !!launch,
    linkParams, begin, work, actionContext,
    labelRow: (r: NamedRow) => rowLabel(kind, data, r),
  };
}
export type FlowDesk = ReturnType<typeof useFlowDesk>;
