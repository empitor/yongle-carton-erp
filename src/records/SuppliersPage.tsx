import { useState } from 'react';
import { Plus } from 'lucide-react';
import { matchesOperationalRecord, type SupplierView } from '../../shared/business/index';
import { PageHeading } from '../ui/index';
import BusinessRecords from './BusinessRecords';
import ListToolbar, { FilterRow } from '../recordkit/ListToolbar';
import OperationsSummary from './OperationsSummary';
import { loadSuppliers } from './list-api';
import { AllRecordsCheck, type Scope } from './page-state';
import { useOperationsEditor } from './useOperationsEditor';
import { useRecordData, useRecordPage } from './useRecordPage';
import RecordPageBody from './RecordPageBody';

/** 读到之前是空列表 */
const noSuppliers: SupplierView[] = [];
/** 分段只有“全部”“已归档” */
const scopeOf = (value: string): Scope => (value === 'archived' ? 'archived' : 'all');

const scopes = [
  { value: 'all', label: '全部' },
  { value: 'archived', label: '已归档' },
];

/** 供应商页：列表、筛选（有没有采购往来）、新建和编辑供应商。recycle 是归档页里的已归档供应商。 */
export default function SuppliersPage({ recycle = false }: { recycle?: boolean }) {
  const p = useRecordPage({ recycle });
  const [historyFilter, setHistoryFilter] = useState('');
  const { data, error, busy } = useRecordData(
    [p.revision, p.range, p.search, historyFilter].join('|'),
    () =>
      loadSuppliers({ range: p.range, search: p.search, history: historyFilter }).then((r) => ({
        suppliers: r.rows,
        supplierTotal: r.totalRecords,
      })),
    { suppliers: noSuppliers, supplierTotal: 0 },
  );
  const ops = useOperationsEditor({ superMode: p.superMode, setNotice: p.setNotice });
  const rows = data.suppliers.filter(
    (r) =>
      matchesOperationalRecord(r, p.search) &&
      (!historyFilter || (historyFilter === 'with') === r.purchaseHistory.length > 0),
  );
  const changeScope = (next: string) => {
    p.setScope(scopeOf(next));
    p.setAll(false);
    if (!recycle) history.replaceState(null, '', '#suppliers' + (next === 'all' ? '' : '?scope=' + next));
  };
  const shownError = error || ops.error;
  return (
    <div className="operations-workspace unified-business-page">
      {!recycle && (
        <PageHeading
          title="供应商"
          actions={
            p.canEdit && (
              <button className="primary" disabled={busy} onClick={() => ops.setEditor({ type: 'supplier' })}>
                <Plus size={17} />
                新建供应商
              </button>
            )
          }
          meta={
            <OperationsSummary
              mode="suppliers"
              kind="raw"
              flowTab={false}
              error={shownError}
              busy={busy}
              metricsPending={false}
              data={data}
            />
          }
        />
      )}
      <div>
        <ListToolbar
          search={p.search}
          onSearch={p.setSearch}
          searchLabel="搜索供应商"
          placeholder="搜索供应商、联系人、电话"
          scopes={recycle ? undefined : scopes}
          scope={p.scope}
          onScope={changeScope}
          filterCount={(historyFilter ? 1 : 0) + (p.all ? 1 : 0)}
          onClearFilters={() => {
            setHistoryFilter('');
            p.setAll(false);
          }}
          busy={busy}
          filters={
            <>
              <FilterRow label="采购往来">
                <select aria-label="筛选采购关联" value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value)}>
                  <option value="">全部供应商</option>
                  <option value="with">有过采购单</option>
                  <option value="without">还没采购过</option>
                </select>
              </FilterRow>
              {p.superMode && !recycle && <AllRecordsCheck all={p.all} setAll={p.setAll} />}
            </>
          }
        />
        <RecordPageBody error={shownError} notice={p.notice} loading={busy && !rows.length}>
          <BusinessRecords
            filterKey={[p.scope, p.all, historyFilter].join('|')}
            entity="suppliers"
            rows={rows}
            archived={p.archived || recycle}
            allRecords={p.all}
            recycle={recycle}
            changed={p.changed}
            edit={(v) => ops.setEditor({ type: 'supplier', value: v })}
          />
        </RecordPageBody>
      </div>
      {ops.editors}
    </div>
  );
}
