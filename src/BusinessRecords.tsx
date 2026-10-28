import { useEffect, useState, type ReactNode } from 'react';
import { precisionTotal } from '../shared/precision';
import { formatDimensions } from '../shared/product-details';
import { Trash2, Eye, Pencil, ArchiveRestore } from 'lucide-react';
import { useAuthState, managementRequest } from './session';
import ManagementDialog from './ManagementDialog';
import PermanentDeleteDialog from './PermanentDeleteDialog';
import RecordDetails from './RecordDetails';
import { TableRegion, EmptyState, Pagination } from './ui/ListLayout';
import StatusBadge from './StatusBadge';
import RecordContextDialog from './RecordContext';
import { displayAmount } from '../shared/display-amount';
import { formatStockSize, type RecordEntity } from '../shared/operations';
type Entity = RecordEntity;
export default function BusinessRecords({
  entity,
  rows,
  archived,
  setArchived,
  edit,
  changed,
  search,
  setSearch,
  allRecords = false,
  setAllRecords,
  recycle = false,
  extraActions,
  hideSearch = false,
  filterKey = '',
  totalRecords,
}: {
  entity: Entity;
  rows: any[];
  archived: boolean;
  setArchived: (v: boolean) => void;
  edit: (v: any) => void;
  changed: (message?: string) => void;
  search: string;
  setSearch: (v: string) => void;
  allRecords?: boolean;
  setAllRecords?: (v: boolean) => void;
  recycle?: boolean;
  extraActions?: (row: any) => ReactNode;
  hideSearch?: boolean;
  filterKey?: string;
  totalRecords?: number;
}) {
  const session = useAuthState(),
    superMode = !!session?.actor?.superAdminMode;
  const canEdit =
    !!session?.actor && (superMode || session.actor.permissions.includes('business:edit'));
  const [view, setView] = useState<any>(null),
    [contextId, setContextId] = useState<number | null>(null),
    [permanent, setPermanent] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    setSelected([]);
    setPage(1);
    setMessage('');
    setView(null);

    setPermanent(null);
  }, [entity, archived, search, allRecords, filterKey]);
  useEffect(() => {
    setSelected((s) => s.filter((id) => rows.some((r) => r.id === id)));
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(rows.length / 12))));
  }, [rows.map((r) => r.id).join(',')]);
  useEffect(() => {
    setView((current: any) => (current ? rows.find((r) => r.id === current.id) || null : null));
  }, [rows]);
  const check = (id: number) => (
    <input
      type="checkbox"
      aria-label={'选择记录' + id}
      checked={selected.includes(id)}
      onChange={(e) =>
        setSelected((s) => (e.target.checked ? [...s, id] : s.filter((x) => x !== id)))
      }
    />
  );
  const money = (c: number) =>
    (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isArchived = (row: any) => row.archived ?? archived;
  async function executeLifecycle(selection: { action: 'archive' | 'restore'; rows: any[] }) {
    setBusy(true);
    try {
      const result = await managementRequest('/' + entity + '/batch', {
        action: selection.action,
        acknowledged: true,
        items: selection.rows.map((r) => ({ id: r.id, version: r.version })),
      });
      const failed = result.results.filter((r: any) => !r.success);
      const summary =
        '成功 ' +
        (result.results.length - failed.length) +
        ' 条' +
        (failed.length
          ? '；' + failed.map((r: any) => '编号' + r.id + '：' + r.message).join('；')
          : '');
      setMessage(summary);
      setSelected(failed.map((r: any) => r.id));

      window.dispatchEvent(new Event('erp-business-changed'));
      changed(summary);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const actions = (row: any) => (
    <div className="record-actions">
      <div className="record-actions-main">
        <button onClick={() => setView(row)}>
          <Eye size={14} />
          查看
        </button>
        <button disabled={!canEdit || (isArchived(row) && !superMode)} onClick={() => edit(row)}>
          <Pencil size={14} />
          编辑
        </button>
        <button
          disabled={!canEdit || busy}
          onClick={() =>
            void executeLifecycle({ action: isArchived(row) ? 'restore' : 'archive', rows: [row] })
          }
        >
          {isArchived(row) ? '恢复' : '归档'}
        </button>
        <button
          className="danger"
          disabled={!session?.actor?.localAdministrator || busy}
          onClick={() => setPermanent([row])}
        >
          <Trash2 size={14} />
          删除
        </button>
      </div>
      {extraActions && <div className="record-extra-actions">{extraActions(row)}</div>}
      {session?.actor?.localAdministrator && (
        <button onClick={() => setContextId(row.id)}>关联记录 / 修改历史</button>
      )}
    </div>
  );
  return (
    <section className="panel business-records" data-entity={entity}>
      <div className="section-heading">
        <h2>
          {
            {
              customers: '客户档案',
              products: '产品档案',
              orders: '订单台账',
              suppliers: '供应商档案',
              purchases: '采购订货',
              stock_items: '库存台账',
            }[entity]
          }{' '}
          <span className="record-title-count">
            （共 {totalRecords ?? rows.length}{' '}
            {entity === 'customers' || entity === 'suppliers'
              ? '家'
              : entity === 'products'
                ? '款'
                : entity === 'orders' || entity === 'purchases'
                  ? '张'
                  : '项'}
            ）
          </span>
        </h2>
        {totalRecords !== undefined && totalRecords !== rows.length && (
          <span className="record-filter-count">筛选结果 {rows.length} 条</span>
        )}
        {entity !== 'orders' && !hideSearch && (
          <input
            aria-label="搜索档案"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索当前档案"
          />
        )}
      </div>
      <div className="business-selection">
        <label>
          <input
            type="checkbox"
            checked={!!rows.length && rows.every((r) => selected.includes(r.id))}
            onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
          />
          全选当前筛选结果（{rows.length}条）
        </label>
        {!recycle && (
          <div className="record-view-tabs" aria-label="记录范围">
            <button
              className={!archived && !allRecords ? 'selected' : ''}
              onClick={() => {
                setAllRecords?.(false);
                setArchived(false);
              }}
            >
              正常记录
            </button>
            <button
              className={archived && !allRecords ? 'selected' : ''}
              onClick={() => {
                setAllRecords?.(false);
                setArchived(true);
              }}
            >
              {entity === 'orders' || entity === 'purchases' ? '归档记录' : '已归档 / 停用'}
            </button>
            {superMode && setAllRecords && (
              <button
                className={allRecords ? 'selected' : ''}
                onClick={() => {
                  setArchived(false);
                  setAllRecords(true);
                }}
              >
                全部记录
              </button>
            )}
          </div>
        )}
        {!!selected.length && (
          <>
            <b>已选 {selected.length} 条</b>
            <button
              className={archived ? '' : 'danger'}
              disabled={!canEdit}
              onClick={() =>
                void executeLifecycle({
                  action: archived ? 'restore' : 'archive',
                  rows: rows.filter((r) => selected.includes(r.id)),
                })
              }
            >
              <Trash2 size={14} />
              {archived ? '批量恢复' : '批量归档'}
            </button>
            {allRecords && (
              <button
                disabled={!canEdit}
                onClick={() =>
                  void executeLifecycle({
                    action: 'restore',
                    rows: rows.filter((r) => selected.includes(r.id)),
                  })
                }
              >
                <ArchiveRestore size={14} />
                批量恢复
              </button>
            )}
            {superMode && (
              <button
                className="danger permanent-batch"
                onClick={() => setPermanent(rows.filter((r) => selected.includes(r.id)))}
              >
                <Trash2 size={14} />
                批量删除
              </button>
            )}
            <button onClick={() => setSelected([])}>清除选择</button>
          </>
        )}
      </div>
      {message && (
        <div className="business-result" role="status">
          {message}
        </div>
      )}
      <TableRegion>
        <table>
          <thead>
            <tr>
              <th>选择</th>
              {entity === 'purchases' ? (
                <>
                  <th>采购单 / 供应商</th>
                  <th>纸板明细</th>
                  <th>金额 / 元</th>
                  <th>预计到货</th>
                  <th>状态 / 关联订单</th>
                </>
              ) : entity === 'stock_items' ? (
                <>
                  <th>库存品</th>
                  <th>规格 / 配纸</th>
                  <th>库存数量</th>
                  <th>数量单位</th>
                  <th>备注</th>
                </>
              ) : entity === 'orders' ? (
                <>
                  <th>订单编号 / 客户</th>
                  <th>产品与明细</th>
                  <th>数量</th>
                  <th>金额/元</th>
                  <th>交货日期</th>
                  <th>订单状态</th>
                </>
              ) : entity === 'customers' || entity === 'suppliers' ? (
                <>
                  <th>{entity === 'suppliers' ? '供应商名称' : '客户名称'}</th>
                  <th>联系人</th>
                  <th>联系方式</th>
                  <th>地址</th>
                  <th>备注</th>
                </>
              ) : (
                <>
                  <th>产品名称</th>
                  <th>尺寸 / 单位</th>
                  <th>配纸 / 楞型</th>
                  <th>加工要求</th>
                  <th>参考单价/元</th>
                </>
              )}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((page - 1) * 12, page * 12).map((row) => (
              <tr key={row.id}>
                <td>{check(row.id)}</td>
                {entity === 'purchases' ? (
                  <>
                    <td>
                      <strong>{row.number}</strong>
                      <span className="sub">{row.supplierName}</span>
                      <span className="sub">采购日期 {row.orderDate}</span>
                    </td>
                    <td>
                      {row.lines.map((l: any) => (
                        <div key={l.id} className="op-line-summary">
                          <strong>{l.name}</strong>
                          <span className="sub">
                            {l.specification || formatStockSize(l)} · {l.flute || '楞型待补'} ·{' '}
                            {l.material || '配纸待补'}
                          </span>
                          <span className="sub">
                            订购 {l.quantity} {l.unit} / 已到 {l.receivedQuantity}；单价{' '}
                            {l.unitPrice ?? '待定'}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td>{row.totalAmount === null ? '待定价' : displayAmount(row.totalAmount)}</td>
                    <td>{row.expectedDate || '待确认'}</td>
                    <td>
                      <StatusBadge status={row.status} />
                      <span className="sub">{row.customerOrderNumber || '独立采购'}</span>
                      {isArchived(row) && <span className="record-state">已归档</span>}
                    </td>
                  </>
                ) : entity === 'stock_items' ? (
                  <>
                    <td>
                      <strong>{row.name}</strong>
                      <span className="sub">
                        {row.kind === 'raw' ? '外购瓦楞纸板' : '加工成品纸箱'}
                      </span>
                      {isArchived(row) && <span className="record-state">已归档</span>}
                    </td>
                    <td>
                      {row.specification || formatStockSize(row)}
                      <span className="sub">
                        {row.flute || '楞型待补'} / {row.material || '材质待补'}
                      </span>
                    </td>
                    <td className="op-quantity">{row.quantity}</td>
                    <td>{row.unit}</td>
                    <td>{row.notes || '—'}</td>
                  </>
                ) : entity === 'orders' ? (
                  <>
                    <td>
                      <strong>{row.number}</strong>
                      <span className="sub">{row.customerName}</span>
                      <span className="sub">下单 {row.orderDate}</span>
                      {row.externalPurchaseOrder && (
                        <span className="sub">采购单号：{row.externalPurchaseOrder}</span>
                      )}
                    </td>
                    <td>
                      <strong>{row.lines[0]?.productName}</strong>
                      <details className="order-full-lines">
                        <summary>展开全部 {row.lines.length} 项明细</summary>
                        <table>
                          <thead>
                            <tr>
                              <th>产品名称</th>
                              <th>规格型号</th>
                              <th>备注</th>
                              <th>数量</th>
                              <th>单位</th>
                              <th>单价/元</th>
                              <th>金额/元</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.lines.map((line: any, i: number) => (
                              <tr key={i}>
                                <td>{line.productName}</td>
                                <td>{line.specification}</td>
                                <td>{line.notes || '—'}</td>
                                <td>{line.quantity}</td>
                                <td>{line.unit || '只'}</td>
                                <td>{line.unitPriceExact ?? String(line.unitPriceCents / 100)}</td>
                                <td>{precisionTotal([line]).exact}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p>
                          税费：{row.taxRate || '未明确'} {row.taxMode || ''}；合同条件：
                          {row.terms || '无'}；整单备注：{row.notes || '无'}
                        </p>
                        {row.importSource && (
                          <p>
                            来源：{row.importSource.fileName}；导入人：{row.importSource.actorName}
                            ；时间：{new Date(row.importSource.at).toLocaleString('zh-CN')}
                          </p>
                        )}
                      </details>
                    </td>
                    <td>
                      {[
                        ...(row.lines.reduce(
                          (groups: Map<string, number>, l: any) =>
                            groups.set(
                              l.unit || '未注明单位',
                              (groups.get(l.unit || '未注明单位') || 0) + l.quantity,
                            ),
                          new Map<string, number>(),
                        ) as Map<string, number>),
                      ].map(([unit, quantity]) => (
                        <span className="order-unit-total" key={unit}>
                          {quantity.toLocaleString('zh-CN')} <small>{unit}</small>
                        </span>
                      ))}
                    </td>
                    <td>{row.totalAmountExact || money(row.totalCents)}</td>
                    <td>{row.deliveryDate}</td>
                    <td>
                      <StatusBadge
                        status={
                          row.lines?.some((l: any) => l.shippedQuantity > 0)
                            ? row.status === '已发货'
                              ? '已完成'
                              : '部分发货'
                            : row.status
                        }
                      />
                      {isArchived(row) && <span className="record-state">已归档</span>}
                    </td>
                  </>
                ) : entity === 'customers' || entity === 'suppliers' ? (
                  <>
                    <td>
                      {row.name}
                      {isArchived(row) && <span className="record-state">已停用</span>}
                    </td>
                    <td>{row.contact || '—'}</td>
                    <td>{row.phone || '—'}</td>
                    <td>{row.address || '—'}</td>
                    <td>{row.notes || '—'}</td>
                  </>
                ) : (
                  <>
                    <td>
                      {row.name}
                      {isArchived(row) && <span className="record-state">已停用</span>}
                    </td>
                    <td>{formatDimensions(row)}</td>
                    <td>
                      {row.material} / {row.flute}
                    </td>
                    <td>{row.requirements || '—'}</td>
                    <td>{row.priceExact || money(row.priceCents)}</td>
                  </>
                )}
                <td>{actions(row)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9}>
                  <EmptyState />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableRegion>
      <Pagination page={page} total={rows.length} pageSize={12} onChange={setPage} />
      {contextId !== null && (
        <RecordContextDialog module={entity} id={contextId} close={() => setContextId(null)} />
      )}
      {view && (
        <ManagementDialog title={'查看' + (view.number || view.name)} close={() => setView(null)}>
          <RecordDetails entity={entity} row={view} />
          <div className="management-dialog-actions">
            <button onClick={() => setView(null)}>关闭</button>
            {session?.actor?.localAdministrator && (
              <button
                onClick={() => {
                  setContextId(view.id);
                  setView(null);
                }}
              >
                关联记录 / 修改历史
              </button>
            )}
            {canEdit &&
              !isArchived(view) &&
              ((entity === 'orders' && !['草稿', '已取消'].includes(view.status)) ||
                (entity === 'stock_items' && view.kind === 'finished')) && (
                <button
                  className="secondary"
                  onClick={() => {
                    location.hash =
                      entity === 'orders'
                        ? 'warehouse?kind=finished&createDelivery=1&order=' + view.id
                        : 'warehouse?kind=finished&createDelivery=1&stock=' + view.id;
                    setView(null);
                  }}
                >
                  安排送货
                </button>
              )}
            {canEdit && (!isArchived(view) || superMode) && (
              <button
                className="primary"
                onClick={() => {
                  edit(view);
                  setView(null);
                }}
              >
                编辑此记录
              </button>
            )}
          </div>
        </ManagementDialog>
      )}
      {permanent && (
        <PermanentDeleteDialog
          entity={entity}
          rows={permanent}
          close={() => setPermanent(null)}
          done={(message) => {
            setMessage(message);
            setPermanent(null);
            setSelected([]);
            changed(message);
          }}
        />
      )}
    </section>
  );
}
