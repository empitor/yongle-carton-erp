import { displayOrderStatuses } from '../../shared/core/index';
import type { RecordLists } from './useRecordLists';
import { DateFilter, FilterRow, ListToolbar } from '../ui/index';

/**
 * 订单、客户、产品列表的工具栏：搜索 + 一个分段 + “筛选”弹层（客户、状态、日期，超级管理员可含已归档）。
 * 产品页“只看资料不全”时在下面说一句、能一键看全部。
 */
export default function RecordsToolbar({
  page,
  lists: l,
  superMode,
}: {
  page: 'orders' | 'customers' | 'products';
  lists: RecordLists;
  superMode: boolean;
}) {
  // 订单、产品的“筛选”弹层里共用的客户下拉
  const customerFilter = (
    <FilterRow label="客户">
      <select aria-label="筛选客户" value={l.customerId} onChange={(e) => l.setCustomerId(e.target.value)}>
        <option value="">全部客户</option>
        {l.customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </FilterRow>
  );
  const allRecordsCheck = superMode && (
    <label className="list-toolbar-check">
      <input type="checkbox" checked={l.allRecordsView} onChange={(e) => l.setAllRecordsView(e.target.checked)} />
      连同已归档的一起看（全部记录）
    </label>
  );
  return (
    <ListToolbar
      search={l.search}
      onSearch={l.setSearch}
      searchLabel={page === 'orders' ? '搜索订单' : page === 'customers' ? '搜索客户' : '搜索产品'}
      placeholder={
        page === 'orders'
          ? '搜索单号、客户、产品'
          : page === 'customers'
            ? '搜索客户、联系人、电话、地址'
            : '搜索产品名称、材质、楞型'
      }
      scopes={
        page === 'orders'
          ? [
              { value: 'pending', label: '待处理' },
              { value: 'all', label: '全部' },
              { value: 'archived', label: '已归档' },
            ]
          : [
              { value: 'all', label: '全部' },
              { value: 'archived', label: '已归档' },
            ]
      }
      scope={l.listScope}
      onScope={l.changeScope}
      busy={l.busy}
      filterCount={
        page === 'orders'
          ? l.orderFilterCount
          : (page === 'products' && l.customerId ? 1 : 0) + (l.allRecordsView ? 1 : 0)
      }
      onClearFilters={l.clearListFilters}
      filters={
        page === 'orders' ? (
          <>
            {customerFilter}
            <FilterRow label="订单状态">
              <select aria-label="筛选状态" value={l.status} onChange={(e) => l.setStatus(e.target.value)}>
                <option value="">全部状态</option>
                {displayOrderStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FilterRow>
            <DateFilter
              label="下单日期"
              preset={l.datePreset}
              start={l.start}
              end={l.end}
              change={(preset, start, end) => {
                l.setDatePreset(preset);
                l.setStart(start);
                l.setEnd(end);
              }}
            />
            {allRecordsCheck}
          </>
        ) : page === 'products' ? (
          <>
            {customerFilter}
            {allRecordsCheck}
          </>
        ) : (
          allRecordsCheck || undefined
        )
      }
      note={
        page === 'products' && l.productAttention ? (
          <>
            只看资料不全的产品。
            <button type="button" className="text-link" onClick={() => l.setProductAttention(false)}>
              看全部
            </button>
          </>
        ) : undefined
      }
    />
  );
}
