import { Search } from 'lucide-react';
import { DateFilter, FilterPopover, Segmented } from '../ui/index';
import { FilterRow } from '../recordkit/ListToolbar';
import { StatusFilter } from '../flow/ListParts';
import { partyChoices, type WarehouseKind, type WarehouseScope } from './warehouse-list';
import type { WarehouseList } from './useWarehouseList';

/** 看哪些记录：待处理 / 全部 / 已归档 */
const scopeOptions = [
  ['open', '待处理'],
  ['all', '全部'],
  ['archived', '已归档'],
] as const satisfies readonly (readonly [WarehouseScope, string])[];

/** 到货、送货页列表上方：搜索、待处理 / 全部 / 已归档、“筛选”里的供应商或客户、状态、日期。 */
export default function WarehouseToolbar({
  kind,
  list,
  closeView,
}: {
  kind: WarehouseKind;
  list: WarehouseList;
  /** 换了看哪些记录：关掉打开着的详情 */
  closeView: () => void;
}) {
  const name = kind === 'arrival' ? '到货' : '送货',
    partyLabel = kind === 'arrival' ? '供应商' : '客户';
  return (
    <div className="flow-toolbar" role="search">
      <label className="flow-search">
        <Search size={15} aria-hidden="true" />
        <input
          aria-label={'搜索' + name + '记录'}
          placeholder={'搜索单号、' + (kind === 'arrival' ? '供应商、采购单' : '客户、订单') + '或产品'}
          value={list.q}
          onChange={(e) => list.setQ(e.target.value)}
        />
      </label>
      <Segmented
        label={'看哪些' + name + '记录'}
        value={list.scope}
        onChange={(key) => {
          const picked = scopeOptions.find(([scope]) => scope === key);
          if (!picked) return;
          closeView();
          list.setScope(picked[0]);
        }}
        options={scopeOptions}
      />
      <FilterPopover active={list.filterCount} onClear={list.clearFilters}>
        <FilterRow label={partyLabel}>
          <select aria-label={'筛选' + partyLabel} value={list.party} onChange={(e) => list.setParty(e.target.value)}>
            <option value="">{'全部' + partyLabel}</option>
            {partyChoices(list.records).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </FilterRow>
        <StatusFilter kind={kind} label={name + '状态'} value={list.status} change={list.setStatus} />
        <DateFilter
          label={name + '日期'}
          preset={list.datePreset}
          start={list.from}
          end={list.to}
          change={(preset, start, end) => {
            list.setDatePreset(preset);
            list.setFrom(start);
            list.setTo(end);
          }}
        />
      </FilterPopover>
    </div>
  );
}
