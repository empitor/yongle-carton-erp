import { useEffect, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { pageHref, presetRange, type DatePreset, type RecordSort } from '../../shared/core/index';
import { matchesPurchase, purchaseStatuses, purchaseStatusOptions } from '../../shared/business/index';
import { PageHeading, readOnlyNotice, useResettingPage, notify, DateFilter, hashParams, ListToolbar, FilterRow } from '../ui/index';
import BusinessRecords from './BusinessRecords';
import { idList } from '../recordkit/launch';
import OperationsSummary from './OperationsSummary';
import { AllRecordsCheck } from './page-state';
import { supplierOptionsOf, usePurchaseData, type Dates, type SupplierOption } from './purchase-page-data';
import { cleanDateParams } from './record-filters';
import { useOperationsEditor } from './useOperationsEditor';
import { useRecordPage } from './useRecordPage';
import RecordPageBody from './RecordPageBody';

/** 地址里的采购状态（status 或 businessStatus）：认得的（待订货、待到货……）才用，不认识的当作没筛选。 */
const statusParam = (v: string | null) => purchaseStatuses.find((s) => s === v) ?? '';
const scopes = [
  { value: 'pending', label: '待处理' },
  { value: 'all', label: '全部' },
  { value: 'archived', label: '已归档' },
] as const;
/** 地址带进来认得的日期范围：最近 1、2、3 个月或自定义 */
const routePresets = ['1', '2', '3', 'custom'] as const satisfies readonly DatePreset[];

/** 地址里的采购状态；采购单默认看待处理，带着条件过来的（今日页“待订货”、供应商“全部采购单”）看全部 */
function routeFilters(params: URLSearchParams) {
  const initialStatus = statusParam(params.get('status') || params.get('businessStatus'));
  return { initialStatus, pendingByDefault: !params.get('scope') && !initialStatus && !params.get('q') };
}
/** 待处理范围里一张都没有、也没搜没筛：说一句“都到齐了” */
const nothingPending = (scope: string, search: string, filterCount: number) =>
  scope === 'pending' && !search && !filterCount
    ? { title: '没有待处理的采购单', description: '都到齐了。切到“全部”看以前的，缺纸板时点右上角“新建采购单”。' }
    : undefined;

/** 地址带进来的日期筛选：认得的预设或合法的自定义日期才用（record-filters.ts 的 cleanDateParams），否则不限日期 */
function initialDates(params: URLSearchParams): Dates {
  const preset: DatePreset = routePresets.find((r) => r === params.get('range')) ?? 'all';
  const range = presetRange(preset);
  return preset === 'custom'
    ? { preset, start: params.get('start') || '', end: params.get('end') || '' }
    : { preset, start: range.start, end: range.end };
}

type SetEditor = ReturnType<typeof useOperationsEditor>['setEditor'];

/** 采购单页的编辑窗：#purchases?create=1 新建（从供应商、原材料过来的预先填好），带 order= 的按订单“安排订料” */
function useCreateFromRoute(p: ReturnType<typeof useRecordPage>, setEditor: SetEditor) {
  const signedIn = !!p.auth?.actor,
    canEdit = p.canEdit,
    // 地址变了（点了“新建采购单”“安排订料”的链接）才看要不要打开
    hash = location.hash;
  useEffect(() => {
    const params = new URLSearchParams(hash.split('?')[1] || '');
    if (params.get('create') !== '1' || !signedIn) return;
    // 只读账号点了“新建采购单”“安排订料”的链接：不打开编辑窗，说一句为什么
    if (!canEdit) {
      notify(readOnlyNotice, 'error');
      return;
    }
    const order = Number(params.get('order'));
    if (order > 0) setEditor({ type: 'purchase-launch', value: { orderId: order, productIds: idList(params.get('products')) } });
    else
      setEditor({
        type: 'purchase',
        seed: { supplierId: Number(params.get('supplier')) || undefined, stockIds: idList(params.get('stocks')) },
      });
  }, [signedIn, canEdit, hash, setEditor]);
}

/** 采购单“筛选”弹层：供应商、采购状态、采购日期，超级管理员多一个“全部记录” */
function PurchaseFilters(o: {
  suppliers: SupplierOption[];
  supplier: string;
  setSupplier: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  dates: Dates;
  setDates: (d: Dates) => void;
  allCheck: ReactNode;
}) {
  return (
    <>
      <FilterRow label="供应商">
        <select aria-label="筛选供应商" value={o.supplier} onChange={(e) => o.setSupplier(e.target.value)}>
          <option value="">全部供应商</option>
          {o.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </FilterRow>
      <FilterRow label="采购状态">
        <select aria-label="筛选采购状态" value={o.status} onChange={(e) => o.setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {purchaseStatusOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </FilterRow>
      <DateFilter
        label="采购日期"
        preset={o.dates.preset}
        start={o.dates.start}
        end={o.dates.end}
        change={(preset, start, end) => o.setDates({ preset, start, end })}
      />
      {o.allCheck}
    </>
  );
}

/**
 * 采购单页：默认看待处理的（待订货、待到货、部分到货），服务端分页和排序；新建、编辑采购单，按订单安排订料。
 * recycle 是归档页里的已归档采购单。
 */
export default function PurchasesPage({ recycle = false }: { recycle?: boolean }) {
  const params = cleanDateParams(hashParams());
  const { initialStatus, pendingByDefault } = routeFilters(params);
  const p = useRecordPage({ recycle, pendingByDefault });
  const [dates, setDates] = useState(() => initialDates(params)),
    [supplierFilter, setSupplierFilter] = useState(''),
    [status, setStatus] = useState<string>(initialStatus),
    [purchaseSort, setPurchaseSort] = useState<RecordSort>('recent');
  const pendingOnly = p.scope === 'pending';
  const signature = [supplierFilter, status, p.search, dates.start, dates.end, pendingOnly, p.archived, p.all].join('|');
  const [purchasePage, setPurchasePage] = useResettingPage(signature + '|' + purchaseSort);
  const { data, error, busy } = usePurchaseData({ p, dates, supplierFilter, status, page: purchasePage, sort: purchaseSort, signature });
  // 翻页不改变筛选范围，统计数字不用闪成占位符。
  const metricsPending = busy && data.signature !== signature;
  const ops = useOperationsEditor({ superMode: p.superMode, suppliers: data.suppliers, items: data.items, setNotice: p.setNotice });
  useCreateFromRoute(p, ops.setEditor);
  const rows = data.purchases.filter((r) =>
    matchesPurchase(r, {
      q: p.search,
      supplierId: supplierFilter ? Number(supplierFilter) : undefined,
      status: purchaseStatuses.find((s) => s === status),
      start: dates.start || undefined,
      end: dates.end || undefined,
      pending: pendingOnly ? '1' : undefined,
    }),
  );
  const changeScope = (next: string) => {
    const scope = scopes.find((s) => s.value === next);
    if (scope) p.setScope(scope.value);
    p.setAll(false);
    if (!recycle)
      history.replaceState(
        null,
        '',
        pageHref('purchases', { scope: scope && scope.value !== 'pending' ? scope.value : undefined }),
      );
  };
  const clearFilters = () => {
    setStatus('');
    setSupplierFilter('');
    p.setAll(false);
    setDates({ preset: 'all', start: '', end: '' });
  };
  const filterCount = [supplierFilter, status, dates.preset !== 'all', p.all].filter(Boolean).length;
  const shownError = error || ops.error;
  return (
    <div className="operations-workspace unified-business-page">
      {!recycle && (
        <PageHeading
          title="采购单"
          primary={
            p.canEdit && {
              label: '新建采购单',
              icon: <Plus size={17} />,
              disabled: busy,
              onClick: () => ops.setEditor({ type: 'purchase' }),
            }
          }
          meta={
            <OperationsSummary
              mode="purchases"
              kind="raw"
              flowTab={false}
              error={shownError}
              busy={busy}
              metricsPending={metricsPending}
              data={data}
            />
          }
        />
      )}
      <div>
        <ListToolbar
          search={p.search}
          onSearch={p.setSearch}
          searchLabel="搜索采购单"
          placeholder="搜索单号、供应商、纸板"
          scopes={recycle ? undefined : scopes}
          scope={p.scope}
          onScope={changeScope}
          filterCount={filterCount}
          onClearFilters={clearFilters}
          busy={busy}
          filters={
            <PurchaseFilters
              suppliers={supplierOptionsOf(data)}
              supplier={supplierFilter}
              setSupplier={setSupplierFilter}
              status={status}
              setStatus={setStatus}
              dates={dates}
              setDates={setDates}
              allCheck={p.superMode && !recycle && <AllRecordsCheck all={p.all} setAll={p.setAll} />}
            />
          }
        />
        <RecordPageBody error={shownError} notice={p.notice} loading={busy && !rows.length}>
          <BusinessRecords
            filterKey={[supplierFilter, status, dates.start, dates.end, p.scope, p.all].join('|')}
            entity="purchases"
            rows={rows}
            paging={{
              page: data.purchasePage,
              total: data.purchaseFiltered,
              onPage: setPurchasePage,
              sort: purchaseSort,
              onSort: setPurchaseSort,
            }}
            archived={p.archived || recycle}
            allRecords={p.all}
            recycle={recycle}
            empty={nothingPending(p.scope, p.search, filterCount)}
            changed={p.changed}
            edit={(v) => ops.setEditor({ type: 'purchase', value: v })}
          />
        </RecordPageBody>
      </div>
      {ops.editors}
    </div>
  );
}
