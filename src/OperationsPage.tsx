import { useEffect, useState } from 'react';
import { Plus, PackagePlus, RefreshCw } from 'lucide-react';
import BusinessRecords from './BusinessRecords';
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
import { PageHeading, ListFilters, FilterField, ListSummary } from './ui/ListLayout';
import WarehouseNavigation, { type WarehouseView } from './WarehouseNavigation';
import MovementRecords from './MovementRecords';
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
  onGuide?: () => void;
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
    [flowPage, setFlowPage] = useState(1),
    [movementView, setMovementView] = useState<'details' | 'summary'>('details'),
    [flowItem, setFlowItem] = useState<any>(null);
  const [data, setData] = useState<any>({
      suppliers: [],
      purchases: [],
      items: [],
      orders: [],
      products: [],
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
  useEffect(() => {
    if (mode === 'purchases' && params.get('create') === '1' && canEdit)
      setEditor({ type: 'purchase' });
  }, [mode, canEdit]);
  useEffect(() => {
    const listener = () => setRevision((v) => v + 1);
    window.addEventListener('erp-business-changed', listener);
    return () => window.removeEventListener('erp-business-changed', listener);
  }, []);
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
    Promise.all([
      managementRequest<any>('/suppliers?' + supplierQuery),
      managementRequest<any>('/purchases?' + purchaseQuery),
      managementRequest<any>('/warehouse/items?' + itemQuery),
      managementRequest<any[]>('/orders' + (superMode ? '?archived=all' : '')),
      managementRequest<any[]>('/products' + (superMode ? '?archived=all' : '')),
      managementRequest<any>('/warehouse/movements?' + flowQuery),
    ])
      .then(([suppliers, purchases, items, orders, products, movements]) => {
        if (![suppliers, purchases, items, movements].every((v) => Array.isArray(v?.rows)))
          throw new Error('后端仍为旧版本，请重启系统后刷新。');
        if (active)
          setData({
            suppliers: suppliers.rows,
            purchases: purchases.rows,
            items: items.rows,
            orders,
            products,
            movements: movements.rows,
            supplierTotal: suppliers.totalRecords,
            purchaseTotal: purchases.totalRecords,
            itemTotal: items.totalRecords,
            movementTotal: movements.totalRecords,
            movementGroups: movements.metrics,
            purchaseMetrics: purchases.metrics,
            inventoryMetrics: items.metrics,
          });
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
  ]);
  useEffect(() => {
    if (!superMode) setAll(false);
  }, [superMode]);
  useEffect(() => {
    setFlowPage(1);
  }, [search, kind, start, end, flowItem, flowKind, flowAction, flowTab]);
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
  useEffect(
    () =>
      setFlowPage((p) =>
        Math.min(
          p,
          Math.max(
            1,
            Math.ceil(
              (movementView === 'summary' ? data.movementGroups.length : movements.length) / 25,
            ),
          ),
        ),
      ),
    [movements.length, data.movementGroups.length, movementView],
  );
  const supplierOptions = [
    ...new Map<number, any>(
      [
        ...data.suppliers,
        ...data.purchases.map((p: any) => ({ id: p.supplierId, name: p.supplierName })),
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
      {!recycle && (
        <>
          <PageHeading title={titles[mode]} description={descriptions[mode]} actions={actions} />
        </>
      )}
      {recycle && <div className="page-actions recycle-actions">{actions}</div>}
      {mode === 'warehouse' && (
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
                    value: busy ? '—' : data.purchaseMetrics.total,
                    hint: '当前筛选范围',
                  },
                  {
                    label: '待到货采购单',
                    value: busy ? '—' : data.purchaseMetrics.pending,
                    hint: '未收齐，含部分到货；不含取消',
                  },
                  {
                    label: '逾期未到货采购单',
                    value: busy ? '—' : data.purchaseMetrics.overdue,
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
                  setFlowPage(1);
                }}
                summary={data.movementGroups}
                totalRecords={data.movementTotal}
                page={flowPage}
                onPage={setFlowPage}
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
      {editor?.type === 'purchase' && (
        <PurchaseEditor
          value={editor.value}
          suppliers={data.suppliers}
          orders={data.orders}
          items={data.items}
          close={() => setEditor(null)}
          saved={done}
        />
      )}{' '}
      {editor?.type === 'stock' && (
        <StockEditor
          value={editor.value}
          kind={kind}
          products={data.products}
          close={() => setEditor(null)}
          saved={done}
        />
      )}{' '}
      {editor?.type === 'move' && (
        <MovementDialog
          item={editor.value}
          orders={data.orders}
          close={() => setEditor(null)}
          saved={done}
        />
      )}{' '}
    </div>
  );
}
