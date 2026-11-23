import { useEffect, useState } from 'react';
import { pageHref, type DatePreset, type OrderView } from '../../shared/core/index';
import { hashParams } from '../ui/index';
import { archivedRoute, readListFilters } from './record-filters';

/**
 * 订单、客户、产品、归档几页的列表筛选：随地址变，换页后还在（由 useRecordLists 一直挂着）。
 * 状态、客户编号存的是文字：工具栏的下拉框给的是文字，读列表时再按词表收窄（record-filters.ts）。
 */
export function useListFilters(page: string, superMode: boolean) {
  const [allRecordsView, setAllRecordsView] = useState(false),
    [search, setSearch] = useState(''),
    [customerId, setCustomerId] = useState<string>(() => readListFilters().customerId),
    [status, setStatus] = useState<string>(() => readListFilters().status),
    [start, setStart] = useState(() => readListFilters().start),
    [end, setEnd] = useState(() => readListFilters().end),
    [productAttention, setProductAttention] = useState(false),
    [datePreset, setDatePreset] = useState<DatePreset>(() => readListFilters().preset),
    [orderView, setOrderView] = useState<OrderView>(() => readListFilters().view),
    [archivedView, setArchivedView] = useState(() => archivedRoute());
  // 地址变了：列表筛选按新地址重读（换页由 App 处理）；setXxx 都是 React 给的、不会变
  useEffect(() => {
    const f = () => {
      setArchivedView(archivedRoute());
      const filters = readListFilters();
      setDatePreset(filters.preset);
      setStart(filters.start);
      setEnd(filters.end);
      setOrderView(filters.view);
      setStatus(filters.status);
      setCustomerId(filters.customerId);
      setAllRecordsView(false);
      setSearch(hashParams().get('q') || '');
      setProductAttention(false);
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    if (!superMode) setAllRecordsView(false);
  }, [superMode]);
  // 列表工具栏的分段：订单多一个“待处理”
  const listScope = archivedView ? 'archived' : page === 'orders' && orderView === 'pending' ? 'pending' : 'all';
  const changeScope = (scope: string) => {
    setAllRecordsView(false);
    setArchivedView(scope === 'archived');
    if (page === 'orders') {
      setOrderView(scope === 'pending' ? 'pending' : 'current');
      const next = scope === 'all' || scope === 'archived' ? scope : undefined;
      history.replaceState(null, '', pageHref('orders', { scope: next }));
    } else if (page === 'customers' || page === 'products') {
      history.replaceState(null, '', pageHref(page, { scope: scope === 'archived' ? 'archived' : undefined }));
    }
  };
  const orderFilterCount =
    (customerId ? 1 : 0) + (status ? 1 : 0) + (datePreset !== 'all' ? 1 : 0) + (allRecordsView ? 1 : 0);
  const clearListFilters = () => {
    setCustomerId('');
    setStatus('');
    setAllRecordsView(false);
    setDatePreset('all');
    setStart('');
    setEnd('');
  };
  return {
    search, setSearch, customerId, setCustomerId, status, setStatus,
    datePreset, setDatePreset, start, setStart, end, setEnd,
    orderView, archivedView, allRecordsView, setAllRecordsView, productAttention, setProductAttention,
    listScope, changeScope, orderFilterCount, clearListFilters,
  };
}
export type ListFilters = ReturnType<typeof useListFilters>;
