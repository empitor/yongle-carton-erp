import { movementTypes, purchaseStatuses, type OperationsApi, type RecordsApi, type StockFlowApi, type WorkbenchApi } from '../../shared/business/index';
import { statuses, type RecordSort, stockKinds } from '../../shared/core/index';
import { call } from '../ui/index';

/**
 * 业务页面（今日、订单、客户、产品、供应商、采购单、库存、流水）的读取：每页只读自己要显示的，查询参数和服务端约定一致。
 * 按一条记录读的在 recordkit/record-api.ts，档案清单在 recordkit/catalog-api.ts。
 */

const records = call<RecordsApi>();
const workbench = call<WorkbenchApi>();
const operations = call<OperationsApi>();
const stock = call<StockFlowApi>();

/** 订单状态词表的第一项：新订单的“待确认” */
const [PENDING_CONFIRM] = statuses;

/** 列表的查询参数（照服务端的 zod 规则，shared/business/orders/record-queries.ts） */
export type CustomerListQuery = NonNullable<RecordsApi['GET /customers?withMetrics=1']['query']>;
export type ProductListQuery = NonNullable<RecordsApi['GET /products?withMetrics=1']['query']>;
export type OrderListQuery = NonNullable<RecordsApi['GET /orders?withMetrics=1']['query']>;
/** 经营概况的查询参数 */
export type DashboardQuery = NonNullable<WorkbenchApi['GET /dashboard']['query']>;
/** 客户、产品详情里的相关订单：按客户或按产品 */
export type OrdersWhere = { customerId: number } | { productId: number };

/** 今日待办 */
export const loadToday = () => workbench('GET /business/today');

/** 今日页“待确认订单”：按交期排的前 size 张 */
export const loadPendingConfirm = (size: number) =>
  records('GET /orders?withMetrics=1', { query: { status: PENDING_CONFIRM, page: 1, pageSize: size, sort: 'due' } });

/** 客户、产品详情里的相关订单（不分页，按条件筛） */
export const loadOrdersWhere = (query: OrdersWhere) => records('GET /orders', { query });
/** 客户详情里属于这个客户的产品（不分页） */
export const loadCustomerProducts = (customerId: number) => records('GET /products', { query: { customerId } });

/** 经营概况：按客户、统计日期 */
export const loadDashboard = (query: DashboardQuery) => workbench('GET /dashboard', { query });

/** 订单、客户、产品、归档页的列表（查询参数由 record-filters.ts 的 recordListQueries 拼好） */
export const loadCustomers = (query: CustomerListQuery) => records('GET /customers?withMetrics=1', { query });
export const loadProducts = (query: ProductListQuery) => records('GET /products?withMetrics=1', { query });
export const loadOrders = (query: OrderListQuery) => records('GET /orders?withMetrics=1', { query });

/** 地址里拼好的范围（page-state.tsx 的 recordRange：'?archived=all'、'?archived=1' 或空）里带不带已归档的 */
function archivedOf(range: string) {
  const archived = new URLSearchParams(range.slice(1)).get('archived');
  return archived === '1' || archived === 'all' ? archived : undefined;
}
/** 页面给的文字收窄成词表里的取值；空的、不认识的不带去请求 */
const oneOf = <T extends string>(values: readonly T[], value: string | undefined) => values.find((v) => v === value);
const supplierHistory = ['with', 'without'] as const;

/** 供应商页：按关键词、有没有采购往来 */
export function loadSuppliers(o: { range: string; search: string; history: string }) {
  return operations('GET /suppliers?withMetrics=1', {
    query: { archived: archivedOf(o.range), q: o.search || undefined, history: oneOf(supplierHistory, o.history) },
  });
}

/** 采购页要用的供应商（筛选下拉、编辑窗）和库存品（编辑窗选纸板）：超级管理员连同已归档的一起 */
export function loadPurchaseLookups(superMode: boolean) {
  const query = { archived: superMode ? ('all' as const) : undefined };
  return Promise.all([
    operations('GET /suppliers?withMetrics=1', { query }),
    stock('GET /warehouse/items?withMetrics=1', { query }),
  ]);
}

/** 采购单页：服务端分页和排序 */
export function loadPurchases(o: {
  range: string;
  search: string;
  start: string;
  end: string;
  supplierFilter: string;
  /** 采购状态（存的值）：待订货、已订货、部分到货、全部到货、已取消 */
  status: string;
  pendingOnly: boolean;
  page: number;
  pageSize: number;
  sort: RecordSort;
}) {
  return stock('GET /purchases?withMetrics=1', {
    query: {
      archived: archivedOf(o.range),
      supplierId: o.supplierFilter || undefined,
      status: oneOf(purchaseStatuses, o.status),
      q: o.search || undefined,
      start: o.start || undefined,
      end: o.end || undefined,
      pending: o.pendingOnly ? '1' : undefined,
      page: o.page,
      pageSize: o.pageSize,
      sort: o.sort,
    },
  });
}

/** 库存页：原材料或成品；只看零库存时两种一起；按往来单位筛（原材料是供应商，成品是客户） */
export function loadStockItems(o: { range: string; kind: string; zeroOnly: boolean; party?: string; search?: string }) {
  const party = !o.zeroOnly && o.party ? o.party : undefined;
  return stock('GET /warehouse/items?withMetrics=1', {
    query: {
      archived: archivedOf(o.range),
      kind: o.zeroOnly ? undefined : oneOf(stockKinds, o.kind),
      zero: o.zeroOnly ? '1' : undefined,
      supplierId: o.kind === 'raw' ? party : undefined,
      customerId: o.kind === 'raw' ? undefined : party,
      q: o.search || undefined,
    },
  });
}

/** 流水页：按仓库、变动类型、日期、关键词、某个库存品，服务端分页 */
export function loadMovements(o: {
  kind: string;
  action: string;
  start: string;
  end: string;
  search: string;
  itemId?: number;
  page: number;
  pageSize: number;
}) {
  return stock('GET /warehouse/movements?withMetrics=1', {
    query: {
      kind: oneOf(stockKinds, o.kind),
      action: oneOf(movementTypes, o.action),
      start: o.start || undefined,
      end: o.end || undefined,
      q: o.search || undefined,
      itemId: o.itemId || undefined,
      page: o.page,
      pageSize: o.pageSize,
    },
  });
}
