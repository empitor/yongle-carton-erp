import Field from './ui/Field';
import { FlowEditor } from './flow/FlowEditor';
import FlowDetails from './flow/FlowDetails';
import { useEffect, useState, useRef } from 'react';
import { Plus, FileUp, Printer, RefreshCw } from 'lucide-react';
import {
  flowNames,
  flowStates,
  flowStatusLabel,
  matchesFlowStatus,
  flowInput,
  type FlowKind,
} from '../shared/physical-flow';
import { quantityString } from '../shared/operations';
import { today, dateSchema } from '../shared/domain';
import { managementRequest, useAuthState } from './session';
import ManagementDialog from './ManagementDialog';
import { PageHeading, ListFilters, FilterField, ListSummary, Pagination } from './ui/ListLayout';
import DateRangeFilter from './DateRangeFilter';
import { presetRange, type DatePreset } from '../shared/date-ranges';
import ReceiptRecognition from './ReceiptRecognition';
import { ZodError } from 'zod';
import { StockEditor } from './operations/Editors';
import { deliveryCandidates } from '../shared/warehouse-delivery';
import { blankArrivalLine } from '../shared/arrival-draft';
import RecordContextDialog, { RecordRelations } from './RecordContext';
import DatabaseDeleteDialog from './DatabaseDeleteDialog';
import ReceiptCorrectionDialog from './ReceiptCorrectionDialog';
import DateSchedule from './DateSchedule';
import ProductionBoard from './ProductionBoard';
import DetailPanel from './ui/DetailPanel';
import { isPhoneNow } from './mobile/MobileNav';
import BusinessExport from './BusinessExport';
import ProductionBatchDialog from './ProductionBatchDialog';
import { planDate, scheduleSummary } from '../shared/schedule';

export { blankArrivalLine } from '../shared/arrival-draft';
const title = (kind: FlowKind) =>
  kind === 'arrival'
    ? '采购到货管理'
    : kind === 'task'
      ? '生产任务'
      : kind === 'production'
        ? '完工记录'
        : '客户送货管理';

const FLOW_PAGE_SIZE = 50;
export default function FlowPage({
  mode,
  recycle = false,
  embedded = false,
  dialogOnly = false,
  scheduleView = true,
  launch,
  onClose,
}: {
  mode: FlowKind;
  recycle?: boolean;
  embedded?: boolean;
  dialogOnly?: boolean;
  scheduleView?: boolean;
  launch?: {
    order?: string;
    product?: string;
    stock?: string;
    doc?: string;
    purchase?: string;
    plannedDate?: string;
    isPlan?: string;
    receivePlan?: string;
    edit?: string;
    ai?: string;
    lines?: string;
  };
  onClose?: () => void;
}) {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (!!auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const linkedOpened = useRef(false);
  const working = useRef(false),
    saveRequest = useRef(crypto.randomUUID());
  const [opened, setOpened] = useState(false);
  const [batchCompletion, setBatchCompletion] = useState(false);
  const [contextId, setContextId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<any[] | null>(null);
  const [receiptCorrection, setReceiptCorrection] = useState<any>(null);
  const routeParams = new URLSearchParams(location.hash.split('?')[1] || '');
  const [scheduleDate, setScheduleDate] = useState(
    dateSchema.safeParse(routeParams.get('date')).success ? routeParams.get('date')! : today(),
  );
  const [allDates, setAllDates] = useState(routeParams.get('scope') === 'all');
  const [pendingOnly, setPendingOnly] = useState(routeParams.get('pending') === '1');
  const [scheduling, setScheduling] = useState<any>(null);
  // 排产板靠拖动，手机上默认用列表。
  const [listView, setListView] = useState(isPhoneNow() || routeParams.get('scope') === 'all' || routeParams.get('pending') === '1');
  const [newPlanDate, setNewPlanDate] = useState('');
  const [newPlanTime, setNewPlanTime] = useState('');
  const scheduleRequest = useRef(crypto.randomUUID());
  const [kind, setKind] = useState<FlowKind>(
      mode === 'task' && routeParams.get('view') === 'production' ? 'production' : mode,
    ),
    [rows, setRows] = useState<any[]>([]),
    [data, setData] = useState<any>({
      suppliers: [],
      purchases: [],
      items: [],
      products: [],
      orders: [],
      customers: [],
      tasks: [],
    }),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [q, setQ] = useState(''),
    [status, setStatus] = useState(''),
    [archived, setArchived] = useState(
      recycle || new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1',
    ),
    [preset, setPreset] = useState<DatePreset>(
      routeParams.get('range') === 'custom' ? 'custom' : '2',
    ),
    [range, setRange] = useState(
      routeParams.get('range') === 'custom'
        ? { start: routeParams.get('start') || '', end: routeParams.get('end') || '' }
        : presetRange('2'),
    ),
    [page, setPage] = useState(1),
    [editor, setEditor] = useState<any>(null),
    [view, setView] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [action, setAction] = useState<any>(null),
    [reason, setReason] = useState(''),
    [selected, setSelected] = useState<number[]>([]),
    [ai, setAi] = useState(false),
    [stockSeed, setStockSeed] = useState<any>(null);
  const refresh = () => {
    setRevision((v) => v + 1);
    window.dispatchEvent(new Event('erp-business-changed'));
  };
  const arrivalReceipt = (doc: any) => {
    for (const purchase of data.purchases) {
      const receipt = purchase.receipts.find((r: any) => r.flowId === doc.id && r.effective);
      if (receipt) return { purchase, receipt };
    }
    return null;
  };
  useEffect(() => {
    setView((current: any) => (current && rows.find((r) => r.id === current.id)) || current);
  }, [rows]);
  const correctArrival = (doc: any) => {
    setView(null);
    setEditor(null);
    setReceiptCorrection(arrivalReceipt(doc));
  };
  useEffect(() => {
    const changed = () => setRevision((v) => v + 1);
    window.addEventListener('erp-business-changed', changed);
    return () => window.removeEventListener('erp-business-changed', changed);
  }, []);
  useEffect(() => {
    setSelected([]);
    setPage(1);
  }, [q, status, range, archived, kind]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    Promise.all([
      managementRequest<any[]>('/flow?kind=' + kind + (archived ? '&archived=1' : '')),
      managementRequest<any[]>(
        '/suppliers' + (auth?.actor?.localAdministrator ? '?archived=all' : ''),
      ),
      managementRequest<any[]>(
        '/purchases' + (auth?.actor?.localAdministrator ? '?archived=all' : ''),
      ),
      managementRequest<any[]>(
        '/warehouse/items' + (auth?.actor?.localAdministrator ? '?archived=all' : ''),
      ),
      managementRequest<any[]>(
        '/products' + (auth?.actor?.localAdministrator ? '?archived=all' : ''),
      ),
      managementRequest<any[]>(
        '/orders' + (auth?.actor?.localAdministrator ? '?archived=all' : ''),
      ),
      managementRequest<any[]>(
        '/customers' + (auth?.actor?.localAdministrator ? '?archived=all' : ''),
      ),
      managementRequest<any[]>(
        '/flow?kind=task' + (auth?.actor?.localAdministrator ? '&archived=all' : ''),
      ),
    ])
      .then(([r, suppliers, purchases, items, products, orders, customers, tasks]) => {
        if (active) {
          setRows(r);
          setData({ suppliers, purchases, items, products, orders, customers, tasks });
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [kind, archived, revision, auth?.actor?.localAdministrator]);
  const showBoard = kind === 'task' && mode === 'task' && !listView && !recycle && !archived && !dialogOnly;
  const filtered = rows.filter(
      (r) =>
        r.kind === kind &&
        (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) &&
        matchesFlowStatus(r, status) &&
        (!pendingOnly || (['draft', 'confirmed'].includes(r.status) && r.progress < 100)) &&
        (kind === 'task' || (kind === 'delivery' && scheduleView)
          ? allDates || planDate(r) === scheduleDate
          : (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end)),
    ),
    sliced = filtered.slice((page - 1) * FLOW_PAGE_SIZE, page * FLOW_PAGE_SIZE);
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(filtered.length / FLOW_PAGE_SIZE))));
  }, [filtered.length]);
  const begin = (value?: any) => {
    saveRequest.current = crypto.randomUUID();
    setOpened(true);
    setError('');
    const params = launch
      ? new URLSearchParams(launch)
      : new URLSearchParams(location.hash.split('?')[1] || '');
    const common = { date: today(), notes: '', correctionOf: null };
    const planned = {
      ...common,
      plannedDate: params.get('plannedDate') || scheduleDate,
      plannedTime: null,
      actualTime: null,
    };
    let v = value
      ? structuredClone(value)
      : kind === 'arrival'
        ? {
            ...common,
            isPlan: params.get('isPlan') === '1',
            plannedDate: params.get('plannedDate') || null,
            plannedTime: null,
            actualTime: null,
            supplierId: null,
            reference: '',
            sourceId: null,
            lines: [blankArrivalLine()],
          }
        : kind === 'task'
          ? { ...planned, productId: null, quantity: '', unit: '只', orderIds: [] }
          : kind === 'production'
            ? {
                ...common,
                productId: null,
                taskId: null,
                finishedStockId: null,
                goodQuantity: '',
                scrapQuantity: '0',
                operator: auth?.actor?.name || '',
                materials: [{ stockId: null, issued: '', returned: '0' }],
              }
            : {
                ...planned,
                customerId: null,
                address: '',
                contact: '',
                phone: '',
                allowOverdelivery: false,
                overdeliveryReason: '',
                lines: [
                  { orderId: null, orderLineId: null, stockId: null, quantity: '', notes: '' },
                ],
              };
    if (!value && kind === 'task' && params.get('order')) {
      const order = data.orders.find((o: any) => o.id === Number(params.get('order')));
      const line = order?.lines.find((l: any) => l.productId === Number(params.get('product')));
      v.orderIds = order ? [order.id] : [];
      v.productId = line?.productId || null;
      v.unit = line?.unit || '只';
      // 只用“下一步”算好的缺口。不能把订单数量误当作已扣除其他任务的余量，所以其他入口仍留空。
      v.quantity = params.get('quantity') || '';
    }
    if (!value && kind === 'production' && params.get('task')) {
      const task = data.tasks.find((t: any) => t.id === Number(params.get('task')));
      if (task) {
        v.taskId = task.id;
        v.productId = task.productId;
        v.finishedStockId =
          data.items.find(
            (s: any) => s.kind === 'finished' && s.productId === task.productId && s.unit === task.unit,
          )?.id || null;
      }
    }
    if (!value && kind === 'delivery' && params.get('order')) {
      const order = data.orders.find((o: any) => o.id === Number(params.get('order')));
      if (order) {
        v.customerId = order.customerId;
        v.lines = order.lines
          .filter((l: any) => (l.remainingQuantity ?? l.quantity) > 0)
          .map((l: any) => ({
            orderId: order.id,
            orderLineId: l.id,
            stockId:
              data.items.find(
                (i: any) =>
                  i.kind === 'finished' &&
                  deliveryCandidates(i, order.customerId, [order]).some(
                    (c) => c.orderLineId === l.id,
                  ),
              )?.id || null,
            quantity: String(l.remainingQuantity ?? l.quantity),
            notes: l.notes || '',
          }));
      }
    }
    if (!value && kind === 'delivery' && params.get('lines')) {
      const preset = JSON.parse(params.get('lines')!);
      v.customerId = preset.customerId;
      v.lines = preset.lines.map((l: any) => ({ ...l, notes: '' }));
    }
    if (!value && kind === 'delivery' && v.customerId) {
      const customer = data.customers.find((c: any) => c.id === v.customerId);
      v.address = customer?.address || '';
      v.contact = customer?.contact || '';
      v.phone = customer?.phone || '';
    }
    if (!value && kind === 'delivery' && params.get('stock')) {
      v.lines[0].stockId = Number(params.get('stock'));
    }
    if (!value && kind === 'arrival' && params.get('purchase')) {
      const p = data.purchases.find((p: any) => p.id === Number(params.get('purchase')));
      if (p) {
        if (v.isPlan && !params.get('plannedDate')) v.plannedDate = p.expectedDate || today();
        v.supplierId = p.supplierId;
        v.lines = p.lines
          .filter((l: any) => l.quantityUnits > l.receivedUnits)
          .map((l: any) => ({
            ...blankArrivalLine(),
            stockId: l.stockItemId,
            purchaseLineId: l.id,
            item: { ...l },
            quantity: quantityString(l.quantityUnits - l.receivedUnits),
            unitPrice: l.unitPrice,
            priceBasis: l.priceBasis || 'quantity',
          }));
      }
    }
    setEditor(v);
  };
  useEffect(() => {
    if (linkedOpened.current || !auth?.actor || busy) return;
    const params = launch
      ? new URLSearchParams(launch)
      : new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.get('ai')) {
      setAi(true);
      setOpened(true);
      linkedOpened.current = true;
    } else if (params.get('receivePlan')) {
      const plan = rows.find((r) => r.id === Number(params.get('receivePlan')));
      if (plan) {
        begin({ ...plan, isPlan: false, date: today(), actualTime: null });
        linkedOpened.current = true;
      }
    } else if (params.get('doc')) {
      const row = rows.find((r) => r.id === Number(params.get('doc')));
      if (row) {
        if (params.get('edit') === '1' && row.status === 'draft') begin(row);
        else setView(row);
        setOpened(true);
        linkedOpened.current = true;
      } else if (mode === 'task' && kind !== 'production') setKind('production');
    } else if (launch || params.get('lines') || params.get('create') === '1' || params.get('purchase') || params.get('order') || params.get('stock')) {
      begin();
      linkedOpened.current = true;
    }
  }, [data, rows, busy, auth?.actor, kind]);
  useEffect(() => {
    if (
      dialogOnly &&
      opened &&
      !busy &&
      !editor &&
      !view &&
      !preview &&
      !action &&
      !ai &&
      !receiptCorrection
    )
      onClose?.();
  }, [dialogOnly, opened, busy, editor, view, preview, action, ai, receiptCorrection, onClose]);
  async function work(job: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(
        e instanceof ZodError
          ? [
              ...new Set(
                e.issues.map((i) =>
                  i.message === 'Invalid input: expected number, received null'
                    ? '请补齐标有星号的选择项。'
                    : i.message,
                ),
              ),
            ].join('；')
          : (e as Error).message,
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const save = () =>
    work(async () => {
      const parsed = flowInput(kind, editor),
        saved =
          auth?.actor?.localAdministrator && editor.id && editor.status !== 'draft'
            ? await managementRequest<any>('/management/execute', {
                requestId: saveRequest.current,
                module: kind,
                action: 'update',
                items: [{ id: editor.id, version: editor.version }],
                patch: parsed,
                reason: '管理员编辑业务单据',
              })
            : null,
        result = saved
          ? saved.results[0]
          : await managementRequest<any>(
              '/flow/' + (editor.id || kind),
              {
                ...parsed,
                requestId: saveRequest.current,
                ...(editor.id ? { version: editor.version } : {}),
              },
              editor.id ? 'PUT' : 'POST',
            );
      setEditor(null);
      setView(result);
      setNotice(
        saved && editor.status === 'confirmed' && result.id !== editor.id
          ? '更正已保存，原单据和冲销流水保留，库存已同步。'
          : '单据已保存。',
      );
      refresh();
    });
  const review = (r: any) =>
    work(async () => {
      setPreview(await managementRequest('/flow/' + r.id + '/preview', {}));
      setView(null);
    });
  const confirm = () =>
    work(async () => {
      const result = await managementRequest('/flow/' + preview.document.id + '/confirm', {
        previewId: preview.previewId,
        requestId: preview.requestId || (preview.requestId = crypto.randomUUID()),
        acknowledged: true,
      });
      setPreview(null);
      setView(result);
      setNotice('已确认，业务单据和库存流水已在同一事务保存。');
      refresh();
    });
  const perform = () =>
    work(async () => {
      const results = [];
      if (auth?.actor?.localAdministrator) {
        await managementRequest('/management/execute', {
          requestId: action.requestId,
          module: kind,
          action: action.type,
          items: action.rows.map((r: any) => ({ id: r.id, version: r.version })),
          reason: reason.trim() || '管理员业务管理',
        });
        setAction(null);
        setView(null);
        setSelected([]);
        refresh();
        setNotice('操作已保存，历史及审计记录已保留。');
        return;
      }
      for (const r of action.rows) {
        try {
          await managementRequest(
            '/flow/' +
              r.id +
              '/' +
              (action.type === 'archive' || action.type === 'restore' ? 'lifecycle' : action.type),
            action.type === 'archive' || action.type === 'restore'
              ? { action: action.type, version: r.version, acknowledged: true }
              : { version: r.version, reason, acknowledged: true },
          );
          results.push({ id: r.id, success: true });
        } catch (e) {
          results.push({ id: r.id, success: false, message: (e as Error).message });
        }
      }
      setAction(null);
      setView(null);
      setSelected([]);
      refresh();
      const failed = results.filter((r) => !r.success);
      if (failed.length) setError(failed.map((r) => '单据' + r.id + '：' + r.message).join('；'));
      else setNotice('操作已保存，历史及审计记录已保留。');
    });
  const ask = (type: string, r: any[]) => {
    if (type === 'delete' || type === 'permanent-delete') {
      setDeleting(r);
      return;
    }
    if (type === 'archive' || type === 'restore') {
      void work(async () => {
        await managementRequest('/management/execute', {
          requestId: crypto.randomUUID(),
          module: kind,
          action: type,
          items: r.map((x) => ({ id: x.id, version: x.version })),
          reason: '管理员' + type,
        });
        setView(null);
        setSelected([]);
        refresh();
        setNotice(type === 'archive' ? '已归档，数据库记录保留。' : '已恢复归档记录。');
      });
      return;
    }
    setReason('');
    if (auth?.actor?.localAdministrator) {
      void work(async () => {
        const contexts = await Promise.all(
          r.map((x) => managementRequest('/management/context?module=' + kind + '&id=' + x.id)),
        );
        setAction({
          type,
          rows: r,
          requestId: crypto.randomUUID(),
          impactDigests: Object.fromEntries(contexts.map((c) => [c.id, c.impactDigest])),
          hasDownstream: contexts.some((c) =>
            c.related.some(
              (x: any) =>
                x.direction !== 'upstream' &&
                ['arrival', 'task', 'production', 'delivery'].includes(x.module),
            ),
          ),
        });
      });
    } else setAction({ type, rows: r, requestId: crypto.randomUUID() });
  };
  const labelRow = (r: any) =>
    kind === 'arrival'
      ? r.supplierName || data.suppliers.find((s: any) => s.id === r.supplierId)?.name
      : kind === 'delivery'
        ? r.customerName || data.customers.find((s: any) => s.id === r.customerId)?.name
        : r.productName || data.products.find((s: any) => s.id === r.productId)?.name;
  const viewTitle = (d: any) =>
    (d.kind === 'arrival' && d.isPlan ? '到货计划' : flowNames[d.kind as FlowKind]) + ' · ' + d.number;
  const stepView = (delta: number) => {
    const index = filtered.findIndex((r) => r.id === view?.id),
      next = filtered[index + delta];
    if (!next) return;
    setView(next);
    setPage(Math.floor((index + delta) / FLOW_PAGE_SIZE) + 1);
  };
  const viewActions = (view: any) => (
    <>
          {view.kind === 'arrival' && view.isPlan && view.status === 'draft' && canEdit && (
            <button
              className="primary"
              onClick={() => {
                begin({ ...view, isPlan: false, date: today(), actualTime: null });
                setView(null);
              }}
            >
              按此计划登记实际到货
            </button>
          )}
          {view.kind === 'task' &&
            canEdit &&
            !view.archived &&
            ['draft', 'confirmed'].includes(view.status) &&
            view.progress < 100 && (
              <button
                className="primary"
                onClick={() => {
                  setSelected([view.id]);
                  setBatchCompletion(true);
                }}
              >
                领料与完工入库
              </button>
            )}
          {view.kind === 'delivery' && (
            <>
              <a
                className="secondary"
                href={'/api/flow/' + view.id + '/print'}
                target="_blank"
                rel="noreferrer"
              >
                <Printer size={16} />
                打印 / 另存PDF
              </a>
              <BusinessExport
                kind="delivery"
                id={view.id}
                version={view.version}
                status={view.status}
              />
            </>
          )}
          {auth?.actor?.localAdministrator && view.status !== 'draft' && (
            <button
              className="primary"
              onClick={() => {
                if (
                  view.kind === 'arrival' &&
                  view.status === 'confirmed' &&
                  arrivalReceipt(view)
                )
                  correctArrival(view);
                else begin(view);
                setView(null);
              }}
            >
              编辑 / 更正单据
            </button>
          )}
          {view.status === 'draft' && !view.archived && (
            <>
              <button
                className="secondary"
                disabled={!canEdit}
                onClick={() => {
                  begin(view);
                  setView(null);
                }}
              >
                编辑草稿
              </button>
              {!view.isPlan && (
                <button
                  className="primary"
                  disabled={!canEdit || busy}
                  onClick={() => review(view)}
                >
                  核对并确认
                  {view.kind === 'arrival' ? '收货' : view.kind === 'delivery' ? '发货' : ''}
                </button>
              )}
            </>
          )}
          {view.status === 'confirmed' && auth?.actor?.superAdminMode && (
            <button
              className="danger-button"
              onClick={() => {
                ask('reverse', [view]);
                setView(null);
              }}
            >
              冲销更正
            </button>
          )}
      {canEdit &&
        !view.archived &&
        ((view.kind === 'task' &&
          ['draft', 'confirmed'].includes(view.status) &&
          view.progress < 100) ||
          (view.kind === 'delivery' && view.status === 'draft')) && (
          <button
            onClick={() => {
              setScheduling(view);
              setNewPlanDate(planDate(view));
              setNewPlanTime(view.plannedTime || '');
              scheduleRequest.current = crypto.randomUUID();
            }}
          >
            调整排程
          </button>
        )}
      {canEdit &&
        view.kind === 'arrival' &&
        view.status === 'confirmed' &&
        arrivalReceipt(view) && <button onClick={() => correctArrival(view)}>更正到货单</button>}
      {view.status === 'draft' && !view.archived && (
        <button disabled={!canEdit} onClick={() => ask('cancel', [view])}>
          取消草稿
        </button>
      )}
      {view.kind === 'task' && view.status === 'confirmed' && view.progress < 100 && (
        <button disabled={!canEdit} onClick={() => ask('cancel', [view])}>
          取消剩余任务
        </button>
      )}
      {view.status === 'reversed' && auth?.actor?.superAdminMode && (
        <button
          onClick={() => {
            const copy = structuredClone(view);
            delete copy.id;
            delete copy.version;
            copy.correctionOf = view.id;
            setEditor(copy);
            setView(null);
          }}
        >
          建立更正草稿
        </button>
      )}
      <button
        disabled={!canEdit || busy}
        onClick={() => ask(view.archived ? 'restore' : 'archive', [view])}
      >
        {view.archived ? '恢复' : '归档'}
      </button>
      {auth?.actor?.localAdministrator && (
        <button onClick={() => setContextId(view.id)}>修改历史</button>
      )}
      <button
        className="danger-text"
        disabled={!auth?.actor?.localAdministrator || busy}
        onClick={() => ask('delete', [view])}
      >
        删除
      </button>
    </>
  );
  return (
    <div className="flow-page">
      {!dialogOnly && (
        <>
          {!embedded && (
            <PageHeading
              title={title(kind)}
              meta={
                <>
          {!showBoard && !archived && !embedded && (
            <ListSummary
              items={
                kind === 'task'
                  ? [
                      {
                        label: '已确认生产任务',
                        value: filtered.filter((r) => r.status === 'confirmed').length,
                      },
                      {
                        label: '尚未完工任务',
                        value: filtered.filter((r) => r.status === 'confirmed' && r.progress < 100)
                          .length,
                      },
                    ]
                  : [
                      { label: '当前范围单据', value: filtered.length },
                      {
                        label: '待核对草稿',
                        value: filtered.filter((r) => r.status === 'draft').length,
                      },
                    ]
              }
            />
          )}
                </>
              }
              description={
                kind === 'arrival'
                  ? '核对供应商送货单，确认实收后入原材料库存。'
                  : kind === 'delivery'
                    ? '草稿不扣库存，正式确认发货后更新交付进度。'
                    : '按实际领用、退料和合格数量登记，不预设纸板与纸箱的产量比例。'
              }
              actions={
                <>
                  {kind === 'arrival' && (
                    <button className="secondary" disabled={!canEdit} onClick={() => setAi(true)}>
                      <FileUp size={16} />
                      AI识别供应商送货单
                    </button>
                  )}
                  {kind === 'task' && (
                    <button disabled={!canEdit || busy} onClick={() => setBatchCompletion(true)}>
                      整批领料与完工
                    </button>
                  )}
                  <button
                    className="primary"
                    disabled={!canEdit || busy || archived}
                    onClick={() => begin()}
                  >
                    <Plus size={16} />
                    新建{kind === 'production' ? '完工记录' : flowNames[kind]}
                  </button>
                </>
              }
            />
          )}
          {mode === 'task' && kind === 'task' && !recycle && (
            <div className="record-view-tabs" aria-label="生产任务展示方式">
              <button className={showBoard ? 'selected' : ''} onClick={() => setListView(false)}>
                排产板
              </button>
              <button className={showBoard ? '' : 'selected'} onClick={() => setListView(true)}>
                列表
              </button>
            </div>
          )}
          {showBoard && (
            <ProductionBoard
              tasks={rows.filter((r) => r.kind === 'task')}
              products={data.products}
              canEdit={canEdit}
              open={setView}
              reschedule={(task, plannedDate) =>
                void work(async () => {
                  await managementRequest('/flow/' + task.id + '/schedule', {
                    plannedDate,
                    expectedVersion: task.version,
                    requestId: crypto.randomUUID(),
                  });
                  setNotice(task.number + ' 已改到 ' + plannedDate + '，实际业务与库存未改变。');
                  refresh();
                })
              }
            />
          )}
          {!showBoard && (kind === 'task' || (kind === 'delivery' && scheduleView)) && (
            <>
              <DateSchedule
                value={scheduleDate}
                onChange={(date) => {
                  setAllDates(false);
                  setScheduleDate(date);
                  setPage(1);
                  setSelected([]);
                }}
                label={kind === 'task' ? '生产' : '送货'}
                counts={Object.fromEntries(
                  [...new Set(rows.map(planDate))].map((date) => [
                    date,
                    scheduleSummary(rows.filter((r) => planDate(r) === date)),
                  ]),
                )}
              />
              <div className="schedule-daily-summary" aria-label="当日计划概览">
                {kind === 'task' && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={pendingOnly}
                      onChange={(e) => {
                        setPendingOnly(e.target.checked);
                        setPage(1);
                      }}
                    />
                    仅未完工任务
                  </label>
                )}
                <button className={!allDates ? 'selected' : ''} onClick={() => setAllDates(false)}>
                  当日任务
                </button>
                <button className={allDates ? 'selected' : ''} onClick={() => setAllDates(true)}>
                  全部日期
                </button>
                <span>
                  计划任务{' '}
                  <strong>
                    {scheduleSummary(rows.filter((r) => planDate(r) === scheduleDate)).total}
                  </strong>
                </span>
                <span>
                  待{kind === 'task' ? '生产' : '送货'}{' '}
                  <strong>
                    {scheduleSummary(rows.filter((r) => planDate(r) === scheduleDate)).pending}
                  </strong>
                </span>
                <span>
                  已完成{' '}
                  <strong>
                    {scheduleSummary(rows.filter((r) => planDate(r) === scheduleDate)).completed}
                  </strong>
                </span>
                <span>
                  计划数量{' '}
                  <strong>
                    {scheduleSummary(
                      rows.filter((r) => planDate(r) === scheduleDate),
                      (id) => data.items.find((s: any) => s.id === id)?.unit,
                    ).quantities || '—'}
                  </strong>
                </span>
                {embedded && (
                  <button className="primary" disabled={!canEdit || busy} onClick={() => begin()}>
                    安排当天送货
                  </button>
                )}
              </div>
            </>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="success-banner" role="status">
              {notice}
            </div>
          )}
          {!showBoard && <ListFilters
            search={q}
            onSearch={setQ}
            placeholder="搜索单号、备注和明细"
            onReset={() => {
              setPendingOnly(false);
              setQ('');
              setStatus('');
              setPreset('2');
              setRange(presetRange('2'));
              setScheduleDate(today());
            }}
            dates={
              kind !== 'task' && !(kind === 'delivery' && scheduleView) ? (
                <DateRangeFilter
                  preset={preset}
                  start={range.start}
                  end={range.end}
                  change={(p, s, e) => {
                    setPreset(p);
                    setRange({ start: s, end: e });
                  }}
                  label="业务日期"
                />
              ) : undefined
            }
          >
            <FilterField label="单据状态">
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">全部状态</option>
                {Object.entries(flowStates).map(([k, n]) => (
                  <option key={k} value={k}>
                    {n}
                  </option>
                ))}
                {kind === 'task' &&
                  ['待生产', '生产中', '已完工'].map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
              </select>
            </FilterField>
            {!recycle && (
              <FilterField label="记录视图">
                <select
                  value={archived ? '1' : '0'}
                  onChange={(e) => setArchived(e.target.value === '1')}
                >
                  <option value="0">正常业务</option>
                  <option value="1">已归档</option>
                </select>
              </FilterField>
            )}
          </ListFilters>}
          {selected.length > 0 && (
            <div className="flow-bulk">
              <strong>已选 {selected.length} 张</strong>
              <button
                className="danger-button"
                disabled={!canEdit || busy}
                onClick={() =>
                  ask(
                    archived ? 'restore' : 'archive',
                    rows.filter((r) => selected.includes(r.id)),
                  )
                }
              >
                {archived ? '批量恢复' : '批量归档'}
              </button>
              {auth?.actor?.localAdministrator && (
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() =>
                    ask(
                      'permanent-delete',
                      rows.filter((r) => selected.includes(r.id)),
                    )
                  }
                >
                  批量删除
                </button>
              )}
            </div>
          )}
          <section className="panel business-records flow-records">
            <div className="section-heading">
              <h3>
                <span className="sr-only">{flowNames[kind]}</span>
                <span className="record-title-count">
                  {filtered.length === rows.length
                    ? '共 ' + rows.length + ' 张'
                    : '筛选 ' + filtered.length + ' / 共 ' + rows.length + ' 张'}
                </span>
              </h3>
              <button onClick={refresh} disabled={busy}>
                <RefreshCw size={14} aria-hidden="true" />
                <span className="sr-only">刷新</span>
              </button>
            </div>
            <div className="table-wrap unified-table-region" tabIndex={0}>
              <table className="flow-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        aria-label="全选当前筛选结果"
                        type="checkbox"
                        checked={
                          filtered.length > 0 && filtered.every((r) => selected.includes(r.id))
                        }
                        onChange={(e) =>
                          setSelected(e.target.checked ? filtered.map((r) => r.id) : [])
                        }
                      />
                    </th>
                    <th>单号</th>
                    <th>{kind === 'arrival' ? '供应商' : kind === 'delivery' ? '客户' : '产品'}</th>
                    <th>{kind === 'task' ? '完工 / 计划' : '内容'}</th>
                    <th>{kind === 'task' || kind === 'delivery' ? '计划日期' : '日期'}</th>
                    {(kind === 'task' || kind === 'delivery') && <th>实际日期</th>}
                    <th>状态</th>
                    <th>登记人</th>
                  </tr>
                </thead>
                <tbody>
                  {sliced.map((r) => (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      className={'record-row' + (view?.id === r.id ? ' selected' : '')}
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest('input,button,a')) setView(r);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.target === e.currentTarget) setView(r);
                      }}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={'选择单据' + r.id}
                          checked={selected.includes(r.id)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked ? [...s, r.id] : s.filter((i) => i !== r.id),
                            )
                          }
                        />
                      </td>
                      <td className="record-no">
                        <button className="row-key" aria-label={'查看 ' + r.number} onClick={() => setView(r)}>
                          {r.number}
                        </button>
                      </td>
                      <td className="cell-wrap">{labelRow(r) || '历史档案'}</td>
                      <td>
                        {kind === 'task' ? (
                          <span className="inline-progress">
                            <span className="board-progress">
                              <i style={{ width: r.progress + '%' }} />
                            </span>
                            {r.completed} / {r.quantity} {r.unit}
                          </span>
                        ) : kind === 'production' ? (
                          <>
                            合格 {r.goodQuantity} · 报废 {r.scrapQuantity}
                            <span className="sub">{r.operator}</span>
                          </>
                        ) : (
                          <>
                            {r.lines.length} 条明细
                            <span className="sub">{r.reference || r.notes || ''}</span>
                          </>
                        )}
                      </td>
                      <td>{kind === 'task' || kind === 'delivery' ? planDate(r) : r.date}</td>
                      {kind === 'task' && <td>{r.actualCompletionDate || '—'}</td>}
                      {kind === 'delivery' && <td>{r.actualDate || '—'}</td>}
                      <td>
                        <span className={'badge flow-state-' + r.status}>
                          {r.archived ? '归档 · ' : ''}
                          {flowStatusLabel(r)}
                        </span>
                      </td>
                      <td>{r.actorName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!sliced.length && (
              <div className="empty-state">{busy ? '正在读取业务数据…' : '当前条件下暂无记录'}</div>
            )}
            <Pagination
              page={page}
              total={filtered.length}
              pageSize={FLOW_PAGE_SIZE}
              onChange={setPage}
            />
          </section>
        </>
      )}
      {deleting && (
        <DatabaseDeleteDialog
          module={kind}
          rows={deleting}
          close={() => setDeleting(null)}
          done={(message) => {
            setDeleting(null);
            setView(null);
            setSelected([]);
            setNotice(message);
            refresh();
          }}
        />
      )}
      {contextId !== null && (
        <RecordContextDialog module={kind} id={contextId} close={() => setContextId(null)} />
      )}
      {editor && !stockSeed && (
        <ManagementDialog
          title={
            (editor.id ? '编辑' : '新建') +
            flowNames[kind] +
            (editor.id && editor.status !== 'draft' && auth?.actor?.localAdministrator
              ? ''
              : '草稿')
          }
          close={() => setEditor(null)}
          busy={busy}
        >
          {auth?.actor?.localAdministrator && editor.status === 'confirmed' && kind !== 'task' && (
            <p>直接修改当前记录，并在同一事务同步关联、金额、实收量和库存余额。</p>
          )}
          <FlowEditor
            kind={kind}
            value={editor}
            change={(patch) => setEditor((v: any) => ({ ...v, ...patch }))}
            data={data}
            createFinished={() => {
              const p = data.products.find((p: any) => p.id === editor.productId),
                task = data.tasks.find((t: any) => t.id === editor.taskId),
                lines = data.orders.flatMap((o: any) =>
                  o.lines.filter((l: any) => l.productId === editor.productId),
                ),
                units = [...new Set(lines.map((l: any) => l.unit).filter(Boolean))],
                specs = [...new Set(lines.map((l: any) => l.specification).filter(Boolean))];
              setStockSeed({
                ...p,
                name: p?.name || '',
                productId: editor.productId,
                kind: 'finished',
                unit: task?.unit || (units.length === 1 ? units[0] : ''),
                specification: specs.length === 1 ? specs[0] : '',
              });
            }}
          />
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            {canEdit &&
              editor.kind === 'arrival' &&
              editor.status === 'confirmed' &&
              arrivalReceipt(editor) && (
                <button className="primary" onClick={() => correctArrival(editor)}>
                  更正到货单
                </button>
              )}
            <button className="secondary" disabled={busy} onClick={() => setEditor(null)}>
              取消
            </button>
            <button className="primary" disabled={busy} onClick={save}>
              {busy
                ? '正在保存…'
                : editor.id && editor.status !== 'draft' && auth?.actor?.localAdministrator
                  ? '保存修改'
                  : '保存草稿（不影响库存）'}
            </button>
          </div>
        </ManagementDialog>
      )}
      {stockSeed && (
        <StockEditor
          kind="finished"
          products={data.products}
          initialValues={stockSeed}
          close={() => setStockSeed(null)}
          saved={(item) => {
            setData((d: any) => ({ ...d, items: [...d.items, item] }));
            setEditor((v: any) => ({ ...v, finishedStockId: item.id }));
            setStockSeed(null);
            setNotice('成品档案已建立，当前库存为零；生产草稿填写内容已保留。');
            refresh();
          }}
        />
      )}
      {view &&
        (dialogOnly ? (
          <ManagementDialog title={viewTitle(view)} close={() => setView(null)}>
            <FlowDetails doc={view} data={data} />
            <div className="modal-actions">{viewActions(view)}</div>
          </ManagementDialog>
        ) : (
          <DetailPanel
            title={viewTitle(view)}
            status={
              <span className={'badge flow-state-' + view.status}>
                {view.archived ? '归档 · ' : ''}
                {flowStatusLabel(view)}
              </span>
            }
            actions={viewActions(view)}
            close={() => setView(null)}
            previous={() => stepView(-1)}
            next={() => stepView(1)}
          >
            <FlowDetails doc={view} data={data} />
          </DetailPanel>
        ))}
      {preview && (
        <ManagementDialog
          title={
            kind === 'task' ? '核对生产任务 · 不改变库存' : '最后核对 · 确认后同步更新业务与库存'
          }
          close={() => setPreview(null)}
          busy={busy}
        >
          <FlowDetails doc={preview.document} data={data} />
          {preview.sourceHash && (
            <p className="sub">原始送货文件已永久保存 · SHA-256 {preview.sourceHash}</p>
          )}
          <h3>本次库存影响</h3>
          <div className="table-wrap">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>库存品</th>
                  <th>业务</th>
                  <th>变动数量</th>
                  <th>当前库存</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c: any, i: number) => (
                  <tr key={i}>
                    <td>
                      {c.name}
                      {!c.stockId && '（新建完整独立档案）'}
                    </td>
                    <td>{c.reason}</td>
                    <td>
                      {c.deltaUnits > 0 ? '+' : '−'}
                      {quantityString(Math.abs(c.deltaUnits))} {c.unit}
                    </td>
                    <td>
                      {c.stockId ? data.items.find((s: any) => s.id === c.stockId)?.quantity : '0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!preview.changes.length && <p>确认生产任务，不改变库存。</p>}
          {preview.warnings.map((w: string) => (
            <p className="flow-warning" key={w}>
              {w}
            </p>
          ))}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setPreview(null)}>
              返回核对
            </button>
            <button className="primary" disabled={busy} onClick={confirm}>
              已逐项核对，正式确认
            </button>
          </div>
        </ManagementDialog>
      )}
      {batchCompletion && (
        <ProductionBatchDialog
          tasks={data.tasks.map((t: any) => ({
            ...t,
            productName: data.products.find((p: any) => p.id === t.productId)?.name,
          }))}
          items={data.items}
          selected={selected}
          close={() => setBatchCompletion(false)}
          done={(r) => {
            setBatchCompletion(false);
            setNotice(r.message);
            window.dispatchEvent(new Event('erp-business-changed'));
            refresh();
          }}
        />
      )}
      {scheduling && (
        <ManagementDialog title="调整计划日期" close={() => setScheduling(null)} busy={busy}>
          <div className="schedule-dialog">
            <p>
              {scheduling.number} · {labelRow(scheduling)}
            </p>
            <label>
              计划日期
              <input
                type="date"
                aria-label="新的计划日期"
                value={newPlanDate}
                onChange={(e) => setNewPlanDate(e.target.value)}
              />
            </label>
            <label>
              计划时间（选填）
              <input
                type="time"
                value={newPlanTime}
                onChange={(e) => setNewPlanTime(e.target.value)}
              />
            </label>
            <p>只调整排程，不登记实际生产或发货，也不改变库存。</p>
            <div className="management-dialog-actions">
              <button onClick={() => setScheduling(null)} disabled={busy}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy || !newPlanDate}
                onClick={() =>
                  void work(async () => {
                    await managementRequest('/flow/' + scheduling.id + '/schedule', {
                      plannedDate: newPlanDate,
                      plannedTime: newPlanTime || null,
                      expectedVersion: scheduling.version,
                      requestId: scheduleRequest.current,
                    });
                    setScheduleDate(newPlanDate);
                    setScheduling(null);
                    setNotice('计划日期已调整，实际业务与库存未改变。');
                    refresh();
                  })
                }
              >
                保存排程
              </button>
            </div>
          </div>
        </ManagementDialog>
      )}
      {receiptCorrection && (
        <ReceiptCorrectionDialog
          {...receiptCorrection}
          close={() => setReceiptCorrection(null)}
          done={(result) => {
            setReceiptCorrection(null);
            setNotice(result.summary || '到货更正已核验。');
            refresh();
          }}
        />
      )}
      {action && (
        <ManagementDialog
          title={
            action.type === 'reverse'
              ? '冲销单据与反向库存更正'
              : action.type === 'cancel'
                ? '取消草稿或剩余生产任务'
                : action.type === 'restore'
                  ? '恢复业务记录'
                  : action.type === 'permanent-delete'
                    ? '永久删除业务单据'
                    : '移入归档记录'
          }
          close={() => setAction(null)}
          busy={busy}
          danger={action.type !== 'restore'}
        >
          <p>
            将处理 {action.rows.length} 张单据：{action.rows.map((r: any) => r.number).join('、')}
          </p>
          {auth?.actor?.localAdministrator &&
            action.rows.map((r: any) => <RecordRelations key={r.id} module={kind} id={r.id} />)}
          {action.type === 'permanent-delete' && (
            <p className="flow-warning">
              永久删除不可恢复。已确认单据将先冲销，原始流水、来源和审计保留。
            </p>
          )}
          {action.type === 'reverse' && (
            <p className="flow-warning">
              此操作会产生反向库存流水，并保留原始单据。若相关库存已被使用，请先更正下方关联记录。
            </p>
          )}
          {['reverse', 'cancel'].includes(action.type) && (
            <Field variant="flow" label="原因（必填）">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </Field>
          )}
          <div className="modal-actions">
            <button className="secondary" onClick={() => setAction(null)} disabled={busy}>
              返回
            </button>
            <button
              className="danger-button"
              onClick={perform}
              disabled={busy || (['reverse', 'cancel'].includes(action.type) && !reason.trim())}
            >
              确认操作
            </button>
          </div>
        </ManagementDialog>
      )}
      {ai && (
        <ReceiptRecognition
          data={data}
          close={() => setAi(false)}
          onDraft={(draft) => {
            setKind('arrival');
            setEditor(draft);
            setAi(false);
          }}
        />
      )}
    </div>
  );
}
