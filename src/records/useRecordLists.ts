import { useEffect, useRef, useState } from 'react';
import { matchesOperationalRecord, matchesProduct, orderMetrics, productIncomplete, productMetrics, type Listed, type ProductListRow, type RecordEntity } from '../../shared/business/index';
import { errorMessage, type Customer, type TrackedOrder, type RecordSort } from '../../shared/core/index';
import { useResettingPage, useBusinessRevision, LIST_PAGE_SIZE } from '../ui/index';
import { isRecordPage, recordListQueries } from './record-filters';
import { loadCustomers, loadOrders, loadProducts } from './list-api';
import { useListFilters, type ListFilters } from './useListFilters';

type Props = {
  page: string;
  signedIn: boolean;
  actorId?: unknown;
  superMode: boolean;
  financeOnly: boolean;
  /** 归档页选的类型：采购库存那几类由它们自己的页面读 */
  trashEntity: RecordEntity;
};

/** 只有这几页读客户、产品、订单；今日页的经营概况自己读；归档页看采购库存的几类时由采购库存的页面自己读 */
const readsLists = ({ page, financeOnly, trashEntity }: Pick<Props, 'page' | 'financeOnly' | 'trashEntity'>) =>
  !financeOnly &&
  isRecordPage(page) &&
  page !== 'dashboard' &&
  !(page === 'trash' && ['suppliers', 'purchases', 'stock_items'].includes(trashEntity));

/** 每页只读自己需要的数据。订单页和归档页要客户、产品供筛选和编辑窗使用。 */
function fetchLists(page: string, q: ReturnType<typeof recordListQueries>) {
  return Promise.all([
    ['customers', 'orders', 'products', 'trash'].includes(page) ? loadCustomers(q.customers) : null,
    ['products', 'orders', 'trash'].includes(page) ? loadProducts(q.products) : null,
    ['orders', 'trash'].includes(page) ? loadOrders(q.orders) : null,
  ]);
}
type Fetched = Awaited<ReturnType<typeof fetchLists>>;

const emptyMetrics = () => ({ ordersFiltered: 0, ordersPage: 1, orders: orderMetrics([]), products: productMetrics([]) });
type ListMetrics = ReturnType<typeof emptyMetrics>;
/** 页头统计：这次没读的那一类留着上一次的数 */
const nextMetrics = (m: ListMetrics, [, p, o]: Fetched): ListMetrics => ({
  ordersFiltered: o ? o.filteredRecords : m.ordersFiltered,
  ordersPage: o ? (o.page ?? 1) : m.ordersPage,
  orders: o ? o.metrics : m.orders,
  products: p ? p.metrics : m.products,
});

/** 订单的页码、排序，和筛选范围的签名（翻页、换排序不改变它） */
type OrderPaging = { orderPage: number; orderSort: RecordSort; orderSignature: string };

/** 客户、产品、订单三张列表和页头统计；筛选、页码、排序、账号或业务数据变了就重读（等 180 毫秒，连着改只读一次） */
function useListData(props: Props, filters: ListFilters, paging: OrderPaging) {
  const { page, signedIn, actorId, superMode, financeOnly, trashEntity } = props;
  const { search, customerId, status, start, end, orderView, archivedView, allRecordsView, productAttention, datePreset } = filters;
  const { orderPage, orderSort, orderSignature } = paging;
  const [customers, setCustomers] = useState<Listed<Customer>[]>([]),
    [products, setProducts] = useState<ProductListRow[]>([]),
    [orders, setOrders] = useState<Listed<TrackedOrder>[]>([]);
  // 第一次读完以前，页面下面说一句“正在连接”
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  const [revision, bumpRevision] = useBusinessRevision();
  const [listMetrics, setListMetrics] = useState(emptyMetrics);
  const loadedSignature = useRef('');
  useEffect(() => {
    if (!signedIn) return;
    if (!readsLists({ page, financeOnly, trashEntity })) {
      setBusy(false);
      setError('');
      return;
    }
    let active = true;
    setBusy(true);
    setError('');
    const q = recordListQueries({
      page, search, customerId, status, start, end, orderView, archivedView, allRecordsView, productAttention,
      superMode, orderPage, orderSort, pageSize: LIST_PAGE_SIZE,
    });
    const show = (fetched: Fetched) => {
      if (!active) return;
      const [c, p, o] = fetched;
      if (c) setCustomers(c.rows);
      if (p) setProducts(p.rows);
      if (o) setOrders(o.rows);
      if (o) loadedSignature.current = orderSignature;
      setLoaded(true);
      setListMetrics((m) => nextMetrics(m, fetched));
    };
    const timer = setTimeout(() => {
      void fetchLists(page, q)
        .then(show)
        .catch((e: unknown) => {
          if (active) setError(errorMessage(e));
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    revision, productAttention, datePreset, orderView, customerId, status, start, end, search, page, archivedView,
    allRecordsView, superMode, trashEntity, actorId, orderPage, orderSort, signedIn, financeOnly, orderSignature,
  ]);
  return {
    customers, products, orders, busy, error, loaded, reload: bumpRevision, listMetrics,
    metricsPending: busy && loadedSignature.current !== orderSignature,
  };
}

/**
 * 订单、客户、产品、归档几页的列表：筛选条件（随地址变）、读客户、产品、订单、页头统计。
 * 一直挂着（不随换页卸载），换页后筛选、归档页选的类型和原来一样还在；只有这几页才读数据。
 */
export function useRecordLists(props: Props) {
  const { page, superMode } = props;
  const filters = useListFilters(page, superMode);
  const { search, customerId, status, start, end, orderView, archivedView, allRecordsView, productAttention } = filters;
  const [orderSort, setOrderSort] = useState<RecordSort>('recent');
  // 筛选范围变化回第一页；统计也只在范围变化时才需要等待
  const orderSignature = [page, search, customerId, status, start, end, orderView, archivedView, allRecordsView].join('|');
  const [orderPage, setOrderPage] = useResettingPage(orderSignature + '|' + orderSort);
  const data = useListData(props, filters, { orderPage, orderSort, orderSignature });
  // 归档页在超级管理员模式下读的是全部记录，这里只留已归档的；搜索词来自地址里的 q
  const visibleRecord = (r: { archived: boolean }) =>
    page === 'trash' ? r.archived : superMode && allRecordsView ? true : r.archived === archivedView;
  const words = search.toLowerCase();
  const customerRows = data.customers.filter(
    (c) => visibleRecord(c) && matchesOperationalRecord(c, words),
  );
  const productRows = data.products.filter(
    (p) =>
      visibleRecord(p) &&
      (!productAttention || productIncomplete(p)) &&
      matchesProduct(p, words),
  );
  return { ...data, customerRows, productRows, ...filters, orderSort, setOrderSort, setOrderPage };
}
export type RecordLists = ReturnType<typeof useRecordLists>;
