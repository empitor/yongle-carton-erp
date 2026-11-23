import { datePresets, dateSchema, displayOrderStatuses, pageIdOf, presetRange } from '../../shared/core/index';
import type { DatePreset, OrderView, RecordSort } from '../../shared/core/index';
import type { CustomerListQuery, OrderListQuery, ProductListQuery } from './list-api';

/**
 * 订单、客户、产品、归档几页的列表条件：从地址读筛选、拼读列表的查询参数。只算数据，不引 React、不发请求。
 */

/** 产品页“筛选客户”下拉里“没定客户”的取值 */
export const UNASSIGNED_CUSTOMER = 'none';

/** 这几页由 RecordPages 显示，App 不再给它们画页头 */
export const recordPages = ['dashboard', 'orders', 'customers', 'products', 'trash'] as const;
export const isRecordPage = (page: string) => (recordPages as readonly string[]).includes(page);

type DisplayOrderStatus = (typeof displayOrderStatuses)[number];
const isDisplayStatus = (value: string): value is DisplayOrderStatus =>
  (displayOrderStatuses as readonly string[]).includes(value);
const isDatePreset = (value: string): value is DatePreset => (datePresets as readonly string[]).includes(value);

/**
 * 地址里的日期筛选（range、start、end）是人能手改的：写坏的日期当作没写；自定义范围两头都没有合法日期时，
 * 当作没有日期筛选（去掉 range，按各页的默认范围），筛选按钮上的数和实际筛的一致。改的是传进来的 params。
 */
export function cleanDateParams(params: URLSearchParams) {
  for (const key of ['start', 'end'])
    if (params.has(key) && !dateSchema.safeParse(params.get(key)).success) params.delete(key);
  if (params.get('range') === 'custom' && !params.get('start') && !params.get('end')) params.delete('range');
  return params;
}

/** 从地址读列表筛选（订单默认看待处理、不限日期）。地址是人能手改的，不认识的值当作没筛选。 */
export function readListFilters(hash = location.hash) {
  const params = cleanDateParams(new URLSearchParams(hash.split('?')[1] || ''));
  const pageId = pageIdOf(hash),
    ordersPage = pageId === 'orders';
  // 订单默认看待处理、不限日期；“全部”（scope=all）不分状态。
  const view: OrderView = ordersPage ? (params.get('scope') === 'all' ? 'current' : 'pending') : 'current';
  // 地址是人能手改的：不认识的状态、客户编号、日期一律当作没筛选，不带去请求，免得服务端的校验原文冒到页面上
  const rawStatus = params.get('status') || '',
    status = isDisplayStatus(rawStatus) ? rawStatus : '',
    rawCustomer = params.get('customerId') || '',
    customerId =
      pageId === 'products' && params.get('unassigned') === '1'
        ? UNASSIGNED_CUSTOMER
        : /^[1-9]\d{0,9}$/.test(rawCustomer)
          ? rawCustomer
          : '';
  const raw = params.get('range') || (!ordersPage && view === 'current' ? '2' : 'all');
  const preset: DatePreset = isDatePreset(raw) ? raw : ordersPage ? 'all' : '2';
  const range = presetRange(preset);
  return {
    view,
    preset,
    start: preset === 'custom' ? params.get('start') || '' : range.start,
    end: preset === 'custom' ? params.get('end') || '' : range.end,
    status,
    customerId,
  };
}

/** 地址里要看已归档的（archived=1 或 scope=archived） */
export const archivedRoute = (hash = location.hash) => {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  return params.get('archived') === '1' || params.get('scope') === 'archived';
};

type RecordListState = {
  page: string;
  search: string;
  customerId: string;
  status: string;
  start: string;
  end: string;
  orderView: OrderView;
  archivedView: boolean;
  allRecordsView: boolean;
  productAttention: boolean;
  superMode: boolean;
  orderPage: number;
  orderSort: RecordSort;
  pageSize: number;
};

/** 空文字当没给（不带进查询参数） */
const given = (value: string) => value || undefined;

/** 订单列表带不带已归档的：归档页只读已归档的；订单页看归档的读已归档的，超级管理员勾了“全部记录”连同已归档的一起 */
function orderArchived(o: RecordListState): OrderListQuery['archived'] {
  if (o.page === 'trash') return '1';
  if (o.page !== 'orders') return undefined;
  if (o.superMode && o.allRecordsView) return 'all';
  return o.archivedView ? '1' : undefined;
}

/**
 * 订单：“待处理”只看还没发完、没取消的；“全部”不分状态，按日期筛选时严格按下单日期；
 * 归档页只读已归档的、不带筛选；订单由服务端分页排序。键的先后就是查询参数的先后。
 */
function orderListQuery(o: RecordListState): OrderListQuery {
  const orders = o.page === 'orders',
    trash = o.page === 'trash';
  const pending = orders && !o.archivedView && !(o.superMode && o.allRecordsView) && o.orderView === 'pending';
  return {
    customerId: trash || o.customerId === UNASSIGNED_CUSTOMER ? undefined : given(o.customerId),
    archived: orderArchived(o),
    status: orders && isDisplayStatus(o.status) ? o.status : undefined,
    start: trash ? undefined : given(o.start),
    end: trash ? undefined : given(o.end),
    q: orders ? given(o.search) : undefined,
    view: pending ? 'pending' : undefined,
    page: orders ? o.orderPage : undefined,
    pageSize: orders ? o.pageSize : undefined,
    sort: orders ? o.orderSort : undefined,
  };
}

/** 客户、产品带不带已归档的：超级管理员在别的页（或本页勾了“全部记录”）连同已归档的一起；归档页、本页看归档的只读已归档的 */
function partyArchived(o: RecordListState, entity: 'customers' | 'products'): CustomerListQuery['archived'] {
  if (o.superMode && (o.page !== entity || o.allRecordsView)) return 'all';
  if (o.page === 'trash' || (o.page === entity && o.archivedView)) return '1';
  return undefined;
}

/** 产品：本页才带关键词、只看资料不全的、按客户或“没定客户”筛 */
function productListQuery(o: RecordListState): ProductListQuery {
  const products = o.page === 'products',
    unassigned = products && o.customerId === UNASSIGNED_CUSTOMER;
  return {
    archived: partyArchived(o, 'products'),
    q: products ? given(o.search) : undefined,
    incomplete: products && o.productAttention ? '1' : undefined,
    customerId: products && !unassigned ? given(o.customerId) : undefined,
    unassigned: unassigned ? '1' : undefined,
  };
}

/** 读订单、客户、产品列表的查询参数（withMetrics 写在接口表的键里） */
export function recordListQueries(o: RecordListState) {
  const customers: CustomerListQuery = {
    archived: partyArchived(o, 'customers'),
    q: o.page === 'customers' ? given(o.search) : undefined,
  };
  return { orders: orderListQuery(o), customers, products: productListQuery(o) };
}
