import { useState } from 'react';
import { inventoryMetrics, matchesOperationalRecord, type StockItemView } from '../../shared/business/index';
import { MoreMenu, PageHeading, useLoad } from '../ui/index';
import BusinessRecords from './BusinessRecords';
import ListToolbar, { FilterRow } from '../recordkit/ListToolbar';
import { readCatalog } from '../recordkit/catalog-api';
import WarehouseNavigation from '../warehouse/WarehouseNavigation';
import OperationsSummary from './OperationsSummary';
import { loadStockItems } from './list-api';
import { useOperationsEditor } from './useOperationsEditor';
import { useRecordData, useRecordPage } from './useRecordPage';
import RecordPageBody from './RecordPageBody';

/** 读到之前的空库存（统计也是空的） */
const emptyStock: { items: StockItemView[]; itemTotal: number; inventoryMetrics: { raw: InventoryMetrics; finished: InventoryMetrics } } = {
  items: [],
  itemTotal: 0,
  inventoryMetrics: { raw: inventoryMetrics([], 'raw'), finished: inventoryMetrics([], 'finished') },
};

type InventoryMetrics = ReturnType<typeof inventoryMetrics>;
/** 筛选下拉要的供应商、客户（档案清单） */
type Parties = { suppliers: readonly { id: number; name: string }[]; customers: readonly { id: number; name: string }[] };

/** 库存“筛选”的往来单位下拉（原材料按供应商，成品按客户）和记录范围（在用的 / 已归档的 / 全部） */
function StockFilters({
  kind,
  party,
  setParty,
  parties,
  zeroOnly,
  p,
}: {
  kind: string;
  party: string;
  setParty: (v: string) => void;
  parties: Parties | null;
  zeroOnly: boolean;
  p: ReturnType<typeof useRecordPage>;
}) {
  const raw = kind === 'raw';
  return (
    <>
      {!zeroOnly && (
        <FilterRow label={raw ? '供应商' : '客户'}>
          <select aria-label={raw ? '筛选供应商' : '筛选客户'} value={party} onChange={(e) => setParty(e.target.value)}>
            <option value="">{raw ? '全部供应商' : '全部客户'}</option>
            {(raw ? parties?.suppliers : parties?.customers)?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </FilterRow>
      )}
      {/* 在用的 / 已归档的 / 全部记录（超级管理员）合成一个下拉，不再另放勾选框 */}
      <FilterRow label="记录范围">
        <select
          aria-label="库存品记录范围"
          value={p.all ? 'everything' : p.archived ? 'archived' : 'all'}
          onChange={(e) => {
            const v = e.target.value;
            p.setScope(v === 'archived' ? 'archived' : 'all');
            p.setAll(v === 'everything');
          }}
        >
          <option value="all">在用的</option>
          <option value="archived">已归档的</option>
          {p.superMode && <option value="everything">全部（连同已归档的）</option>}
        </select>
      </FilterRow>
    </>
  );
}

/** 库存不放主按钮：新建库存品和只看零库存收进“更多” */
function StockMore(o: { kind: string; busy: boolean; zeroOnly: boolean; create: () => void; toggleZero: () => void }) {
  return (
    <MoreMenu text="更多" label="库存的更多操作">
      <button type="button" role="menuitem" disabled={o.busy} onClick={o.create}>
        新建{o.kind === 'raw' ? '原材料' : '成品'}库存品
      </button>
      <button type="button" role="menuitem" onClick={o.toggleZero}>
        {o.zeroOnly ? '显示全部库存' : '只看零库存'}
      </button>
    </MoreMenu>
  );
}

/**
 * 库存页：原材料 / 成品两个分段，按往来单位筛（原材料按供应商，成品按客户），只看零库存。
 * 新建库存品、出入库 / 盘点。recycle 是归档页里的已归档库存品。
 */
export default function StockPage({ recycle = false }: { recycle?: boolean }) {
  const p = useRecordPage({ recycle });
  const [kind, setKind] = useState(p.params.get('kind') === 'finished' ? 'finished' : 'raw'),
    // 库存按往来单位筛：原材料按供应商，成品按客户
    [stockParty, setStockParty] = useState(''),
    [zeroOnly, setZeroOnly] = useState(p.params.get('zero') === '1');
  const { data, error, busy } = useRecordData(
    [p.revision, p.range, p.search, kind, zeroOnly, stockParty].join('|'),
    () =>
      loadStockItems({ range: p.range, kind, zeroOnly, party: stockParty, search: p.search }).then((items) => ({
        items: items.rows,
        itemTotal: items.totalRecords,
        inventoryMetrics: items.metrics,
      })),
    emptyStock,
  );
  // 库存“筛选”里的供应商、客户下拉：进库存列表时读一次
  const parties = useLoad(recycle ? null : 'parties', () => readCatalog(['suppliers', 'customers'])).data;
  const ops = useOperationsEditor({ superMode: p.superMode, items: data.items, kind, setNotice: p.setNotice });
  const rows = data.items.filter(
    (r) => matchesOperationalRecord(r, p.search) && (zeroOnly || r.kind === kind) && (!zeroOnly || r.balanceUnits === 0),
  );
  const changeKind = (next: 'raw' | 'finished') => {
    setKind(next);
    setStockParty('');
    setZeroOnly(false);
    p.setSearch('');
    if (!recycle) history.replaceState(null, '', '#warehouse?kind=' + next);
  };
  const clearFilters = () => {
    setStockParty('');
    p.setAll(false);
    if (p.archived) p.setScope('all');
  };
  const shownError = error || ops.error;
  return (
    <div className="operations-workspace unified-business-page">
      {!recycle && (
        <PageHeading
          title="库存"
          actions={
            p.canEdit && (
              <StockMore
                kind={kind}
                busy={busy}
                zeroOnly={zeroOnly}
                create={() => ops.setEditor({ type: 'stock' })}
                toggleZero={() => setZeroOnly((v) => !v)}
              />
            )
          }
          meta={
            <OperationsSummary
              mode="warehouse"
              kind={kind}
              flowTab={false}
              error={shownError}
              busy={busy}
              metricsPending={false}
              data={data}
              zeroOnly={zeroOnly}
            />
          }
        />
      )}
      <div>
        <ListToolbar
          search={p.search}
          onSearch={p.setSearch}
          searchLabel="搜索库存品"
          placeholder="搜索名称、规格、材质"
          busy={busy}
          filterCount={(stockParty && !zeroOnly ? 1 : 0) + (p.archived || p.all ? 1 : 0)}
          onClearFilters={recycle ? undefined : clearFilters}
          filters={
            recycle ? undefined : (
              <StockFilters kind={kind} party={stockParty} setParty={setStockParty} parties={parties} zeroOnly={zeroOnly} p={p} />
            )
          }
          keyFilter={!zeroOnly && <WarehouseNavigation view={kind === 'finished' ? 'finished' : 'raw'} onChange={changeKind} />}
          note={
            zeroOnly ? (
              <>
                正在只看零库存（原材料和成品一起）。
                <button type="button" className="text-link" onClick={() => setZeroOnly(false)}>
                  显示全部库存
                </button>
              </>
            ) : undefined
          }
        />
        <RecordPageBody error={shownError} notice={p.notice} loading={busy && !rows.length}>
          <BusinessRecords
            filterKey={[stockParty, p.scope, p.all, kind, zeroOnly].join('|')}
            entity="stock_items"
            rows={rows}
            archived={p.archived || recycle}
            allRecords={p.all}
            recycle={recycle}
            empty={zeroOnly ? { title: '没有零库存的库存品', description: '点上面的“显示全部库存”回到全部。' } : undefined}
            changed={p.changed}
            edit={(v) => ops.setEditor({ type: 'stock', value: v })}
            onMove={(r) => ops.setEditor({ type: 'move', value: r })}
          />
        </RecordPageBody>
      </div>
      {ops.editors}
    </div>
  );
}
