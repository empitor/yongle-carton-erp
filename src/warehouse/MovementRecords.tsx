import { useEffect, useRef, useState } from 'react';
import { DataTable, Pagination, StatusChip, type Col } from '../ui/index';
import { flowDocHref, isFlowKind } from '../../shared/core/index';
import type { MovementSummary, MovementView } from '../../shared/business/index';
import { movementTypeLabel } from '../../shared/business/index';
import MovementDetail, { movementTone } from './MovementDetail';

type MovementsView = 'details' | 'summary';
/** 按库存品汇总的一行 */
type SummaryRow = MovementSummary[number];

/** 关联单据：优先可跳转的业务单据，没有关联时明确写出。采购单号、订单号没有（null 或空）的不显示。 */
function MovementSource({ m }: { m: MovementView }) {
  if (!m.flowNumber && !m.purchaseNumber && !m.customerOrderNumber) return <span className="sub">未关联单据</span>;
  return (
    <>
      {m.flowNumber && isFlowKind(m.flowKind) && <a href={flowDocHref(m.flowKind, Number(m.source_id))}>{m.flowNumber}</a>}
      {m.purchaseNumber && <span> {m.purchaseNumber}</span>}
      {m.customerOrderNumber && <span> {m.customerOrderNumber}</span>}
    </>
  );
}

type Props = {
  rows: MovementView[];
  summary: MovementSummary;
  totalRecords: number;
  filteredRecords: number;
  pageSize: number;
  page: number;
  onPage: (page: number) => void;
  /** 只看这一个库存品时它的名字 */
  item: { name: string } | null;
  onClearItem: () => void;
  view: MovementsView;
  onView: (view: MovementsView) => void;
  /** 点“按产品汇总”的一行：只看这个库存品的流水（切回明细） */
  onPickItem: (g: SummaryRow) => void;
};

export default function MovementRecords(props: Props) {
  const { rows, summary, filteredRecords, pageSize, page, onPage, view } = props;
  const [selected, setSelected] = useState<MovementView | null>(null);
  // 面板切到页边时先翻页，新一页到达后再选中首行或末行。
  const pendingEdge = useRef<'first' | 'last' | null>(null);
  useEffect(() => {
    if (pendingEdge.current && rows.length) {
      setSelected(pendingEdge.current === 'first' ? rows[0] : rows[rows.length - 1]);
      pendingEdge.current = null;
      return;
    }
    setSelected((current) => (current ? rows.find((m) => m.id === current.id) || null : null));
  }, [rows]);
  const step = (delta: number) => {
    const index = rows.findIndex((m) => m.id === selected?.id),
      next = rows[index + delta];
    if (next) {
      setSelected(next);
      return;
    }
    const target = page + delta;
    if (index < 0 || target < 1 || target > Math.ceil(filteredRecords / pageSize)) return;
    pendingEdge.current = delta > 0 ? 'first' : 'last';
    onPage(target);
  };
  return (
    <section className="panel business-records movement-records">
      <MovementHeading {...props} clearSelected={() => setSelected(null)} />
      {view === 'details' ? (
        <DataTable
          className="op-flow-table"
          label="出入库明细表格"
          cols={movementCols}
          rows={rows}
          onRow={setSelected}
          selected={selected?.id}
          empty="暂无符合条件的出入库明细"
          emptyNote="调整日期范围、类型或关键词后再看。"
        />
      ) : (
        <DataTable
          className="movement-summary-table"
          label="按产品汇总表格"
          cols={summaryCols(props.onPickItem)}
          rows={summary.slice((page - 1) * pageSize, page * pageSize)}
          rowKey={(g) => g.itemId}
          onRow={props.onPickItem}
          empty="当前筛选没有可汇总的库存品"
          emptyNote="调整日期、类型或关键词后重试。"
        />
      )}
      <Pagination page={page} total={view === 'summary' ? summary.length : filteredRecords} pageSize={pageSize} onChange={onPage} />
      {selected && view === 'details' && (
        <MovementDetail m={selected} close={() => setSelected(null)} previous={() => step(-1)} next={() => step(1)} />
      )}
    </section>
  );
}

/** 标题、条数、明细 / 汇总切换、只看某个库存品的提示，汇总时说明累计怎么算 */
function MovementHeading({
  summary,
  totalRecords,
  filteredRecords,
  item,
  onClearItem,
  view,
  onView,
  clearSelected,
}: Props & { clearSelected: () => void }) {
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>出入库流水</h2>
          <span>
            筛选 {filteredRecords} 条 / 全部 {totalRecords} 条
            {view === 'summary' ? ` · ${summary.length} 个库存品` : ''}
          </span>
        </div>
        <div className="record-view-tabs" aria-label="流水展示方式">
          <button aria-pressed={view === 'details'} className={view === 'details' ? 'selected' : ''} onClick={() => onView('details')}>
            出入库明细
          </button>
          <button
            aria-pressed={view === 'summary'}
            className={view === 'summary' ? 'selected' : ''}
            onClick={() => {
              clearSelected();
              onView('summary');
            }}
          >
            按产品汇总
          </button>
        </div>
      </div>
      {item && (
        <div className="record-context">
          库存品：<strong>{item.name}</strong>
          <button onClick={onClearItem}>取消限定</button>
        </div>
      )}
      {view === 'summary' && (
        <p className="movement-scope">
          累计数量按当前筛选统计；盘盈计入入库、盘亏计入出库。当前库存始终取全部流水；同名的不同库存品、不同单位分开显示。点一行看这个库存品的流水。
        </p>
      )}
    </>
  );
}

/** 出入库明细的列：一笔流水一行，点行看详情。列优先级：右侧详情打开、列表变窄时先收“变动后”“操作人”（src/ui/list-layout-5.css“列表的列优先级”） */
const movementCols: Col<MovementView>[] = [
  { key: 'date', label: '业务日期', cellClass: 'record-date', render: (m) => m.date },
  {
    key: 'item',
    label: '产品',
    wrap: true,
    title: (m) => m.itemName,
    render: (m) => (
      <>
        {m.itemName}
        {m.revisionCount > 0 && <span className="sub"> 已修订</span>}
      </>
    ),
  },
  { key: 'type', label: '类型', render: (m) => <StatusChip tone={movementTone(m)}>{movementTypeLabel(m)}</StatusChip> },
  {
    key: 'delta',
    label: '数量',
    num: true,
    cellClass: (m) => (m.direction === '-' ? 'movement-negative' : 'movement-positive'),
    render: (m) => (
      <>
        {m.direction}
        {m.delta} {m.unit}
      </>
    ),
  },
  {
    key: 'after',
    label: '变动后',
    num: true,
    priority: 'low',
    render: (m) => (
      <>
        {m.after} {m.unit}
      </>
    ),
  },
  { key: 'source', label: '关联单据', wrap: true, render: (m) => <MovementSource m={m} /> },
  { key: 'actor', label: '操作人', wrap: true, priority: 'low', render: (m) => m.actor_name },
];

/** 按库存品汇总的列：这一页的库存品，点一行（或名称）看它的流水 */
const summaryCols = (pick: (g: SummaryRow) => void): Col<SummaryRow>[] => [
  {
    key: 'name',
    label: '产品名称 / 库存品',
    wrap: true,
    render: (g) => (
      <>
        <button type="button" className="row-key" aria-label={'看 ' + g.name + ' 的流水'} onClick={() => pick(g)}>
          {g.name}
        </button>
        {g.archived && <span className="sub"> 已归档</span>}
      </>
    ),
  },
  { key: 'spec', label: '规格', wrap: true, render: (g) => g.specification || '待补充' },
  { key: 'kind', label: '仓库', render: (g) => (g.kind === 'raw' ? '原材料' : '成品') },
  { key: 'unit', label: '单位', render: (g) => g.unit },
  { key: 'incoming', label: '累计入库', num: true, cellClass: 'movement-positive', render: (g) => g.incoming },
  { key: 'outgoing', label: '累计出库', num: true, cellClass: 'movement-negative', render: (g) => g.outgoing },
  { key: 'current', label: '当前库存', num: true, render: (g) => <strong>{g.currentQuantity}</strong> },
];
