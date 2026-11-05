import { useEffect, useRef, useState } from 'react';
import type { RecordSort } from '../shared/record-sort';
import { Plus, PackagePlus, RefreshCw } from 'lucide-react';
import BusinessRecords, { PAGE_SIZE } from './BusinessRecords';
import { managementRequest, useAuthState } from './session';
import { PurchaseEditor, StockEditor, MovementDialog } from './operations/Editors';
import { purchaseBusinessStatuses, arrivalProgresses } from '../shared/operations';
import './operations.css';
import DateRangeFilter from './DateRangeFilter';
import { presetRange, type DatePreset } from '../shared/date-ranges';
import { matchesPurchase } from '../shared/purchase-filters';
import {
  initialMovementRange,
  matchesMovement,
  movementActions,
  movementLabels,
} from '../shared/movement-filters';
import { PageHeading, ListFilters, FilterField, ListSummary, useResettingPage } from './ui/ListLayout';
import WarehouseNavigation, { type WarehouseView } from './WarehouseNavigation';
import MovementRecords, { MOVEMENT_PAGE_SIZE } from './MovementRecords';
import FlowPage from './FlowPage';
import WarehouseRecords from './WarehouseRecords';
import {
  purchaseMetrics,
  inventoryMetrics,
  matchesOperationalRecord,
} from '../shared/business-metrics';
export default function OperationsPage({
  mode,
  recycle = false,
  openSupplier,
}: {
  mode: 'suppliers' | 'purchases' | 'warehouse';
  recycle?: boolean;
  openSupplier: (v?: any) => void;
}) {
  const auth = useAuthState(),
    superMode = !!auth?.actor?.superAdminMode,
    canEdit = !!auth?.actor && (superMode || auth.actor.permissions.includes('business:edit'));
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const initialPreset: DatePreset = ['1', '2', '3', 'custom'].includes(params.get('range') || '')
    ? (params.get('range') as DatePreset)
    : mode === 'warehouse'
      ? initialMovementRange(params).preset
      : 'all';
  const initialRange =
    mode === 'warehouse' ? initialMovementRange(params) : presetRange(initialPreset);
  const [revision, setRevision] = useState(0),
    [search, setSearch] = useState(params.get('q') || ''),
    [archived, setArchived] = useState(recycle || params.get('archived') === '1'),
    [all, setAll] = useState(false),
    [kind, setKind] = useState(params.get('kind') === 'finished' ? 'finished' : 'raw'),
    [supplierFilter, setSupplierFilter] = useState(''),
    [supplierSearch, setSupplierSearch] = useState(''),
    [pendingOnly, setPendingOnly] = useState(params.get('pending') === '1'),
    [zeroOnly, setZeroOnly] = useState(params.get('zero') === '1'),
    [datePreset, setDatePreset] = useState<DatePreset>(initialPreset),
    [status, setStatus] = useState(params.get('businessStatus') || ''),
    [arrivalProgress, setArrivalProgress] = useState(''),
    [historyFilter, setHistoryFilter] = useState(''),
    [start, setStart] = useState(
      initialPreset === 'custom' ? params.get('start') || '' : initialRange.start,
    ),
    [end, setEnd] = useState(
      initialPreset === 'custom' ? params.get('end') || '' : initialRange.end,
    ),
    [flowKind, setFlowKind] = useState(
      params.get('kind') === 'raw' ? 'raw' : params.get('kind') === 'finished' ? 'finished' : '',
    ),
    [flowAction, setFlowAction] = useState(''),
    [flowTab, setFlowTab] = useState(params.get('flow') === '1'),
    [deliveryTab, setDeliveryTab] = useState(
      params.get('deliveries') === '1' || params.get('deliveryPlans') === '1',
    ),
    [arrivalView, setArrivalView] = useState<'arrivals' | null>(
      params.get('arrivalPlans') === '1' || params.get('arrivals') === '1' ? 'arrivals' : null,
    ),
    [deliveryLaunch, setDeliveryLaunch] = useState<{ order?: string; stock?: string } | null>(
      params.get('createDelivery') === '1'
        ? {
            ...(params.get('order') ? { order: params.get('order')! } : {}),
            ...(params.get('stock') ? { stock: params.get('stock')! } : {}),
          }
        : null,
    ),
    [summaryPage, setSummaryPage] = useState(1),
    [movementView, setMovementView] = useState<'details' | 'summary'>('details'),
    [flowItem, setFlowItem] = useState<any>(null);
  const [data, setData] = useState<any>({
      suppliers: [],
      purchases: [],
      items: [],
      movements: [],
      supplierTotal: 0,
      purchaseTotal: 0,
      itemTotal: 0,
      movementTotal: 0,
      movementGroups: [],
      purchaseMetrics: purchaseMetrics([]),
      inventoryMetrics: {
        raw: inventoryMetrics([], 'raw'),
        finished: inventoryMetrics([], 'finished'),
      },
    }),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [editor, setEditor] = useState<{
      type: 'purchase' | 'stock' | 'move';
      value?: any;
    } | null>(null);
  const [purchaseSort, setPurchaseSort] = useState<RecordSort>('recent'),
    [lookups, setLookups] = useState<{ orders: any[]; products: any[] } | null>(null);
  const purchaseSignature = [
    supplierFilter,
    supplierSearch,
    status,
    arrivalProgress,
    search,
    start,
    end,
    pendingOnly,
    archived,
    all,
  ].join('|');
  const [purchasePage, setPurchasePage] = useResettingPage(purchaseSignature + '|' + purchaseSort);
  const [movementPage, setMovementPage] = useResettingPage(
    [search, start, end, flowKind, flowAction, flowItem?.id, flowTab].join('|'),
  );
  // 翻页不改变筛选范围，统计数字不用闪成占位符。
  const loadedPurchaseSignature = useRef('');
  const purchaseMetricsPending = busy && loadedPurchaseSignature.current !== purchaseSignature;
  useEffect(() => {
    if (mode === 'purchases' && params.get('create') === '1' && canEdit)
      setEditor({ type: 'purchase' });
  }, [mode, canEdit]);
  useEffect(() => {
    const listener = () => setRevision((v) => v + 1);
    window.addEventListener('erp-business-changed', listener);
    return () => window.removeEventListener('erp-business-changed', listener);
  }, []);
  // 编辑窗才用得上全部订单和产品，打开时再读。
  const lookupScope = superMode ? '?archived=all' : '';
  useEffect(() => {
    if (!editor) {
      setLookups(null);
      return;
    }
    let active = true;
    Promise.all([
      managementRequest<any[]>('/orders' + lookupScope),
      managementRequest<any[]>('/products' + lookupScope),
    ])
      .then(([orders, products]) => {
        if (active) setLookups({ orders, products });
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setEditor(null);
        }
      });
    return () => {
      active = false;
    };
  }, [!!editor, lookupScope]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    const range = superMode && all ? '?archived=all' : archived || recycle ? '?archived=1' : '';
    const purchaseQuery = new URLSearchParams(mode === 'purchases' ? range.slice(1) : '');
    purchaseQuery.set('withMetrics', '1');
    if (mode === 'purchases') {
      if (supplierFilter) purchaseQuery.set('supplierId', supplierFilter);
      if (supplierSearch) purchaseQuery.set('supplierName', supplierSearch);
      if (status) purchaseQuery.set('businessStatus', status);
      if (arrivalProgress) purchaseQuery.set('arrivalProgress', arrivalProgress);
      if (search) purchaseQuery.set('q', search);
      if (start) purchaseQuery.set('start', start);
      if (end) purchaseQuery.set('end', end);
      if (pendingOnly) purchaseQuery.set('pending', '1');
      purchaseQuery.set('page', String(purchasePage));
      purchaseQuery.set('pageSize', String(PAGE_SIZE));
      purchaseQuery.set('sort', purchaseSort);
    }
    const flowQuery = new URLSearchParams();
    if (mode === 'warehouse' && flowTab) {
      if (flowKind) flowQuery.set('kind', flowKind);
      if (flowAction) flowQuery.set('action', flowAction);
      if (start) flowQuery.set('start', start);
      if (end) flowQuery.set('end', end);
      if (search) flowQuery.set('q', search);
      if (flowItem) flowQuery.set('itemId', String(flowItem.id));
    }
    flowQuery.set('withMetrics', '1');
    flowQuery.set('page', String(movementPage));
    flowQuery.set('pageSize', String(MOVEMENT_PAGE_SIZE));
    const supplierQuery = new URLSearchParams(
      mode === 'suppliers' ? range.slice(1) : superMode ? 'archived=all' : '',
    );
    supplierQuery.set('withMetrics', '1');
    if (mode === 'suppliers') {
      if (search) supplierQuery.set('q', search);
      if (historyFilter) supplierQuery.set('history', historyFilter);
    }
    const itemQuery = new URLSearchParams(
      mode === 'warehouse' ? range.slice(1) : superMode ? 'archived=all' : '',
    );
    itemQuery.set('withMetrics', '1');
    if (mode === 'warehouse') {
      if (!zeroOnly) itemQuery.set('kind', kind);
      if (zeroOnly) itemQuery.set('zero', '1');
      if (!flowTab && search) itemQuery.set('q', search);
    }
    // 每页只读自己显示的列表；没读的保留上一次的值，切回时再刷新。
    const wantSuppliers = mode !== 'warehouse',
      wantPurchases = mode === 'purchases',
      wantMovements = mode === 'warehouse' && flowTab,
      wantItems = mode !== 'suppliers';
    Promise.all([
      wantSuppliers ? managementRequest<any>('/suppliers?' + supplierQuery) : null,
      wantPurchases ? managementRequest<any>('/purchases?' + purchaseQuery) : null,
      wantItems ? managementRequest<any>('/warehouse/items?' + itemQuery) : null,
      wantMovements ? managementRequest<any>('/warehouse/movements?' + flowQuery) : null,
    ])
      .then(([suppliers, purchases, items, movements]) => {
        if (
          ![suppliers, purchases, items, movements].every((v) => !v || Array.isArray(v.rows))
        )
          throw new Error('后端仍为旧版本，请重启系统后刷新。');
        if (purchases) loadedPurchaseSignature.current = purchaseSignature;
        if (active)
          setData((d: any) => ({
            ...d,
            ...(suppliers && { suppliers: suppliers.rows, supplierTotal: suppliers.totalRecords }),
            ...(purchases && {
              purchases: purchases.rows,
              purchaseTotal: purchases.totalRecords,
              purchaseFiltered: purchases.filteredRecords,
              purchasePage: purchases.page ?? 1,
              purchaseSuppliers: purchases.suppliers,
              purchaseMetrics: purchases.metrics,
            }),
            ...(items && {
              items: items.rows,
              itemTotal: items.totalRecords,
              inventoryMetrics: items.metrics,
            }),
            ...(movements && {
              movements: movements.rows,
              movementTotal: movements.totalRecords,
              movementFiltered: movements.filteredRecords,
              movementPage: movements.page ?? 1,
              movementGroups: movements.metrics,
            }),
          }));
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    mode,
    revision,
    archived,
    all,
    superMode,
    recycle,
    supplierFilter,
    supplierSearch,
    status,
    arrivalProgress,
    start,
    end,
    search,
    pendingOnly,
    flowTab,
    flowKind,
    flowAction,
    flowItem?.id,
    historyFilter,
    kind,
    zeroOnly,
    purchasePage,
    purchaseSort,
    movementPage,
  ]);
  useEffect(() => {
    if (!superMode) setAll(false);
  }, [superMode]);
  const done = () => {
    if (editor?.type === 'stock') setFlowTab(false);
    setEditor(null);
    setRevision((v) => v + 1);
    window.dispatchEvent(new Event('erp-business-changed'));
    setNotice('已保存，列表和库存已更新。');
  };
  const rows = (
    mode === 'suppliers' ? data.suppliers : mode === 'purchases' ? data.purchases : data.items
  ).filter((r: any) =>
    mode === 'purchases'
      ? matchesPurchase(r, {
          q: search,
          supplierName: supplierSearch,
          supplierId: supplierFilter ? Number(supplierFilter) : undefined,
          businessStatus: status
            ? (status as (typeof purchaseBusinessStatuses)[number])
            : undefined,
          arrivalProgress: arrivalProgress
            ? (arrivalProgress as (typeof arrivalProgresses)[number])
            : undefined,
          start: start || undefined,
          end: end || undefined,
          pending: pendingOnly ? '1' : undefined,
        })
      : matchesOperationalRecord(r, search) &&
        (mode !== 'warehouse' ||
          ((zeroOnly || r.kind === kind) && (!zeroOnly || r.balanceUnits === 0))) &&
        (mode !== 'suppliers' ||
          !historyFilter ||
          (historyFilter === 'with') === r.purchaseHistory.length > 0),
  );
  const movements = data.movements.filter((m: any) =>
    matchesMovement(m, {
      kind: flowKind ? (flowKind as 'raw' | 'finished') : undefined,
      action: flowAction ? (flowAction as (typeof movementActions)[number]) : undefined,
      itemId: flowItem?.id,
      start: start || undefined,
      end: end || undefined,
      q: search,
    }),
  );
  const supplierOptions = [
    ...new Map<number, any>(
      [
        ...data.suppliers,
        ...(data.purchaseSuppliers || []),
      ].map((s: any) => [s.id, s]),
    ).values(),
  ].filter(
    (s: any) => !supplierSearch || s.name.toLowerCase().includes(supplierSearch.toLowerCase()),
  );
  const selectWarehouseView = (view: WarehouseView) => {
    setDeliveryTab(view === 'deliveries');
    setArrivalView(view === 'arrivals' ? view : null);
    setFlowTab(view === 'flows');
    if (view === 'raw' || view === 'finished') setKind(view);
    if (view === 'deliveries') setKind('finished');
    setZeroOnly(false);
    setFlowItem(null);
    setSearch('');
    if (!recycle)
      history.replaceState(
        null,
        '',
        view === 'flows'
          ? '#warehouse?flow=1'
          : view === 'arrivals'
            ? '#warehouse?arrivals=1'
            : view === 'deliveries'
              ? '#warehouse?kind=finished&deliveries=1'
              : '#warehouse?kind=' + view,
      );
  };
  const resetFilters = () => {
    setSearch('');
    setSupplierFilter('');
    setSupplierSearch('');
    setStatus('');
    setArrivalProgress('');
    setHistoryFilter('');
    setPendingOnly(false);
    setZeroOnly(false);
    setFlowItem(null);
    setFlowAction('');
    setFlowKind('');
    const preset = mode === 'warehouse' ? '2' : 'all',
      range = presetRange(preset);
    setDatePreset(preset);
    setStart(range.start);
    setEnd(range.end);
  };
  const actions = (
    <>
      {!recycle && mode === 'warehouse' && (
        <button onClick={() => (location.hash = 'production')}>生产领料与完工</button>
      )}
      <button
        disabled={busy}
        onClick={() =>
          arrivalView || deliveryTab
            ? window.dispatchEvent(new Event('erp-business-changed'))
            : setRevision((v) => v + 1)
        }
      >
        <RefreshCw size={15} />
        刷新
      </button>
      {!recycle &&
        mode === 'warehouse' &&
        !arrivalView &&
        !deliveryTab &&
        kind === 'finished' &&
        !flowTab && (
          <button
            className="primary"
            disabled={!canEdit || busy}
            onClick={() => setDeliveryLaunch({})}
          >
            <Plus size={18} />
            新建送货单
          </button>
        )}
      {!recycle &&
        !deliveryTab &&
        !arrivalView &&
        (mode === 'warehouse' && flowTab ? (
          <button className="primary" onClick={() => selectWarehouseView(kind as WarehouseView)}>
            返回库存管理
          </button>
        ) : (
          <button
            className={mode === 'warehouse' && kind === 'finished' ? 'secondary' : 'primary'}
            disabled={!canEdit || busy}
            onClick={() =>
              mode === 'suppliers'
                ? openSupplier()
                : setEditor({ type: mode === 'purchases' ? 'purchase' : 'stock' })
            }
          >
            <Plus size={17} />
            {mode === 'suppliers'
              ? '新增供应商'
              : mode === 'purchases'
                ? '新建采购单'
                : '新建库存品'}
          </button>
        ))}
    </>
  );
  const titles = { suppliers: '供应商管理', purchases: '采购订货', warehouse: '仓库管理' };
  const descriptions = {
    suppliers: '集中维护供应商资料，查看每次采购往来。',
    purchases: '外购纸板订货、分批到货与原材料入库。',
    warehouse: '库存查看当前余额，流水追溯每一笔变动。',
  };
  return (
    <div className="operations-workspace unified-business-page">
      {!recycle && !arrivalView && !deliveryTab && (
        <PageHeading
          title={flowTab ? '流水' : titles[mode]}
          description={descriptions[mode]}
          actions={flowTab ? undefined : actions}
        />
      )}
      {recycle && <div className="page-actions recycle-actions">{actions}</div>}
      {mode === 'warehouse' && !arrivalView && !deliveryTab && !flowTab && (
        <WarehouseNavigation
          view={
            arrivalView ||
            (deliveryTab ? 'deliveries' : flowTab ? 'flows' : (kind as WarehouseView))
          }
          onChange={selectWarehouseView}
        />
      )}
      <div
        id={mode === 'warehouse' ? 'warehouse-content' : undefined}
        role={mode === 'warehouse' ? 'tabpanel' : undefined}
        aria-labelledby={
          mode === 'warehouse'
            ? 'warehouse-tab-' +
              (arrivalView || (deliveryTab ? 'deliveries' : flowTab ? 'flows' : kind))
            : undefined
        }
      >
        {arrivalView && mode === 'warehouse' ? (
          <WarehouseRecords key="arrival" kind="arrival" />
        ) : deliveryTab && mode === 'warehouse' ? (
          <WarehouseRecords key="delivery" kind="delivery" />
        ) : (
          <>
            {mode === 'purchases' && !error && (
              <ListSummary
                items={[
                  {
                    label: '采购订单总数',
                    value: purchaseMetricsPending ? '—' : data.purchaseMetrics.total,
                    hint: '当前筛选范围',
                  },
                  {
                    label: '待到货采购单',
                    value: purchaseMetricsPending ? '—' : data.purchaseMetrics.pending,
                    hint: '未收齐，含部分到货；不含取消',
                  },
                  {
                    label: '逾期未到货采购单',
                    value: purchaseMetricsPending ? '—' : data.purchaseMetrics.overdue,
                    hint: '预计到货日期已过且未收齐',
                  },
                ]}
              />
            )}
            {mode === 'warehouse' && !flowTab && !error && (
              <ListSummary
                items={
                  kind === 'raw'
                    ? [
                        {
                          label: '库存纸板种类',
                          value: busy ? '—' : data.inventoryMetrics.raw.varieties,
                          hint: '按实际规格分组，仅计有库存品种',
                        },
                        {
                          label: '库存总面积',
                          value: busy
                            ? '—'
                            : data.inventoryMetrics.raw.areaExcluded &&
                                !data.inventoryMetrics.raw.areaConverted
                              ? '无法可靠汇总'
                              : data.inventoryMetrics.raw.areaSquareMetres + ' ㎡',
                          hint: data.inventoryMetrics.raw.areaExcluded
                            ? `可确认部分；另有 ${data.inventoryMetrics.raw.areaExcluded} 项无法换算未计入`
                            : '按已确认长宽、尺寸单位和数量换算',
                        },
                        {
                          label: '低库存品种',
                          value: '未设置',
                          hint: '当前没有警戒值字段，暂不判断',
                        },
                      ]
                    : [
                        {
                          label: '成品种类',
                          value: busy ? '—' : data.inventoryMetrics.finished.varieties,
                          hint: '有库存的成品型号/档案',
                        },
                        {
                          label: '成品总数量',
                          value: busy ? (
                            '—'
                          ) : data.inventoryMetrics.finished.quantities.length ? (
                            <span className="quantity-groups">
                              {data.inventoryMetrics.finished.quantities.map((g: any) => (
                                <span key={g.unit}>
                                  {g.quantity} <small>{g.unit}</small>
                                </span>
                              ))}
                            </span>
                          ) : (
                            0
                          ),
                          hint: '不同数量单位分别列示',
                        },
                      ]
                }
              />
            )}
            <ListFilters
              search={search}
              onSearch={setSearch}
              placeholder={
                mode === 'purchases'
                  ? '搜索采购单号、供应商、纸板'
                  : mode === 'warehouse' && flowTab
                    ? '搜索库存品、采购单号、用途、操作人'
                    : '搜索名称、规格、联系信息'
              }
              dates={
                mode === 'purchases' || (mode === 'warehouse' && flowTab) ? (
                  <DateRangeFilter
                    label={mode === 'purchases' ? '采购日期' : '业务日期'}
                    preset={datePreset}
                    start={start}
                    end={end}
                    change={(p, s, e) => {
                      setDatePreset(p);
                      setStart(s);
                      setEnd(e);
                    }}
                  />
                ) : undefined
              }
              extras={
                mode === 'purchases' ? (
                  <label className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={pendingOnly}
                      onChange={(e) => setPendingOnly(e.target.checked)}
                    />
                    仅待到货
                  </label>
                ) : undefined
              }
              onReset={resetFilters}
              busy={busy}
              note={
                mode === 'warehouse' && flowTab
                  ? '累计出入库按筛选范围统计，当前库存不受日期限制。'
                  : undefined
              }
            >
              {mode === 'purchases' && (
                <>
                  <FilterField label="供应商">
                    <div className="party-select">
                      <input
                        aria-label="搜索供应商名称"
                        placeholder="搜索供应商名称"
                        value={supplierSearch}
                        onChange={(e) => {
                          setSupplierSearch(e.target.value);
                          setSupplierFilter('');
                        }}
                      />
                      <select
                        aria-label="筛选供应商"
                        value={supplierFilter}
                        onChange={(e) => setSupplierFilter(e.target.value)}
                      >
                        <option value="">全部供应商</option>
                        {supplierOptions.map((s: any) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </FilterField>
                  <FilterField label="采购业务状态">
                    <select
                      aria-label="筛选采购状态"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">全部状态</option>
                      {purchaseBusinessStatuses.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </FilterField>
                  <FilterField label="到货进度">
                    <select
                      aria-label="筛选到货进度"
                      value={arrivalProgress}
                      onChange={(e) => setArrivalProgress(e.target.value)}
                    >
                      <option value="">全部进度</option>
                      {arrivalProgresses.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </FilterField>
                </>
              )}
              {mode === 'suppliers' && (
                <FilterField label="采购往来">
                  <select
                    aria-label="筛选采购关联"
                    value={historyFilter}
                    onChange={(e) => setHistoryFilter(e.target.value)}
                  >
                    <option value="">全部供应商</option>
                    <option value="with">有历史采购</option>
                    <option value="without">无历史采购</option>
                  </select>
                </FilterField>
              )}
              {mode === 'warehouse' && flowTab && (
                <>
                  <FilterField label="仓库类型">
                    <select
                      aria-label="筛选流水仓库"
                      value={flowKind}
                      onChange={(e) => {
                        setFlowKind(e.target.value);
                        setFlowItem(null);
                      }}
                    >
                      <option value="">全部仓库</option>
                      <option value="raw">原材料仓库</option>
                      <option value="finished">成品仓库</option>
                    </select>
                  </FilterField>
                  <FilterField label="变动类型">
                    <select
                      aria-label="筛选流水类型"
                      value={flowAction}
                      onChange={(e) => setFlowAction(e.target.value)}
                    >
                      <option value="">全部类型</option>
                      {movementActions.map((a) => (
                        <option value={a} key={a}>
                          {movementLabels[a]}
                        </option>
                      ))}
                    </select>
                  </FilterField>
                </>
              )}
              {mode === 'warehouse' && !flowTab && (
                <label className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={zeroOnly}
                    onChange={(e) => setZeroOnly(e.target.checked)}
                  />
                  全部分类零库存
                </label>
              )}
            </ListFilters>
            {error && (
              <p role="alert" className="operation-error">
                {error}
              </p>
            )}
            {notice && (
              <p className="business-result" role="status">
                {notice}
              </p>
            )}
            {error ? null : busy &&
              !(mode === 'warehouse' && flowTab ? movements.length : rows.length) ? (
              <p className="empty">正在读取业务数据…</p>
            ) : mode === 'warehouse' && flowTab ? (
              <MovementRecords
                rows={movements}
                view={movementView}
                onView={(v) => {
                  setMovementView(v);
                  setSummaryPage(1);
                }}
                summary={data.movementGroups}
                totalRecords={data.movementTotal}
                filteredRecords={data.movementFiltered ?? 0}
                pageSize={MOVEMENT_PAGE_SIZE}
                page={movementView === 'summary' ? summaryPage : (data.movementPage ?? 1)}
                onPage={movementView === 'summary' ? setSummaryPage : setMovementPage}
                item={flowItem}
                onClearItem={() => setFlowItem(null)}
              />
            ) : (
              <BusinessRecords
                filterKey={[
                  supplierFilter,
                  supplierSearch,
                  status,
                  arrivalProgress,
                  start,
                  end,
                  pendingOnly,
                  kind,
                  zeroOnly,
                ].join('|')}
                hideSearch
                entity={mode === 'warehouse' ? 'stock_items' : mode}
                rows={rows}
                paging={
                  mode === 'purchases'
                    ? {
                        page: data.purchasePage ?? 1,
                        total: data.purchaseFiltered ?? 0,
                        onPage: setPurchasePage,
                        sort: purchaseSort,
                        onSort: setPurchaseSort,
                      }
                    : undefined
                }
                totalRecords={
                  mode === 'suppliers'
                    ? data.supplierTotal
                    : mode === 'purchases'
                      ? data.purchaseTotal
                      : data.itemTotal
                }
                archived={archived || recycle}
                setArchived={setArchived}
                allRecords={all}
                setAllRecords={setAll}
                recycle={recycle}
                search={search}
                setSearch={setSearch}
                changed={(message) => {
                  if (message) setNotice(message);
                  setRevision((v) => v + 1);
                }}
                edit={(v) =>
                  mode === 'suppliers'
                    ? openSupplier(v)
                    : setEditor({ type: mode === 'purchases' ? 'purchase' : 'stock', value: v })
                }
                extraActions={(r) =>
                  mode === 'purchases' ? (
                    <button
                      onClick={() => (location.hash = 'warehouse?arrivals=1&purchase=' + r.id)}
                    >
                      <PackagePlus size={14} />
                      到货记录
                    </button>
                  ) : mode === 'warehouse' ? (
                    <>
                      <button
                        disabled={!canEdit || r.archived}
                        onClick={() => setEditor({ type: 'move', value: r })}
                      >
                        出入库 / 盘点
                      </button>
                      <button
                        onClick={() => {
                          setMovementView('details');
                          setFlowItem(r);
                          setFlowKind(r.kind);
                          setFlowTab(true);
                        }}
                      >
                        流水
                      </button>
                      {r.kind === 'finished' && (
                        <button
                          disabled={!canEdit || r.archived}
                          onClick={() => setDeliveryLaunch({ stock: String(r.id) })}
                        >
                          安排送货
                        </button>
                      )}
                    </>
                  ) : null
                }
              />
            )}
          </>
        )}
      </div>
      {deliveryLaunch && mode === 'warehouse' && (
        <FlowPage
          mode="delivery"
          dialogOnly
          launch={deliveryLaunch}
          onClose={() => setDeliveryLaunch(null)}
        />
      )}
      {editor?.type === 'purchase' && lookups && (
        <PurchaseEditor
          value={editor.value}
          suppliers={data.suppliers}
          orders={lookups.orders}
          items={data.items}
          close={() => setEditor(null)}
          saved={done}
        />
      )}{' '}
      {editor?.type === 'stock' && lookups && (
        <StockEditor
          value={editor.value}
          kind={kind}
          products={lookups.products}
          close={() => setEditor(null)}
          saved={done}
        />
      )}{' '}
      {editor?.type === 'move' && lookups && (
        <MovementDialog
          item={editor.value}
          orders={lookups.orders}
          close={() => setEditor(null)}
          saved={done}
        />
      )}{' '}
    </div>
  );
}
