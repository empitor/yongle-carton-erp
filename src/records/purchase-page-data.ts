import type { DatePreset, RecordSort } from '../../shared/core/index';
import { purchaseMetrics, type PurchaseView, type StockItemView, type SupplierView } from '../../shared/business/index';
import { LIST_PAGE_SIZE } from '../ui/index';
import { loadPurchaseLookups, loadPurchases } from './list-api';
import { useRecordData, type useRecordPage } from './useRecordPage';

/** 采购单页（PurchasesPage.tsx）读的数据：编辑窗要的供应商、库存品，这一页采购单和分页、统计 */

export type Dates = { preset: DatePreset; start: string; end: string };
/** 供应商筛选下拉的一项 */
export type SupplierOption = { id: number; name: string };
/** 这一页读到的；signature 记着读的是哪一组筛选 */
type PurchaseData = {
  suppliers: SupplierView[];
  items: StockItemView[];
  purchases: PurchaseView[];
  purchaseFiltered: number;
  purchasePage: number;
  /** 筛选范围里的全部供应商（当前页不一定都有） */
  purchaseSuppliers: SupplierOption[];
  purchaseMetrics: ReturnType<typeof purchaseMetrics>;
  signature: string;
};
const emptyPurchases: PurchaseData = {
  suppliers: [],
  items: [],
  purchases: [],
  purchaseFiltered: 0,
  purchasePage: 1,
  purchaseSuppliers: [],
  purchaseMetrics: purchaseMetrics([]),
  signature: '',
};

/** 读这一页：编辑窗要的供应商和库存品、这一页采购单（服务端分页和排序）；业务变了、换了范围或筛选就重读 */
export function usePurchaseData(o: {
  p: ReturnType<typeof useRecordPage>;
  dates: Dates;
  supplierFilter: string;
  status: string;
  page: number;
  sort: RecordSort;
  signature: string;
}) {
  const { p, dates, supplierFilter, status, page, sort, signature } = o;
  return useRecordData(
    [p.revision, p.range, signature, page, sort].join('|'),
    () =>
      Promise.all([
        loadPurchaseLookups(p.superMode),
        loadPurchases({
          range: p.range,
          search: p.search,
          start: dates.start,
          end: dates.end,
          supplierFilter,
          status,
          pendingOnly: p.scope === 'pending',
          page,
          pageSize: LIST_PAGE_SIZE,
          sort,
        }),
      ]).then(
        ([[suppliers, items], purchases]): PurchaseData => ({
          suppliers: suppliers.rows,
          items: items.rows,
          purchases: purchases.rows,
          purchaseFiltered: purchases.filteredRecords,
          purchasePage: purchases.page ?? 1,
          purchaseSuppliers: purchases.suppliers,
          purchaseMetrics: purchases.metrics,
          signature,
        }),
      ),
    emptyPurchases,
  );
}

/** 筛选下拉的供应商：编辑窗读到的加上采购单筛选范围里的（同一家只列一次，后读到的为准） */
export const supplierOptionsOf = (data: PurchaseData) => [
  ...new Map<number, SupplierOption>([...data.suppliers, ...data.purchaseSuppliers].map((s) => [s.id, s])).values(),
];
