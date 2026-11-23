import { useState } from 'react';
import { initialMovementRange, matchesMovement, movementLabels, movementTypes, type MovementSummary, type MovementView, type StockItemView } from '../../shared/business/index';
import { presetRange, type DatePreset, stockKinds } from '../../shared/core/index';
import { PageHeading, useResettingPage, DateFilter, hashParams, LIST_PAGE_SIZE, ListToolbar, FilterRow } from '../ui/index';
import MovementRecords from '../warehouse/MovementRecords';
import { loadMovements, loadStockItems } from './list-api';
import { recordRange } from './page-state';
import { cleanDateParams } from './record-filters';
import { useRecordData, useRecordPage } from './useRecordPage';
import RecordPageBody from './RecordPageBody';

/** 这一页读到的：库存品（显示选中那一个的名称）、这一页流水和分页、按库存品汇总 */
type MovementData = {
  items: StockItemView[];
  movements: MovementView[];
  movementTotal: number;
  movementFiltered: number;
  movementPage: number;
  movementGroups: MovementSummary;
};
const emptyMovements: MovementData = {
  items: [],
  movements: [],
  movementTotal: 0,
  movementFiltered: 0,
  movementPage: 1,
  movementGroups: [],
};
/** 只看某一个库存品 */
type FlowItem = { id: number; name: string };

/**
 * 进页面时的日期：地址带了认得的范围按它（写坏的日期当作没写，见 cleanDateParams）；
 * 从库存品详情“查看全部”过来的只看这一项、不限日期；其余默认最近两个月（initialMovementRange）。
 */
function initialDates(params: URLSearchParams, oneItem: boolean): { preset: DatePreset; start: string; end: string } {
  return oneItem ? { preset: 'all', ...presetRange('all') } : initialMovementRange(params);
}

/** 地址里的仓库（kind=raw / finished），别的当作全部仓库 */
const warehouseParam = (params: URLSearchParams) => stockKinds.find((k) => k === params.get('kind')) ?? '';
/** 只看某一个库存品时显示的名称：带过来的、库存品清单里的、流水里的，都没有就说“选中的库存品” */
const itemName = (item: FlowItem, items: readonly StockItemView[], movements: readonly MovementView[]) =>
  item.name || items.find((i) => i.id === item.id)?.name || movements[0]?.itemName || '选中的库存品';

/** 读这一页：库存品清单（只为显示名称）、这一页流水（服务端分页）和按库存品汇总 */
function useMovementData(o: {
  p: ReturnType<typeof useRecordPage>;
  kind: string;
  flowKind: string;
  flowAction: string;
  flowItem: FlowItem | null;
  dates: { start: string; end: string };
  page: number;
}) {
  const { p, kind, flowKind, flowAction, flowItem, page } = o,
    { start, end } = o.dates;
  return useRecordData(
    [p.revision, p.superMode, start, end, p.search, flowKind, flowAction, flowItem?.id, kind, page].join('|'),
    () =>
      Promise.all([
        loadStockItems({ range: recordRange(p.superMode, false, false), kind, zeroOnly: false }),
        loadMovements({
          kind: flowKind,
          action: flowAction,
          start,
          end,
          search: p.search,
          itemId: flowItem?.id,
          page,
          pageSize: LIST_PAGE_SIZE,
        }),
      ]).then(
        ([items, movements]): MovementData => ({
          items: items.rows,
          movements: movements.rows,
          movementTotal: movements.totalRecords,
          movementFiltered: movements.filteredRecords,
          movementPage: movements.page ?? 1,
          movementGroups: movements.metrics,
        }),
      ),
    emptyMovements,
  );
}

/** “筛选”弹层：仓库类型、变动类型、业务日期 */
function MovementFilters(o: {
  flowKind: string;
  setFlowKind: (kind: string) => void;
  flowAction: string;
  setFlowAction: (action: string) => void;
  dates: { preset: DatePreset; start: string; end: string };
  setDates: (dates: { preset: DatePreset; start: string; end: string }) => void;
}) {
  return (
    <>
      <FilterRow label="仓库类型">
        <select aria-label="筛选流水仓库" value={o.flowKind} onChange={(e) => o.setFlowKind(e.target.value)}>
          <option value="">全部仓库</option>
          <option value="raw">原材料仓库</option>
          <option value="finished">成品仓库</option>
        </select>
      </FilterRow>
      <FilterRow label="变动类型">
        <select aria-label="筛选流水类型" value={o.flowAction} onChange={(e) => o.setFlowAction(e.target.value)}>
          <option value="">全部类型</option>
          {movementTypes.map((a) => (
            <option value={a} key={a}>
              {movementLabels[a]}
            </option>
          ))}
        </select>
      </FilterRow>
      <DateFilter
        label="业务日期"
        preset={o.dates.preset}
        start={o.dates.start}
        end={o.dates.end}
        change={(preset, s, e) => o.setDates({ preset, start: s, end: e })}
      />
    </>
  );
}

/**
 * 库存流水页：按仓库、变动类型、业务日期、关键词筛，默认最近两个月；从库存品详情“查看全部”过来的只看这一个库存品的全部日期。
 * 变动类型按来源单据分（采购到货、生产领料、客户发货、单据撤销……），手动的只算没有来源单据的。
 * 明细和按库存品汇总两种看法。
 */
export default function MovementsPage() {
  const p = useRecordPage();
  const params = cleanDateParams(hashParams());
  // 从库存品详情“查看全部”过来的流水：看这一项的全部日期
  const oneItem = Number(params.get('item')) > 0 && !params.get('range');
  const [dates, setDates] = useState(() => initialDates(params, oneItem)),
    // 读库存品只为了显示选中的那一个的名称：原材料或成品（地址里带的），和库存页一样
    [kind] = useState(params.get('kind') === 'finished' ? 'finished' : 'raw'),
    [flowKind, setFlowKind] = useState<string>(warehouseParam(params)),
    [flowAction, setFlowAction] = useState(''),
    [summaryPage, setSummaryPage] = useState(1),
    [movementView, setMovementView] = useState<'details' | 'summary'>('details'),
    // 从库存品详情“最近流水 · 查看全部”过来的：只看这一个库存品
    [flowItem, setFlowItem] = useState<FlowItem | null>(() =>
      Number(params.get('item')) > 0 ? { id: Number(params.get('item')), name: '' } : null,
    );
  const { start, end } = dates;
  const [movementPage, setMovementPage] = useResettingPage(
    [p.search, start, end, flowKind, flowAction, flowItem?.id, true].join('|'),
  );
  const { data, error, busy } = useMovementData({ p, kind, flowKind, flowAction, flowItem, dates, page: movementPage });
  const movements = data.movements.filter((m) =>
    matchesMovement(m, {
      kind: stockKinds.find((k) => k === flowKind),
      action: movementTypes.find((a) => a === flowAction),
      itemId: flowItem?.id,
      start: start || undefined,
      end: end || undefined,
      q: p.search,
    }),
  );
  /** 清除筛选：回到全部仓库、全部类型、最近两个月，不再只看某一个库存品 */
  const clearFilters = () => {
    setFlowItem(null);
    setFlowAction('');
    setFlowKind('');
    setDates({ preset: '2', ...presetRange('2') });
  };
  const filterCount = (flowKind ? 1 : 0) + (flowAction ? 1 : 0) + (dates.preset !== '2' ? 1 : 0) + (flowItem ? 1 : 0);
  return (
    <div className="operations-workspace unified-business-page">
      <PageHeading title="流水" />
      <div>
        <ListToolbar
          search={p.search}
          onSearch={p.setSearch}
          searchLabel="搜索业务记录"
          placeholder="搜索库存品、采购单号、用途、操作人"
          busy={busy}
          filterCount={filterCount}
          onClearFilters={clearFilters}
          filters={
            <MovementFilters
              flowKind={flowKind}
              setFlowKind={(next) => {
                setFlowKind(next);
                setFlowItem(null);
              }}
              flowAction={flowAction}
              setFlowAction={setFlowAction}
              dates={dates}
              setDates={setDates}
            />
          }
          note="累计出入库按筛选范围统计，当前库存不受日期限制。"
        />
        <RecordPageBody error={error} loading={busy && !movements.length}>
          <MovementRecords
            rows={movements}
            view={movementView}
            onView={(v) => {
              setMovementView(v);
              setSummaryPage(1);
            }}
            summary={data.movementGroups}
            totalRecords={data.movementTotal}
            filteredRecords={data.movementFiltered}
            pageSize={LIST_PAGE_SIZE}
            page={movementView === 'summary' ? summaryPage : data.movementPage}
            onPage={movementView === 'summary' ? setSummaryPage : setMovementPage}
            item={flowItem && { ...flowItem, name: itemName(flowItem, data.items, movements) }}
            onClearItem={() => setFlowItem(null)}
            onPickItem={(g) => {
              setFlowItem({ id: g.itemId, name: g.name });
              setFlowKind(g.kind);
              setMovementView('details');
            }}
          />
        </RecordPageBody>
      </div>
    </div>
  );
}
