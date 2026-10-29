import { useEffect, useState, useRef, type ReactNode } from 'react';
import { Plus, FileUp, Printer, RefreshCw } from 'lucide-react';
import {
  flowNames,
  flowStates,
  flowStatusLabel,
  matchesFlowStatus,
  flowInput,
  sheetArea,
  purchaseLineAmount,
  type FlowKind,
} from '../shared/physical-flow';
import { quantityString, formatStockSize } from '../shared/operations';
import { today, dateSchema } from '../shared/domain';
import { convertDimension, normalizedDimensions } from '../shared/product-details';
import { managementRequest, useAuthState } from './session';
import ManagementDialog from './ManagementDialog';
import { PageHeading, ListFilters, FilterField, ListSummary } from './ui/ListLayout';
import DateRangeFilter from './DateRangeFilter';
import { presetRange, type DatePreset } from '../shared/date-ranges';
import ReceiptRecognition from './ReceiptRecognition';
import { ZodError } from 'zod';
import './physical-flow.css';
import { StockEditor } from './operations/Editors';
import DeliveryStockPicker from './operations/DeliveryStockPicker';
import { deliveryCandidates } from '../shared/warehouse-delivery';
import { blankArrivalLine } from '../shared/arrival-draft';
import RecordContextDialog, { RecordRelations } from './RecordContext';
import DatabaseDeleteDialog from './DatabaseDeleteDialog';
import ReceiptCorrectionDialog from './ReceiptCorrectionDialog';
import DateSchedule from './DateSchedule';
import './date-schedule.css';
import BusinessExport from './BusinessExport';
import ProductionBatchDialog from './ProductionBatchDialog';
import { planDate, scheduleSummary } from '../shared/schedule';
export { blankArrivalLine } from '../shared/arrival-draft';
const title = (kind: FlowKind) =>
  kind === 'arrival'
    ? '采购到货管理'
    : kind === 'task'
      ? '生产管理'
      : kind === 'production'
        ? '每日生产登记'
        : '客户送货管理';
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={'op-field' + (wide ? ' op-wide' : '')}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
  empty = '请选择',
}: {
  label: string;
  value: any;
  onChange: (v: number | null) => void;
  options: any[];
  empty?: string;
}) {
  return (
    <Field label={label}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">{empty}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label || o.name || o.number}
          </option>
        ))}
      </select>
    </Field>
  );
}
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
    sliced = filtered.slice((page - 1) * 12, page * 12);
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(filtered.length / 12))));
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
      // 用户核对待生产数量；不能把订单数量误当作已扣除其他任务的余量。
      v.quantity = '';
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
    } else if (launch || params.get('purchase') || params.get('order') || params.get('stock')) {
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
  return (
    <div className="flow-page">
      {!dialogOnly && (
        <>
          {!embedded && (
            <PageHeading
              title={title(kind)}
              description={
                kind === 'arrival'
                  ? '核对供应商送货单，确认实收后入原材料库存。'
                  : kind === 'delivery'
                    ? '草稿不扣库存，正式确认发货后更新交付进度。'
                    : '按实际领用、退料和合格数量登记，不预设纸板与纸箱的产量比例。'
              }
              actions={
                <>
                  <button
                    className="secondary"
                    onClick={() => (location.hash = kind === 'arrival' ? 'purchases' : 'warehouse')}
                  >
                    查看{kind === 'arrival' ? '采购订货' : '库存'}
                  </button>
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
                    新建{flowNames[kind]}
                  </button>
                </>
              }
            />
          )}
          {mode === 'task' && (
            <div className="record-view-tabs" aria-label="生产管理分类" role="tablist">
              {(['task', 'production'] as const).map((k) => (
                <button
                  key={k}
                  className={kind === k ? 'selected' : ''}
                  onClick={() => {
                    setKind(k);
                    setStatus('');
                  }}
                >
                  {flowNames[k]}
                </button>
              ))}
            </div>
          )}
          {(kind === 'task' || (kind === 'delivery' && scheduleView)) && (
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
          {!auth?.actor && <p className="form-error">请先在右上角登录管理账号。</p>}
          <ListFilters
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
          </ListFilters>
          {!archived && !embedded && (
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
                {flowNames[kind]}（筛选 {filtered.length} / 共 {rows.length} 张）
              </h3>
              <button className="secondary" onClick={refresh} disabled={busy}>
                <RefreshCw size={14} />
                刷新
              </button>
            </div>
            <div className="table-wrap">
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
                    <th>单号 / 日期</th>
                    <th>{kind === 'arrival' ? '供应商' : kind === 'delivery' ? '客户' : '产品'}</th>
                    <th>{kind === 'task' ? '计划 / 完工进度' : '业务内容'}</th>
                    <th>状态</th>
                    <th>登记人</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sliced.map((r) => (
                    <tr key={r.id}>
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
                      <td>
                        <strong>{r.number}</strong>
                        <span className="sub">
                          {kind === 'task' || kind === 'delivery' ? '计划 ' + planDate(r) : r.date}
                        </span>
                        {kind === 'delivery' && (
                          <span className="sub">实际发货：{r.actualDate || '尚未发货'}</span>
                        )}
                        {kind === 'task' && (
                          <span className="sub">
                            实际完工：{r.actualCompletionDate || '尚未完工'}
                          </span>
                        )}
                        {r.plannedDateSource === 'legacy-date' && (
                          <span className="sub">沿用历史业务日期</span>
                        )}
                      </td>
                      <td>{labelRow(r) || '历史档案'}</td>
                      <td>
                        {kind === 'task' ? (
                          <>
                            {r.completed} / {r.quantity} {r.unit}
                            <progress value={r.progress} max="100" />
                          </>
                        ) : kind === 'production' ? (
                          <>
                            合格 {r.goodQuantity} · 报废 {r.scrapQuantity}
                            <span className="sub">
                              {r.materials.length} 种领用材料 · {r.operator}
                            </span>
                          </>
                        ) : (
                          <>
                            {r.lines.length} 条明细
                            <span className="sub">{r.reference || r.notes || '—'}</span>
                          </>
                        )}
                      </td>
                      <td>
                        <span className={'badge flow-state-' + r.status}>
                          {r.archived ? '归档 · ' : ''}
                          {flowStatusLabel(r)}
                        </span>
                      </td>
                      <td>{r.actorName}</td>
                      <td>
                        <div className="flow-actions">
                          {canEdit &&
                            !r.archived &&
                            ((r.kind === 'task' &&
                              ['draft', 'confirmed'].includes(r.status) &&
                              r.progress < 100) ||
                              (r.kind === 'delivery' && r.status === 'draft')) && (
                              <button
                                onClick={() => {
                                  setScheduling(r);
                                  setNewPlanDate(planDate(r));
                                  setNewPlanTime(r.plannedTime || '');
                                  scheduleRequest.current = crypto.randomUUID();
                                }}
                              >
                                调整排程
                              </button>
                            )}
                          <button className="secondary" onClick={() => setView(r)}>
                            查看
                          </button>
                          {canEdit &&
                            r.kind === 'arrival' &&
                            r.status === 'confirmed' &&
                            arrivalReceipt(r) && (
                              <button onClick={() => correctArrival(r)}>更正到货单</button>
                            )}
                          {((r.status === 'draft' && !archived) ||
                            auth?.actor?.localAdministrator) && (
                            <button
                              className="secondary"
                              disabled={!canEdit}
                              onClick={() =>
                                r.kind === 'arrival' &&
                                r.status === 'confirmed' &&
                                arrivalReceipt(r)
                                  ? correctArrival(r)
                                  : begin(r)
                              }
                            >
                              编辑
                            </button>
                          )}
                          <button
                            disabled={!canEdit || busy}
                            onClick={() => ask(archived ? 'restore' : 'archive', [r])}
                          >
                            {archived ? '恢复' : '归档'}
                          </button>
                          <button
                            className="danger-text"
                            disabled={!auth?.actor?.localAdministrator || busy}
                            onClick={() => ask('delete', [r])}
                          >
                            删除
                          </button>
                          <details className="record-more">
                            <summary>更多操作</summary>
                            <div className="record-more-content">
                              {auth?.actor?.localAdministrator && (
                                <button onClick={() => setContextId(r.id)}>
                                  关联记录 / 修改历史
                                </button>
                              )}
                              {r.status === 'draft' && !archived && (
                                <>
                                  <button disabled={!canEdit} onClick={() => review(r)}>
                                    核对并确认
                                  </button>
                                  <button disabled={!canEdit} onClick={() => ask('cancel', [r])}>
                                    取消草稿
                                  </button>
                                </>
                              )}
                              {r.status === 'confirmed' && (
                                <button
                                  className="danger-text"
                                  disabled={!auth?.actor?.superAdminMode}
                                  onClick={() => ask('reverse', [r])}
                                >
                                  冲销更正
                                </button>
                              )}
                              {r.kind === 'task' &&
                                r.status === 'confirmed' &&
                                r.progress < 100 && (
                                  <button
                                    className="danger-text"
                                    disabled={!canEdit}
                                    onClick={() => ask('cancel', [r])}
                                  >
                                    取消剩余任务（保留已生产）
                                  </button>
                                )}
                              {r.status === 'reversed' && auth?.actor?.superAdminMode && (
                                <button
                                  onClick={() => {
                                    const copy = structuredClone(r);
                                    delete copy.id;
                                    delete copy.version;
                                    copy.correctionOf = r.id;
                                    setEditor(copy);
                                  }}
                                >
                                  建立更正草稿
                                </button>
                              )}
                            </div>
                          </details>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!sliced.length && (
              <div className="empty-state">{busy ? '正在读取业务数据…' : '当前条件下暂无记录'}</div>
            )}
            <div className="flow-pagination">
              <button
                className="secondary"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil(filtered.length / 12))}
              </span>
              <button
                className="secondary"
                disabled={page * 12 >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
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
      {view && (
        <ManagementDialog
          title={
            (view.kind === 'arrival' && view.isPlan
              ? '到货计划'
              : flowNames[view.kind as FlowKind]) +
            ' · ' +
            view.number
          }
          close={() => setView(null)}
        >
          <FlowDetails doc={view} data={data} />
          <div className="modal-actions">
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
          </div>
        </ManagementDialog>
      )}
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
            <Field label="原因（必填）">
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
export function FlowEditor({
  kind,
  value: v,
  change,
  data,
  createFinished,
}: {
  kind: FlowKind;
  value: any;
  change: (v: any) => void;
  data: any;
  createFinished: () => void;
}) {
  const patchLine = (i: number, patch: any) =>
    change({
      lines: v.lines.map((l: any, index: number) => (index === i ? { ...l, ...patch } : l)),
    });
  const patchMaterial = (i: number, patch: any) =>
    change({
      materials: v.materials.map((l: any, index: number) => (index === i ? { ...l, ...patch } : l)),
    });
  const raw = data.items.filter((s: any) => s.kind === 'raw' && s.unit === '张'),
    finished = data.items.filter((s: any) => s.kind === 'finished');
  return (
    <div className="flow-editor">
      <div className="op-form-grid">
        {(kind === 'task' || kind === 'delivery') && (
          <Field label={kind === 'task' ? '计划生产日期 *' : '计划送货日期 *'}>
            <input
              aria-label="计划日期"
              type="date"
              value={v.plannedDate || v.date}
              onChange={(e) => change({ plannedDate: e.target.value })}
            />
          </Field>
        )}
        {kind === 'task' && (
          <Field label="计划生产时间（选填）">
            <input
              type="time"
              value={v.plannedTime || ''}
              onChange={(e) => change({ plannedTime: e.target.value || null })}
            />
          </Field>
        )}
        {kind === 'arrival' && v.isPlan && (
          <>
            <Field label="预计到货日期 *">
              <input
                type="date"
                value={v.plannedDate || v.date}
                onChange={(e) => change({ plannedDate: e.target.value, date: e.target.value })}
              />
            </Field>
            <Field label="预计到货时间">
              <input
                type="time"
                value={v.plannedTime || ''}
                onChange={(e) => change({ plannedTime: e.target.value || null })}
              />
            </Field>
            <p className="flow-warning">
              到货计划不增加库存。实际收货时另行登记实际日期、数量及验收结果。
            </p>
          </>
        )}
        {!(kind === 'arrival' && v.isPlan) && (
          <Field
            label={
              kind === 'delivery'
                ? '实际送货日期（确认发货时生效） *'
                : kind === 'task'
                  ? '任务登记日期 *'
                  : kind === 'arrival'
                    ? '实际到货日期 *'
                    : '业务日期 *'
            }
          >
            <input type="date" value={v.date} onChange={(e) => change({ date: e.target.value })} />
          </Field>
        )}
        {kind === 'delivery' && (
          <>
            <Field label="预计送货时间">
              <input
                type="time"
                value={v.plannedTime || ''}
                onChange={(e) => change({ plannedTime: e.target.value || null })}
              />
            </Field>
            <Field label="实际送货时间（未知可留空）">
              <input
                type="time"
                value={v.actualTime || ''}
                onChange={(e) => change({ actualTime: e.target.value || null })}
              />
            </Field>
          </>
        )}
        {kind === 'arrival' && !v.isPlan && (
          <Field label="实际到货时间（未知可留空）">
            <input
              type="time"
              value={v.actualTime || ''}
              onChange={(e) => change({ actualTime: e.target.value || null })}
            />
          </Field>
        )}
        {kind === 'arrival' && (
          <>
            <Select
              label="供应商 *"
              value={v.supplierId}
              options={data.suppliers}
              onChange={(supplierId) =>
                change({
                  supplierId,
                  lines: v.lines.map((l: any) => ({ ...l, purchaseLineId: null })),
                })
              }
            />
            {!v.isPlan && (
              <Field label="供应商送货单号 / 到货批次 *">
                <input
                  value={v.reference}
                  onChange={(e) => change({ reference: e.target.value })}
                  maxLength={100}
                />
              </Field>
            )}
            {v.sourceId && (
              <p className="flow-warning">
                本草稿来自AI识别，必须逐项核对数量、单位与采购关联。原件会保留。
              </p>
            )}
          </>
        )}
        {kind === 'task' && (
          <>
            <Select
              label="产品 *"
              value={v.productId}
              options={data.products}
              onChange={(productId) => change({ productId, orderIds: [] })}
            />
            <Field label="计划生产数量 *">
              <input
                inputMode="decimal"
                value={v.quantity}
                onChange={(e) => change({ quantity: e.target.value })}
              />
            </Field>
            <Field label="成品计量单位 *">
              <input
                value={v.unit}
                onChange={(e) => change({ unit: e.target.value })}
                maxLength={20}
              />
            </Field>
            <Field label="关联客户订单（可多选，也可独立生产）" wide>
              <div className="flow-order-options">
                {data.orders
                  .filter(
                    (o: any) =>
                      ['已确认', '生产中', '待发货'].includes(o.status) &&
                      o.lines.some((l: any) => l.productId === v.productId),
                  )
                  .map((o: any) => (
                    <label key={o.id}>
                      <input
                        type="checkbox"
                        checked={v.orderIds.includes(o.id)}
                        onChange={(e) =>
                          change({
                            orderIds: e.target.checked
                              ? [...v.orderIds, o.id]
                              : v.orderIds.filter((id: number) => id !== o.id),
                          })
                        }
                      />
                      {o.number} · {o.customerName}
                    </label>
                  ))}
              </div>
            </Field>
          </>
        )}
        {kind === 'production' && (
          <>
            <Select
              label="关联生产任务（可独立登记）"
              value={v.taskId}
              options={data.tasks
                .filter((t: any) => t.status === 'confirmed')
                .map((t: any) => ({
                  ...t,
                  label:
                    t.number +
                    ' · ' +
                    data.products.find((p: any) => p.id === t.productId)?.name +
                    ' · 完工' +
                    t.completed +
                    '/' +
                    t.quantity +
                    t.unit,
                }))}
              onChange={(taskId) => {
                const t = data.tasks.find((t: any) => t.id === taskId);
                change({
                  taskId,
                  ...(t
                    ? {
                        productId: t.productId,
                        finishedStockId:
                          finished.find(
                            (s: any) => s.productId === t.productId && s.unit === t.unit,
                          )?.id || null,
                      }
                    : {}),
                });
              }}
            />
            <Select
              label="生产产品 *"
              value={v.productId}
              options={data.products}
              onChange={(productId) => change({ productId, taskId: null, finishedStockId: null })}
            />
            <Select
              label="入库成品档案 *"
              value={v.finishedStockId}
              options={finished
                .filter((s: any) => s.productId === v.productId)
                .map((s: any) => ({
                  ...s,
                  label:
                    s.name +
                    ' · ' +
                    (s.specification || formatStockSize(s)) +
                    ' · ' +
                    s.quantity +
                    s.unit,
                }))}
              onChange={(finishedStockId) => change({ finishedStockId })}
            />
            <div className="op-field">
              <span>尚无对应成品档案？</span>
              <button
                type="button"
                className="secondary"
                disabled={!v.productId}
                onClick={createFinished}
              >
                <Plus size={15} />
                新建成品库存档案（保留草稿）
              </button>
            </div>
            <Field
              label={
                '实际合格数量 * / ' +
                (finished.find((s: any) => s.id === v.finishedStockId)?.unit || '成品单位')
              }
            >
              <input
                value={v.goodQuantity}
                inputMode="decimal"
                onChange={(e) => change({ goodQuantity: e.target.value })}
              />
            </Field>
            <Field label="损耗报废数量 / 同成品单位">
              <input
                value={v.scrapQuantity}
                inputMode="decimal"
                onChange={(e) => change({ scrapQuantity: e.target.value })}
              />
            </Field>
            <Field label="实际操作人员 *">
              <input value={v.operator} onChange={(e) => change({ operator: e.target.value })} />
            </Field>
          </>
        )}
        {kind === 'delivery' && (
          <>
            <Select
              label="客户 *"
              value={v.customerId}
              options={data.customers}
              onChange={(customerId) => {
                const c = data.customers.find((c: any) => c.id === customerId);
                change({
                  customerId,
                  address: c?.address || '',
                  contact: c?.contact || '',
                  phone: c?.phone || '',
                  lines: v.lines
                    .filter((l: any) => l.stockId)
                    .map((l: any) => ({ ...l, orderId: null, orderLineId: null, quantity: '' })),
                });
              }}
            />
            <Field label="收货地址">
              <input value={v.address} onChange={(e) => change({ address: e.target.value })} />
            </Field>
            <Field label="收货联系人">
              <input value={v.contact} onChange={(e) => change({ contact: e.target.value })} />
            </Field>
            <Field label="联系电话">
              <input value={v.phone} onChange={(e) => change({ phone: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="整单备注" wide>
          <textarea
            value={v.notes}
            onChange={(e) => change({ notes: e.target.value })}
            maxLength={2000}
          />
        </Field>
      </div>
      {kind === 'arrival' && (
        <>
          <h3>{v.isPlan ? '预计到货明细' : '实际收货明细'} · 纸板按张管理</h3>
          {v.lines.map((l: any, i: number) => (
            <section className="flow-line" key={i}>
              <div className="flow-line-head">
                <strong>纸板 {i + 1}</strong>
                <button
                  className="danger-text"
                  disabled={v.lines.length === 1}
                  onClick={() => change({ lines: v.lines.filter((_: any, j: number) => i !== j) })}
                >
                  移除明细
                </button>
              </div>
              <div className="op-form-grid">
                <Select
                  label="匹配采购明细（可不关联）"
                  value={l.purchaseLineId}
                  options={data.purchases
                    .filter((p: any) => p.supplierId === v.supplierId && p.baseStatus === '已订货')
                    .flatMap((p: any) =>
                      p.lines
                        .filter((x: any) => x.unit === '张' && x.receivedUnits < x.quantityUnits)
                        .map((x: any) => ({
                          ...x,
                          label:
                            (v.notes?.includes(p.number) ||
                            (l.item.dimensionUnit &&
                              x.material === l.item.material &&
                              x.flute === l.item.flute &&
                              JSON.stringify(normalizedDimensions(x)) ===
                                JSON.stringify(normalizedDimensions(l.item)))
                              ? '[建议匹配，请核对] '
                              : '') +
                            p.number +
                            ' · ' +
                            x.name +
                            ' · ' +
                            (x.specification || formatStockSize(x)) +
                            ' · 剩余' +
                            quantityString(x.quantityUnits - x.receivedUnits) +
                            '张',
                        })),
                    )}
                  empty="无采购单收货 / 请人工选择"
                  onChange={(purchaseLineId) => {
                    const p = data.purchases.find((p: any) =>
                        p.lines.some((x: any) => x.id === purchaseLineId),
                      ),
                      pl = p?.lines.find((x: any) => x.id === purchaseLineId);
                    patchLine(i, {
                      purchaseLineId,
                      ...(pl
                        ? {
                            stockId: pl.stockItemId,
                            item: v.sourceId ? l.item : { ...pl, unit: '张' },
                            unitPrice: v.sourceId ? l.unitPrice : pl.unitPrice,
                            priceBasis: v.sourceId ? l.priceBasis : pl.priceBasis || 'quantity',
                          }
                        : {}),
                    });
                  }}
                />
                <Select
                  label="入库档案（全部规格一致才可选已有）"
                  value={l.stockId}
                  options={raw.map((s: any) => ({
                    ...s,
                    label:
                      s.name +
                      ' · ' +
                      s.material +
                      ' ' +
                      s.flute +
                      ' · ' +
                      formatStockSize(s) +
                      ' · ' +
                      s.specification,
                  }))}
                  empty="确认时新建独立原材料档案"
                  onChange={(stockId) => {
                    const s = raw.find((x: any) => x.id === stockId);
                    patchLine(i, { stockId, ...(s ? { item: { ...s, unit: '张' } } : {}) });
                  }}
                />
                <Field label="纸板名称 *">
                  <input
                    value={l.item.name}
                    onChange={(e) => patchLine(i, { item: { ...l.item, name: e.target.value } })}
                  />
                </Field>
                <Field label="规格说明">
                  <textarea
                    value={l.item.specification}
                    onChange={(e) =>
                      patchLine(i, { item: { ...l.item, specification: e.target.value } })
                    }
                  />
                </Field>
                <Field label="材质 / 配纸">
                  <input
                    value={l.item.material}
                    onChange={(e) =>
                      patchLine(i, { item: { ...l.item, material: e.target.value } })
                    }
                  />
                </Field>
                <Field label="楞型">
                  <input
                    value={l.item.flute}
                    onChange={(e) => patchLine(i, { item: { ...l.item, flute: e.target.value } })}
                  />
                </Field>
                <Field label="尺寸单位">
                  <select
                    value={l.item.dimensionUnit || ''}
                    onChange={(e) => {
                      const unit = e.target.value || null,
                        from = l.item.dimensionUnit;
                      patchLine(i, {
                        item: {
                          ...l.item,
                          dimensionUnit: unit,
                          ...(unit && from
                            ? {
                                length: convertDimension(l.item.length, from, unit as any),
                                width: convertDimension(l.item.width, from, unit as any),
                              }
                            : {}),
                        },
                      });
                    }}
                  >
                    <option value="">尚未确认</option>
                    <option value="mm">毫米 mm</option>
                    <option value="cm">厘米 cm</option>
                  </select>
                </Field>
                {(['length', 'width'] as const).map((k, j) => (
                  <Field
                    key={k}
                    label={
                      (j === 0 ? '纸板长' : '纸板宽') + ' / ' + (l.item.dimensionUnit || '未知单位')
                    }
                  >
                    <input
                      type="number"
                      step="any"
                      value={l.item[k] ?? ''}
                      onChange={(e) =>
                        patchLine(i, {
                          item: {
                            ...l.item,
                            [k]: e.target.value === '' ? null : Number(e.target.value),
                          },
                        })
                      }
                    />
                  </Field>
                ))}
                <Field label={v.isPlan ? '预计到货数量 *' : '本批实际到货数量 *'}>
                  <input
                    value={l.quantity}
                    inputMode="numeric"
                    onChange={(e) =>
                      patchLine(i, {
                        quantity: e.target.value,
                        ...(l.acceptedQuantity === l.quantity &&
                        l.rejectedQuantity === '0' &&
                        l.stockedQuantity === l.quantity
                          ? { acceptedQuantity: e.target.value, stockedQuantity: e.target.value }
                          : {}),
                      })
                    }
                  />
                </Field>
                {!v.isPlan && (
                  <>
                    <Field label="验收合格数量（空白为全部合格）">
                      <input
                        inputMode="decimal"
                        value={l.acceptedQuantity ?? ''}
                        onChange={(e) => patchLine(i, { acceptedQuantity: e.target.value || null })}
                      />
                    </Field>
                    <Field label="不合格数量（空白按总数减合格数）">
                      <input
                        inputMode="decimal"
                        value={l.rejectedQuantity ?? ''}
                        onChange={(e) => patchLine(i, { rejectedQuantity: e.target.value || null })}
                      />
                    </Field>
                    <Field label="实际入库数量（空白为合格数量）">
                      <input
                        inputMode="decimal"
                        value={l.stockedQuantity ?? ''}
                        onChange={(e) => patchLine(i, { stockedQuantity: e.target.value || null })}
                      />
                    </Field>
                  </>
                )}
                <Field label="送货单标注张数（可留空）">
                  <input
                    value={l.statedQuantity ?? ''}
                    onChange={(e) => patchLine(i, { statedQuantity: e.target.value || null })}
                  />
                </Field>
                <Field label="送货单标注面积 / m²（可留空）">
                  <input
                    value={l.statedArea ?? ''}
                    onChange={(e) => patchLine(i, { statedArea: e.target.value || null })}
                  />
                </Field>
                <Field label="计价方式">
                  <select
                    value={l.priceBasis || ''}
                    onChange={(e) => patchLine(i, { priceBasis: e.target.value || null })}
                  >
                    <option value="">计价依据待确认</option>
                    <option value="area">平方米</option>
                    <option value="quantity">张数</option>
                  </select>
                </Field>
                <Field
                  label={
                    '单价 / ' +
                    (l.priceBasis
                      ? '元每' + (l.priceBasis === 'area' ? '平方米' : '张')
                      : '计价依据待确认')
                  }
                >
                  <input
                    value={l.unitPrice ?? ''}
                    onChange={(e) => patchLine(i, { unitPrice: e.target.value || null })}
                  />
                </Field>
                <Field label="程序计算面积 / 金额">
                  <output>
                    {safeArea(l)} m² / {safeAmount(l)} 元
                  </output>
                </Field>
                <Field label="到货差异原因 / 无采购单说明" wide>
                  <textarea
                    value={l.differenceReason}
                    onChange={(e) => patchLine(i, { differenceReason: e.target.value })}
                  />
                </Field>
                <Field label="纸板备注" wide>
                  <textarea
                    value={l.item.notes}
                    onChange={(e) => patchLine(i, { item: { ...l.item, notes: e.target.value } })}
                  />
                </Field>
              </div>
            </section>
          ))}
          <button
            className="secondary"
            onClick={() => change({ lines: [...v.lines, blankArrivalLine()] })}
          >
            <Plus size={16} />
            增加纸板
          </button>
        </>
      )}
      {kind === 'production' && (
        <>
          <h3>实际领料与退料 · 以张登记</h3>
          {v.materials.map((m: any, i: number) => (
            <section className="flow-line" key={i}>
              <div className="op-form-grid">
                <Select
                  label="原材料品种 *"
                  value={m.stockId}
                  options={raw.map((s: any) => ({
                    ...s,
                    label:
                      s.name +
                      ' · ' +
                      s.material +
                      ' ' +
                      s.flute +
                      ' ' +
                      formatStockSize(s) +
                      ' · 库存' +
                      s.quantity +
                      '张',
                  }))}
                  onChange={(stockId) => patchMaterial(i, { stockId })}
                />
                <Field label="实际领用张数 *">
                  <input
                    value={m.issued}
                    onChange={(e) => patchMaterial(i, { issued: e.target.value })}
                  />
                </Field>
                <Field label="剩余退料张数">
                  <input
                    value={m.returned}
                    onChange={(e) => patchMaterial(i, { returned: e.target.value })}
                  />
                </Field>
                <button
                  className="danger-text"
                  disabled={v.materials.length === 1}
                  onClick={() =>
                    change({ materials: v.materials.filter((_: any, j: number) => i !== j) })
                  }
                >
                  移除材料
                </button>
              </div>
            </section>
          ))}
          <button
            className="secondary"
            onClick={() =>
              change({ materials: [...v.materials, { stockId: null, issued: '', returned: '0' }] })
            }
          >
            增加领料品种
          </button>
          <p className="sub">
            净耗用 = 实际领用 −
            退料。报废数量仅作为生产质量记录，材料损耗已体现在实际净耗用中，避免二次扣料。
          </p>
        </>
      )}
      {kind === 'delivery' && <DeliveryStockPicker value={v} data={data} change={change} />}
    </div>
  );
}
function safeArea(l: any) {
  try {
    return sheetArea(l.item, l.quantity) || '待确认';
  } catch {
    return '待确认';
  }
}
function safeAmount(l: any) {
  try {
    return (
      purchaseLineAmount({
        ...l.item,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceBasis: l.priceBasis,
      }) || '待确认'
    );
  } catch {
    return '待确认';
  }
}
function FlowDetails({ doc: d, data }: { doc: any; data: any }) {
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('erp-ai-record-context', {
        detail: {
          module: (
            {
              arrival: 'arrivals',
              task: 'production_tasks',
              production: 'production_records',
              delivery: 'deliveries',
            } as any
          )[d.kind],
          id: d.id,
          label: d.number,
        },
      }),
    );
  }, [d.kind, d.id]);
  return (
    <div
      className="flow-details"
      data-agent-module={
        (
          {
            arrival: 'arrivals',
            task: 'production_tasks',
            production: 'production_records',
            delivery: 'deliveries',
          } as any
        )[d.kind]
      }
      data-agent-record={d.id}
      data-agent-label={d.number}
    >
      <dl className="record-detail-grid">
        <div>
          <dt>业务日期 / 状态</dt>
          <dd>
            {d.date} · {flowStatusLabel(d)}
            {(d.kind === 'task' || d.kind === 'delivery') && (
              <span className="sub">
                计划日期：{planDate(d)}；
                {d.kind === 'delivery'
                  ? '实际发货：' + (d.actualDate || '尚未发货')
                  : '实际完工：' + (d.actualCompletionDate || '尚未完工')}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>操作人员</dt>
          <dd>{d.confirmedBy || d.actorName}</dd>
        </div>
        {d.kind === 'arrival' && (
          <div>
            <dt>{d.isPlan ? '预计到货' : '实际到货时间'}</dt>
            <dd>
              {d.isPlan
                ? `${d.plannedDate} ${d.plannedTime || '时间未填写'}`
                : `${d.date} ${d.actualTime || '时间未记录'}`}
            </dd>
          </div>
        )}
        {d.reference && (
          <div>
            <dt>供应商送货单号</dt>
            <dd>{d.reference}</dd>
          </div>
        )}
        {d.kind === 'task' && (
          <>
            <div>
              <dt>计划 / 累计完工</dt>
              <dd>
                {d.quantity} / {d.completed} {d.unit}
              </dd>
            </div>
            <div>
              <dt>关联客户订单</dt>
              <dd>
                {d.orderIds
                  .map((id: number) => data.orders.find((o: any) => o.id === id)?.number || id)
                  .join('、') || '独立生产'}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>备注</dt>
          <dd>{d.notes || '—'}</dd>
        </div>
      </dl>
      {d.sourceId && (
        <a
          className="secondary"
          target="_blank"
          rel="noreferrer"
          href={'/api/flow/sources/' + d.sourceId + '/file'}
        >
          查看供应商送货单原件
        </a>
      )}
      {d.kind === 'arrival' && (
        <div className="table-wrap">
          <table className="flow-table">
            <thead>
              <tr>
                {[
                  '纸板名称 / 规格',
                  '材质 / 楞型',
                  d.isPlan ? '预计到货数量' : '实收到货数量',
                  '合格 / 不合格 / 实际入库',
                  '面积 m²',
                  '计价 / 金额 元',
                  '采购关联 / 差异',
                ].map((n) => (
                  <th key={n}>{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td>
                    {l.item.name}
                    <span className="sub">{l.item.specification || formatStockSize(l.item)}</span>
                  </td>
                  <td>
                    {l.item.material} / {l.item.flute}
                  </td>
                  <td>
                    {l.quantity} {l.item.unit}
                  </td>
                  <td>
                    {d.isPlan ? (
                      '尚未验收 / 尚未入库'
                    ) : (
                      <>
                        {l.acceptedQuantity ?? '未记录'} / {l.rejectedQuantity ?? '未记录'} /{' '}
                        {l.stockedQuantity ?? '确认后核验'}
                      </>
                    )}
                  </td>
                  <td>{safeArea(l)}</td>
                  <td>
                    {l.unitPrice ?? '待定'} /{' '}
                    {l.priceBasis === null
                      ? '依据待确认'
                      : l.priceBasis === 'area'
                        ? 'm²'
                        : l.item.unit}
                    <span className="sub">金额 {safeAmount(l)}</span>
                  </td>
                  <td>
                    {l.purchaseNumber ||
                      data.purchases.find((p: any) =>
                        p.lines.some((x: any) => x.id === l.purchaseLineId),
                      )?.number ||
                      '无采购单'}
                    <span className="sub">{l.differenceReason || '无差异说明'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.kind === 'production' && (
        <>
          <h3>
            合格 {d.goodQuantity} · 报废 {d.scrapQuantity}{' '}
            {data.items.find((s: any) => s.id === d.finishedStockId)?.unit} · 实际操作 {d.operator}
          </h3>
          <div className="table-wrap">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>原材料</th>
                  <th>领用 / 张</th>
                  <th>退料 / 张</th>
                  <th>净耗用 / 张</th>
                </tr>
              </thead>
              <tbody>
                {d.materials.map((m: any) => (
                  <tr key={m.stockId}>
                    <td>{data.items.find((s: any) => s.id === m.stockId)?.name || m.stockId}</td>
                    <td>{m.issued}</td>
                    <td>{m.returned}</td>
                    <td>{Number(m.issued) - Number(m.returned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {d.kind === 'delivery' && (
        <>
          <p>
            {data.customers.find((c: any) => c.id === d.customerId)?.name} · {d.address}
          </p>
          <div className="table-wrap">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>客户订单</th>
                  <th>产品名称</th>
                  <th>规格型号</th>
                  <th>本次发货</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l: any, i: number) => {
                  const o = data.orders.find((o: any) => o.id === l.orderId),
                    ol = o?.lines.find((x: any) => x.id === l.orderLineId);
                  return (
                    <tr key={i}>
                      <td>{l.orderNumber || o?.number}</td>
                      <td>{l.productName || ol?.productName}</td>
                      <td>{l.specification || ol?.specification}</td>
                      <td>
                        {l.quantity} {l.unit || ol?.unit}
                      </td>
                      <td>{l.notes}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {d.reversal && (
        <p className="flow-warning">
          已冲销 · {d.reversal.by} · {d.reversal.at} · 原因：{d.reversal.reason}
        </p>
      )}
      {d.cancellation && (
        <p className="flow-warning">
          取消原因：{d.cancellation.reason} · {d.cancellation.by} · {d.cancellation.at}
          。已确认的生产和库存历史保留。
        </p>
      )}
    </div>
  );
}
