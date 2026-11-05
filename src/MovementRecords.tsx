import { useEffect, useRef, useState } from 'react';
import { EmptyState, Pagination, TableRegion } from './ui/ListLayout';
import DetailPanel from './ui/DetailPanel';
import StatusBadge from './StatusBadge';
import { movementLabels, type movementActions } from '../shared/movement-filters';
import type { MovementSummary } from '../shared/business-metrics';
import { quantityString } from '../shared/operations';
import { managementRequest } from './session';

export const MOVEMENT_PAGE_SIZE = 50;

/** 流水被管理员改写过时展示原值，打开面板时才读取修订台账。 */
function MovementRevisions({ id, count }: { id: string; count: number }) {
  const [list, setList] = useState<any[] | null>(null);
  useEffect(() => {
    let active = true;
    setList(null);
    void managementRequest<any[]>('/warehouse/movements/' + encodeURIComponent(id) + '/revisions')
      .then((rows) => {
        if (active) setList(rows);
      })
      .catch(() => {
        if (active) setList([]);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <section className="movement-revisions">
      <h3>修订记录（{count} 次）</h3>
      {!list && <p className="sub">正在读取…</p>}
      {(list || []).map((r, i) => (
        <p key={i}>
          {r.at.slice(0, 10)} {r.actorName}：{r.reason}，原变动{' '}
          {quantityString(Math.abs(r.before.delta_units))}（{r.before.date}）
          {r.after ? ' → ' + quantityString(Math.abs(r.after.delta_units)) : ' → 已移除'}
        </p>
      ))}
    </section>
  );
}

const movementType = (m: any) =>
  m.source_kind === 'flow_production'
    ? m.kind === 'finished'
      ? '生产完工入库'
      : m.direction === '-'
        ? '生产领料'
        : '生产退料'
    : m.source_kind === 'flow_delivery'
      ? '客户发货'
      : m.source_kind === 'flow_reversal'
        ? '单据冲销'
        : movementLabels[m.action as (typeof movementActions)[number]];

const flowLink = (m: any) =>
  m.flowKind === 'delivery'
    ? '#warehouse?kind=finished&deliveries=1&doc=' + m.source_id
    : '#' + (m.flowKind === 'arrival' ? 'arrivals' : 'production') + '?doc=' + m.source_id;

/** 关联单据：优先可跳转的业务单据，没有关联时明确写出。 */
function MovementSource({ m }: { m: any }) {
  if (!m.flowNumber && !m.purchaseNumber && !m.customerOrderNumber)
    return <span className="sub">未关联单据</span>;
  return (
    <>
      {m.flowNumber && <a href={flowLink(m)}>{m.flowNumber}</a>}
      {m.purchaseNumber && <span> {m.purchaseNumber}</span>}
      {m.customerOrderNumber && <span> {m.customerOrderNumber}</span>}
    </>
  );
}

export default function MovementRecords({
  rows,
  summary,
  totalRecords,
  filteredRecords,
  pageSize,
  page,
  onPage,
  item,
  onClearItem,
  view,
  onView,
}: {
  rows: any[];
  summary: MovementSummary;
  totalRecords: number;
  filteredRecords: number;
  pageSize: number;
  page: number;
  onPage: (page: number) => void;
  item: any;
  onClearItem: () => void;
  view: 'details' | 'summary';
  onView: (view: 'details' | 'summary') => void;
}) {
  const [selected, setSelected] = useState<any>(null);
  // 面板切到页边时先翻页，新一页到达后再选中首行或末行。
  const pendingEdge = useRef<'first' | 'last' | null>(null);
  useEffect(() => {
    if (pendingEdge.current && rows.length) {
      setSelected(pendingEdge.current === 'first' ? rows[0] : rows[rows.length - 1]);
      pendingEdge.current = null;
      return;
    }
    setSelected((current: any) => (current ? rows.find((m) => m.id === current.id) || null : null));
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
      <div className="section-heading">
        <div>
          <h2>出入库流水</h2>
          <span>
            筛选 {filteredRecords} 条 / 全部 {totalRecords} 条
            {view === 'summary' ? ` · ${summary.length} 个库存品` : ''}
          </span>
        </div>
        <div className="record-view-tabs" aria-label="流水展示方式">
          <button
            aria-pressed={view === 'details'}
            className={view === 'details' ? 'selected' : ''}
            onClick={() => onView('details')}
          >
            出入库明细
          </button>
          <button
            aria-pressed={view === 'summary'}
            className={view === 'summary' ? 'selected' : ''}
            onClick={() => {
              setSelected(null);
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
          累计数量按当前筛选统计；盘盈计入入库、盘亏计入出库。当前库存始终取全部流水；不同库存品编号和单位分开显示。
        </p>
      )}
      <TableRegion label={view === 'summary' ? '按产品汇总表格' : '出入库明细表格'}>
        {view === 'details' ? (
          <table className="op-flow-table">
            <thead>
              <tr>
                <th>业务日期</th>
                <th>产品</th>
                <th>类型</th>
                <th className="numeric">数量</th>
                <th className="numeric">变动后</th>
                <th>关联单据</th>
                <th>操作人</th>
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
                    if (!(e.target as HTMLElement).closest('a,button')) setSelected(m);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target === e.currentTarget) setSelected(m);
                  }}
                >
                  <td className="record-date">{m.date}</td>
                  <td className="cell-wrap" title={m.itemName}>
                    {m.itemName}
                    {m.revisionCount > 0 && <span className="sub"> 已修订</span>}
                  </td>
                  <td>
                    <StatusBadge status={movementType(m)} />
                  </td>
                  <td
                    className={
                      'numeric ' + (m.direction === '-' ? 'movement-negative' : 'movement-positive')
                    }
                  >
                    {m.direction}
                    {m.delta} {m.unit}
                  </td>
                  <td className="numeric">
                    {m.after} {m.unit}
                  </td>
                  <td className="cell-wrap">
                    <MovementSource m={m} />
                  </td>
                  <td className="cell-wrap">{m.actor_name}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      title="暂无符合条件的出入库明细"
                      description="可切换全部日期查询历史记录。"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="movement-summary-table">
            <thead>
              <tr>
                <th>产品名称 / 库存品</th>
                <th>规格型号</th>
                <th>仓库</th>
                <th>单位</th>
                <th className="numeric">累计入库</th>
                <th className="numeric">累计出库</th>
                <th className="numeric">当前库存</th>
              </tr>
            </thead>
            <tbody>
              {summary.slice((page - 1) * pageSize, page * pageSize).map((g) => (
                <tr key={g.itemId}>
                  <td className="cell-wrap">
                    {g.name}
                    <span className="sub">
                      {' '}
                      #{g.itemId}
                      {g.archived ? ' · 已归档' : ''}
                    </span>
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
              {!summary.length && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      title="当前筛选没有可汇总的库存品"
                      description="调整日期、类型或关键词后重试。"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </TableRegion>
      <Pagination
        page={page}
        total={view === 'summary' ? summary.length : filteredRecords}
        pageSize={pageSize}
        onChange={onPage}
      />
      {selected && view === 'details' && (
        <DetailPanel
          title={selected.itemName}
          status={<StatusBadge status={movementType(selected)} />}
          close={() => setSelected(null)}
          previous={() => step(-1)}
          next={() => step(1)}
        >
          <dl className="record-detail-grid">
            {(
              [
                ['业务日期', selected.date],
                ['记录时间', new Date(selected.created_at).toLocaleString('zh-CN')],
                [
                  '数量',
                  selected.direction + selected.delta + ' ' + selected.unit,
                ],
                ['变动前 → 后', selected.before + ' → ' + selected.after + ' ' + selected.unit],
                ['仓库', selected.kind === 'raw' ? '原材料' : '成品'],
                ['库存品编号', '#' + selected.item_id],
                ['规格型号', selected.itemSpecification || '待补充'],
                ['材质 / 楞型', [selected.material, selected.flute].filter(Boolean).join(' / ')],
                ['操作人', selected.actor_name],
                ['备注', selected.notes],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || '—'}</dd>
              </div>
            ))}
            <div>
              <dt>关联单据</dt>
              <dd>
                <MovementSource m={selected} />
              </dd>
            </div>
          </dl>
          {selected.revisionCount > 0 && (
            <MovementRevisions id={selected.id} count={selected.revisionCount} />
          )}
        </DetailPanel>
      )}
    </section>
  );
}
