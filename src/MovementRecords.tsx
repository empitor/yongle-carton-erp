import { EmptyState, Pagination, TableRegion } from './ui/ListLayout';
import StatusBadge from './StatusBadge';
import { movementLabels, type movementActions } from '../shared/movement-filters';
import type { MovementSummary } from '../shared/business-metrics';
export default function MovementRecords({
  rows,
  summary,
  totalRecords,
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
  page: number;
  onPage: (page: number) => void;
  item: any;
  onClearItem: () => void;
  view: 'details' | 'summary';
  onView: (view: 'details' | 'summary') => void;
}) {
  const records = view === 'summary' ? summary : rows;
  return (
    <section className="panel business-records movement-records">
      <div className="section-heading">
        <div>
          <h2>出入库流水</h2>
          <span>
            筛选 {rows.length} 条 / 全部 {totalRecords} 条
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
            onClick={() => onView('summary')}
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
                {[
                  '业务日期 / 记录时间',
                  '产品名称 / 仓库',
                  '规格型号',
                  '出入库类型',
                  '数量 / 单位',
                  '关联单据',
                  '变动前 → 后',
                  '用途 / 备注',
                  '操作人员',
                ].map((t) => (
                  <th key={t}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice((page - 1) * 25, page * 25).map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.date}
                    <span className="sub">{new Date(m.created_at).toLocaleString('zh-CN')}</span>
                  </td>
                  <td>
                    <strong>{m.itemName}</strong>
                    <span className="sub">
                      {m.kind === 'raw' ? '原材料' : '成品'} · 库存品 #{m.item_id}
                    </span>
                  </td>
                  <td>
                    {m.itemSpecification || '待补充'}
                    <span className="sub">{[m.material, m.flute].filter(Boolean).join(' / ')}</span>
                  </td>
                  <td>
                    <StatusBadge
                      status={
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
                              : movementLabels[m.action as (typeof movementActions)[number]]
                      }
                    />
                  </td>
                  <td className={m.direction === '-' ? 'movement-negative' : 'movement-positive'}>
                    {m.direction}
                    {m.delta} {m.unit}
                  </td>
                  <td>
                    {m.purchaseNumber && <span>{m.purchaseNumber}</span>}
                    {m.flowNumber && (
                      <a
                        href={
                          m.flowKind === 'delivery'
                            ? '#warehouse?kind=finished&deliveries=1&doc=' + m.source_id
                            : '#' +
                              (m.flowKind === 'arrival' ? 'arrivals' : 'production') +
                              '?doc=' +
                              m.source_id
                        }
                      >
                        {m.flowNumber}
                      </a>
                    )}
                    {m.customerOrderNumber && <span className="sub">{m.customerOrderNumber}</span>}
                    {!m.flowNumber && !m.purchaseNumber && !m.customerOrderNumber
                      ? '未关联单据'
                      : null}
                  </td>
                  <td>
                    {m.before} → {m.after}
                    <span className="sub">{m.unit}</span>
                  </td>
                  <td>{m.notes || '—'}</td>
                  <td>{m.actor_name}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={9}>
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
                {[
                  '产品名称 / 库存品',
                  '规格型号',
                  '仓库',
                  '单位',
                  '累计入库',
                  '累计出库',
                  '当前库存',
                ].map((t) => (
                  <th key={t}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.slice((page - 1) * 25, page * 25).map((g) => (
                <tr key={g.itemId}>
                  <td>
                    <strong>{g.name}</strong>
                    <span className="sub">
                      库存品 #{g.itemId}
                      {g.archived ? ' · 已归档' : ''}
                    </span>
                  </td>
                  <td>{g.specification || '待补充'}</td>
                  <td>{g.kind === 'raw' ? '原材料' : '成品'}</td>
                  <td>{g.unit}</td>
                  <td className="movement-positive">{g.incoming}</td>
                  <td className="movement-negative">{g.outgoing}</td>
                  <td>
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
      <Pagination page={page} total={records.length} pageSize={25} onChange={onPage} />
    </section>
  );
}
