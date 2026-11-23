import { orderedCustomersByProduct, sales } from '../sales/index.js';
import { trackOrders } from './tracked-orders.js';
import { z } from 'zod';
import { pageRows, InputError, type Store } from '../core/index.js';
import type { TrackedOrder } from '../../shared/core/index.js';
import {
  customerQuerySchema,
  matchesOperationalRecord,
  matchesProduct,
  orderMatches,
  orderMetrics,
  orderQuerySchema,
  productIncomplete,
  productMetrics,
  productQuerySchema,
} from '../../shared/business/index.js';

/*
 * 客户、产品、订单列表的读取：按请求参数筛选、分页、算统计。
 * 只读，参数是请求的 query，按 shared/business/orders/record-queries.ts 的规则校验；带不带已归档的由调用方按权限判断好传进来。
 */

/** 请求的查询参数（express 给的总是对象）：各字段再按列表的规则校验 */
export const listFields = (query: unknown) => z.record(z.string(), z.unknown()).parse(query);

/** 订单的筛选：客户、产品、下单日期、显示状态、关键字、待处理/全部/历史（判断和助手同一份 orderMatches） */
export function filterOrders<T extends TrackedOrder>(f: z.output<typeof orderQuerySchema>, rows: T[]) {
  if (f.start && f.end && f.start > f.end) throw new InputError('开始日期不能晚于结束日期');
  const filter = { ...f, retainPending: f.retainPending === '1' };
  return rows.filter((o) => orderMatches(o, filter));
}

/** 带上归档标记（一次批量取，不逐行查）；archived=1 只留已归档的 */
function listed<T extends { id: number }>(rows: T[], archivedIds: Set<number>, archived: '1' | 'all' | undefined) {
  return rows
    .filter((x) => archived !== '1' || archivedIds.has(x.id))
    .map((row) => ({ ...row, archived: archivedIds.has(row.id) }));
}
/**
 * 客户列表。关键字和客户页同一套（matchesOperationalRecord）；withMetrics=1 时返回 { rows, totalRecords, metrics: null }，
 * 不带时直接返回数组（下拉用）。
 */
export function customerList(store: Store, query: Record<string, unknown>, includeArchived: boolean) {
  const f = customerQuerySchema.parse(query);
  const scoped = listed(sales(store).customers(includeArchived), store.archivedIds('customers'), f.archived);
  const rows = scoped.filter((row) => matchesOperationalRecord(row, f.q));
  return query.withMetrics === '1' ? { rows, totalRecords: scoped.length, metrics: null } : rows;
}

/**
 * 产品列表。关键字和产品页同一套（matchesProduct）；支持按所属客户或“没定客户”筛；
 * withMetrics=1 时再按“只看资料不全”筛、为没定客户的产品补上历史下单客户，返回 { rows, totalRecords, metrics }，
 * 不带时直接返回数组（下拉和客户详情用）。
 */
export function productList(store: Store, query: Record<string, unknown>, includeArchived: boolean) {
  const f = productQuerySchema.parse(query);
  const scoped = listed(sales(store).products(includeArchived), store.archivedIds('products'), f.archived);
  const matched = scoped.filter((row) => matchesProduct(row, f.q ?? ''));
  const byCustomer =
    f.unassigned === '1'
      ? matched.filter((row) => row.customerId == null)
      : f.customerId
        ? matched.filter((row) => row.customerId === f.customerId)
        : matched;
  if (query.withMetrics !== '1') return byCustomer;
  const rows = f.incomplete === '1' ? byCustomer.filter(productIncomplete) : byCustomer;
  const unassignedIds = rows.filter((r) => r.customerId == null).map((r) => r.id);
  const history = orderedCustomersByProduct(store, unassignedIds);
  return {
    rows: rows.map((row) => {
      const orderedCustomers = row.customerId == null ? history.get(row.id) : undefined;
      return orderedCustomers?.length ? { ...row, orderedCustomers } : row;
    }),
    totalRecords: scoped.length,
    metrics: productMetrics(byCustomer),
  };
}

/** 订单列表。withMetrics=1 时分页并带统计（{ rows, filteredRecords, page…, totalRecords, metrics }），不带时直接返回数组 */
export function orderList(store: Store, query: Record<string, unknown>, includeArchived: boolean) {
  const f = orderQuerySchema.parse(query);
  const scoped = listed(trackOrders(store, sales(store).orders(includeArchived)), store.archivedIds('orders'), f.archived);
  const rows = filterOrders(f, scoped);
  return query.withMetrics === '1'
    ? { ...pageRows(rows, query), totalRecords: scoped.length, metrics: orderMetrics(rows) }
    : rows;
}
