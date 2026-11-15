import { useEffect, useRef, useState } from 'react';
import { EmptyState, Pagination, TableRegion } from '../ui/index';
import { StatusChip } from '../ui/index';
import type { MovementSummary, MovementView } from '../../shared/business/index';
import { movementTypeLabel } from '../../shared/business/index';
import { flowDocHref } from '../flow/flow-words';
import MovementDetail, { movementTone } from './MovementDetail';

const typeTone = movementTone;
type MovementsView = 'details' | 'summary';
/** 按库存品汇总的一行 */
type SummaryRow = MovementSummary[number];

/** 点在行里的链接、按钮上时由它们自己处理，不当成点了这一行 */
const onControl = (target: EventTarget, selector: string) => target instanceof Element && !!target.closest(selector);

/** 关联单据：优先可跳转的业务单据，没有关联时明确写出。采购单号、订单号没有（null 或空）的不显示。 */
function MovementSource({ m }: { m: MovementView }) {
  if (!m.flowNumber && !m.purchaseNumber && !m.customerOrderNumber) return <span className="sub">未关联单据</span>;
  return (
    <>
      {m.flowNumber && m.flowKind && <a href={flowDocHref(m.flowKind, Number(m.source_id))}>{m.flowNumber}</a>}
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
  onPickItem?: (g: SummaryRow) => void;
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
      <TableRegion label={view === 'summary' ? '按产品汇总表格' : '出入库明细表格'}>
        {view === 'details' ? (
          <MovementTable rows={rows} selected={selected} select={setSelected} />
        ) : (
          <SummaryTable rows={summary.slice((page - 1) * pageSize, page * pageSize)} empty={!summary.length} onPickItem={props.onPickItem} />
        )}
      </TableRegion>
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

/** 出入库明细：一笔流水一行，点行看详情 */
function MovementTable({
  rows,
  selected,
  select,
}: {
  rows: MovementView[];
  selected: MovementView | null;
  select: (m: MovementView) => void;
}) {
  return (
    <table className="op-flow-table">
      <thead>
        <tr>
          <th>业务日期</th>
          <th>产品</th>
          <th>类型</th>
          <th className="numeric">数量</th>
          {/* 列优先级：右侧详情打开、列表变窄时先收“变动后”“操作人”（src/design.css“列表的列优先级”） */}
          <th className="numeric col-low">变动后</th>
          <th>关联单据</th>
          <th className="col-low">操作人</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr
            key={m.id}
            tabIndex={0}
            className={'record-row' + (selected?.id === m.id ? ' selected' : '')}
            aria-selected={selected?.id === m.id}
            onClick={(e) => {
              if (!onControl(e.target, 'a,button')) select(m);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) select(m);
            }}
          >
            <td className="record-date">{m.date}</td>
            <td className="cell-wrap" title={m.itemName}>
              {m.itemName}
              {m.revisionCount > 0 && <span className="sub"> 已修订</span>}
            </td>
            <td>
              <StatusChip tone={typeTone(m)}>{movementTypeLabel(m)}</StatusChip>
            </td>
            <td className={'numeric ' + (m.direction === '-' ? 'movement-negative' : 'movement-positive')}>
              {m.direction}
              {m.delta} {m.unit}
            </td>
            <td className="numeric col-low">
              {m.after} {m.unit}
            </td>
            <td className="cell-wrap">
              <MovementSource m={m} />
            </td>
            <td className="cell-wrap col-low">{m.actor_name}</td>
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <td colSpan={7}>
              <EmptyState title="暂无符合条件的出入库明细" description="调整日期范围、类型或关键词后再看。" />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 按库存品汇总：这一页的库存品，点一行（或名称）看它的流水 */
function SummaryTable({
  rows,
  empty,
  onPickItem,
}: {
  rows: SummaryRow[];
  empty: boolean;
  onPickItem?: (g: SummaryRow) => void;
}) {
  return (
    <table className="movement-summary-table">
      <thead>
        <tr>
          <th>产品名称 / 库存品</th>
          <th>规格</th>
          <th>仓库</th>
          <th>单位</th>
          <th className="numeric">累计入库</th>
          <th className="numeric">累计出库</th>
          <th className="numeric">当前库存</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => (
          <tr
            key={g.itemId}
            className={onPickItem ? 'record-row' : undefined}
            title={onPickItem ? '看 ' + g.name + ' 的流水' : undefined}
            onClick={
              onPickItem
                ? (e) => {
                    // 名称按钮自己会处理，避免点一次触发两次
                    if (!onControl(e.target, 'button')) onPickItem(g);
                  }
                : undefined
            }
          >
            <td className="cell-wrap">
              {onPickItem ? (
                <button type="button" className="row-key" aria-label={'看 ' + g.name + ' 的流水'} onClick={() => onPickItem(g)}>
                  {g.name}
                </button>
              ) : (
                g.name
              )}
              {g.archived && <span className="sub"> 已归档</span>}
            </td>
            <td className="cell-wrap">{g.specification || '待补充'}</td>
            <td>{g.kind === 'raw' ? '原材料' : '成品'}</td>
            <td>{g.unit}</td>
            <td className="numeric movement-positive">{g.incoming}</td>
            <td className="numeric movement-negative">{g.outgoing}</td>
            <td className="numeric">
              <strong>{g.currentQuantity}</strong>
            </td>
          </tr>
        ))}
        {empty && (
          <tr>
            <td colSpan={7}>
              <EmptyState title="当前筛选没有可汇总的库存品" description="调整日期、类型或关键词后重试。" />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
