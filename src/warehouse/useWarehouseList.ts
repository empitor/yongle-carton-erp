import { useEffect, useState } from 'react';
import type { DatePreset } from '../../shared/core/index';
import { hashParams, LIST_PAGE_SIZE } from '../ui/index';
import { useWarehouseData } from './useWarehouseData';
import { warehouseRows, type WarehouseKind, type WarehouseRow, type WarehouseScope } from './warehouse-list';

/**
 * 到货、送货页的列表：读记录（默认只读待处理和最近的，要找更早的时读全部）、筛选（搜索、往来单位、状态、日期、
 * 待处理 / 全部 / 已归档）、翻页。地址栏带来的条件（待处理、某一天、某张采购单）在打开时用一次。
 */
export function useWarehouseList(kind: WarehouseKind, actorId: unknown) {
  const params = hashParams(),
    purchaseFilter = params.get('purchase');
  // 读了全部记录，还是只读了待处理和最近一段时间的
  const [full, setFull] = useState(false),
    [q, setQ] = useState(''),
    [scope, setScope] = useState<WarehouseScope>(
      params.get('state') === 'pending' || kind === 'delivery' ? 'open' : 'all',
    ),
    [status, setStatus] = useState(''),
    // 到货按供应商、送货按客户：记录上有编号的按编号（改过名的也算一家），老记录没有编号的按名称
    [party, setParty] = useState(''),
    [datePreset, setDatePreset] = useState<DatePreset>(params.get('date') ? 'custom' : 'all'),
    [from, setFrom] = useState(params.get('date') || ''),
    [to, setTo] = useState(params.get('date') || ''),
    [page, setPage] = useState(1);
  const data = useWarehouseData(kind, scope, full, actorId);
  const { records, archivedRows, purchases, recentFrom } = data;
  // 搜索、从采购单跳过来、筛到最近范围以前的日期：要在全部记录里找（读过全部就不再变）
  useEffect(() => {
    if (
      !full &&
      (q.trim() ||
        purchaseFilter ||
        (recentFrom && ((from && from < recentFrom) || (to && to < recentFrom))))
    )
      setFull(true);
  }, [full, purchaseFilter, q, from, to, recentFrom]);
  useEffect(() => setPage(1), [q, scope, party, status, from, to]);
  const archivedScope = scope === 'archived';
  const shown: readonly WarehouseRow[] = archivedScope ? archivedRows : records;
  const filtered = warehouseRows(kind, shown, {
    scope,
    q,
    party,
    status,
    from,
    to,
    purchaseFilter,
    purchases,
  });
  useEffect(
    () => setPage((p) => Math.min(p, Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE)))),
    [filtered.length],
  );
  const filterCount = (party ? 1 : 0) + (status ? 1 : 0) + (from || to ? 1 : 0);
  const clearFilters = () => {
    setParty('');
    setStatus('');
    setDatePreset('all');
    setFrom('');
    setTo('');
  };
  return {
    ...data,
    full, setFull, q, setQ, scope, setScope, status, setStatus, party, setParty,
    datePreset, setDatePreset, from, setFrom, to, setTo, page, setPage,
    archivedScope, filtered, filterCount, clearFilters,
    pageRows: filtered.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE),
  };
}
export type WarehouseList = ReturnType<typeof useWarehouseList>;
