import { z } from 'zod';
import { pageRows, InputError, type Store } from '../core/index.js';
import { productIdsOfCustomer } from '../operations/index.js';
import { dateSchema, orderDisplayStatus, orderInView, type Order } from '../../shared/core/index.js';
import {
  customerQuerySchema,
  matchesOperationalRecord,
  matchesProduct,
  orderMetrics,
  orderQuerySchema,
  productIncomplete,
  productMetrics,
  productQuerySchema,
} from '../../shared/business/index.js';
import { buildDashboard } from './dashboard.js';

/*
 * 客户、产品、订单列表和经营概况的读取：按请求参数筛选、分页、算统计（原来写在 server/app.ts 里）。
 * 只读，参数是请求的 query，按 shared/business/record-queries.ts 的规则校验；带不带已归档的由调用方按权限判断好传进来。
 */

/** 请求的查询参数（express 给的总是对象）：各字段再按列表的规则校验 */
export const listFields = (query: unknown) => z.record(z.string(), z.unknown()).parse(query);

/** 订单的筛选：客户、产品、下单日期、显示状态、关键字、待处理/全部/历史 */
function filterOrders<T extends Order>(f: z.output<typeof orderQuerySchema>, rows: T[]) {
  if (f.start && f.end && f.start > f.end) throw new InputError('开始日期不能晚于结束日期');
  return rows.filter(
    (o) =>
      (!f.customerId || o.customerId === f.customerId) &&
      (!f.productId || o.lines.some((l) => l.productId === f.productId)) &&
      orderInView(o, {
        view: f.view,
        start: f.start,
        end: f.end,
        retainPending: f.retainPending === '1',
      }) &&
      (!f.status || orderDisplayStatus(o) === f.status) &&
      (!f.q ||
        [o.number, o.customerName, ...o.lines.map((l) => l.productName)]
          .join(' ')
          .toLowerCase()
          .includes(f.q.toLowerCase())),
  );
}

/** 带上归档标记（一次批量取，不逐行查）；archived=1 只留已归档的 */
function listed<T extends { id: number }>(rows: T[], archivedIds: Set<number>, archived: '1' | 'all' | undefined) {
  return rows
    .filter((x) => archived !== '1' || archivedIds.has(x.id))
    .map((row) => ({ ...row, archived: archivedIds.has(row.id) }));
}
/** 不带 withMetrics 时按关键字在全部字段里搜（下拉、助手用） */
const searchAll = <T extends { archived: boolean }>(rows: T[], q: string) =>
  rows.filter(({ archived, ...x }) => Object.values(x).join(' ').toLowerCase().includes(q));

/**
 * 客户列表。withMetrics=1 时按关键字筛，返回 { rows, totalRecords, metrics: null }；
 * 不带时按关键字在全部字段里搜，直接返回数组（下拉、助手用）。
 */
export function customerList(store: Store, query: Record<string, unknown>, includeArchived: boolean) {
  const f = customerQuerySchema.parse(query),
    q = (f.q ?? '').toLowerCase();
  const scoped = listed(store.customers(includeArchived), store.archivedIds('customers'), f.archived);
  if (query.withMetrics !== '1') return searchAll(scoped, q);
  return {
    rows: scoped.filter((row) => matchesOperationalRecord(row, q)),
    totalRecords: scoped.length,
    metrics: null,
  };
}

/**
 * 产品列表。withMetrics=1 时按页面的筛选（关键字、只看资料不全、按客户筛）返回 { rows, totalRecords, metrics }；
 * 不带时按关键字在全部字段里搜，直接返回数组（下拉、助手用）。
 */
export function productList(store: Store, query: Record<string, unknown>, includeArchived: boolean) {
  const f = productQuerySchema.parse(query),
    q = (f.q ?? '').toLowerCase();
  const scoped = listed(store.products(includeArchived), store.archivedIds('products'), f.archived);
  if (query.withMetrics !== '1') return searchAll(scoped, q);
  const matched = scoped.filter((row) => matchesProduct(row, q));
  // 按客户筛：这个客户下过单的产品（产品本身不挂客户，靠订单明细关联）
  const ordered = f.customerId ? productIdsOfCustomer(store, f.customerId) : null;
  const byCustomer = ordered ? matched.filter((row) => ordered.has(row.id)) : matched;
  return {
    rows: f.incomplete === '1' ? byCustomer.filter(productIncomplete) : byCustomer,
    totalRecords: scoped.length,
    metrics: productMetrics(byCustomer),
  };
}

/** 订单列表。withMetrics=1 时分页并带统计（{ rows, filteredRecords, page…, totalRecords, metrics }），不带时直接返回数组 */
export function orderList(store: Store, query: Record<string, unknown>, includeArchived: boolean) {
  const f = orderQuerySchema.parse(query);
  const scoped = listed(store.orders(includeArchived), store.archivedIds('orders'), f.archived);
  const rows = filterOrders(f, scoped);
  return query.withMetrics === '1'
    ? { ...pageRows(rows, query), totalRecords: scoped.length, metrics: orderMetrics(rows) }
    : rows;
}

/** 经营概况：按订单的筛选条件和统计日期算 */
export function orderDashboard(store: Store, query: Record<string, unknown>) {
  const range = z.object({ start: dateSchema.optional(), end: dateSchema.optional() }).parse(query);
  // 页面不显示工作台统计，只有助手 overview.get 需要；这里不算，首页少卡几秒。
  const all = store.orders();
  return buildDashboard(store, filterOrders(orderQuerySchema.parse(query), all), range, undefined, {
    allOrders: all,
    workbench: false,
  });
}
