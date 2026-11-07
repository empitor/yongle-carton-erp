import { useEffect, useRef, useState, type ReactNode } from 'react';
import { compareRecords, type RecordSort } from '../shared/record-sort';
import { formatDimensions } from '../shared/product-details';
import { Trash2, Pencil, ArchiveRestore } from 'lucide-react';
import { useAuthState, managementRequest } from './session';
import DetailPanel from './ui/DetailPanel';
import MoreMenu from './ui/MoreMenu';
import Chain from './ui/Chain';
import { BusinessDocumentButton } from './BusinessExport';
import PermanentDeleteDialog from './PermanentDeleteDialog';
import RecordDetails from './RecordDetails';
import { TableRegion, EmptyState, Pagination } from './ui/ListLayout';
import StatusBadge from './StatusBadge';
import ReceiptCorrectionDialog from './ReceiptCorrectionDialog';
import RecordContextDialog from './RecordContext';
import { displayAmount } from '../shared/display-amount';
import { orderDisplayStatus, today } from '../shared/domain';
import { formatStockSize, quantityString, type RecordEntity } from '../shared/operations';
type Entity = RecordEntity;
export const PAGE_SIZE = 50;
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
  paging,
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
  /** 提供时由服务端分页和排序，rows 只是当前页。 */
  paging?: {
    page: number;
    total: number;
    onPage: (page: number) => void;
    sort: RecordSort;
    onSort: (sort: RecordSort) => void;
  };
}) {
  const session = useAuthState(),
    superMode = !!session?.actor?.superAdminMode;
  const canEdit =
    !!session?.actor && (superMode || session.actor.permissions.includes('business:edit'));
  const [view, setView] = useState<any>(null),
    [correction, setCorrection] = useState<any>(null),
    [contextId, setContextId] = useState<number | null>(null),
    [permanent, setPermanent] = useState<any[] | null>(null);
  const [localSort, setLocalSort] = useState<RecordSort>('recent');
  const sort = paging?.sort ?? localSort;
  const sortedRows = paging ? rows : [...rows].sort(compareRecords(sort));
  const [selected, setSelected] = useState<number[]>([]),
    [localPage, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const page = paging?.page ?? localPage,
    filteredTotal = paging?.total ?? rows.length;
  // 面板切到页边时先翻页，新一页到达后再选中首行或末行。
  const pendingEdge = useRef<'first' | 'last' | null>(null);
  const routeHash = typeof location === 'undefined' ? '' : location.hash;
  useEffect(() => {
    const params = new URLSearchParams(routeHash.split('?')[1] || '');
    const id = params.get(entity === 'orders' ? 'order' : 'record');
    if (!id || !/^\d+$/.test(id) || !['orders', 'purchases'].includes(entity)) return;
    let active = true;
    const request =
      entity === 'orders'
        ? managementRequest('/orders/' + id)
        : managementRequest('/purchases/' + id);
    request
      .then((row) => {
        if (active) {
          if (row) setView(row);
          else setMessage('记录不存在或当前账号不可查看。');
        }
      })
      .catch((e) => active && setMessage(e.message));
    return () => {
      active = false;
    };
  }, [entity, routeHash]);
  useEffect(() => {
    setSelected([]);
    setPage(1);
    setMessage('');
    setView(null);

    setPermanent(null);
  }, [entity, archived, search, allRecords, filterKey]);
  useEffect(() => {
    setSelected((s) => s.filter((id) => rows.some((r) => r.id === id)));
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(rows.length / PAGE_SIZE))));
  }, [rows.map((r) => r.id).join(',')]);
  // 单据被生产、送货或确认改变后，面板按主键重读；这张单可能已不在当前筛选结果里。
  useEffect(() => {
    if (!view?.id || !['orders', 'purchases'].includes(entity)) return;
    const refresh = () =>
      void managementRequest('/' + entity + '/' + view.id)
        .then((fresh: any) => setView((v: any) => (v?.id === fresh.id ? fresh : v)))
        .catch(() => {});
    window.addEventListener('erp-business-changed', refresh);
    return () => window.removeEventListener('erp-business-changed', refresh);
  }, [view?.id, entity]);
  useEffect(() => {
    if (pendingEdge.current && rows.length) {
      setView(pendingEdge.current === 'first' ? rows[0] : rows[rows.length - 1]);
      pendingEdge.current = null;
      return;
    }
    setView((current: any) => (current ? rows.find((r) => r.id === current.id) || current : null));
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
  const rowKey = (row: any, text: string) => (
    <button className="row-key" aria-label={'查看 ' + text} onClick={() => setView(row)}>
      {text}
    </button>
  );
  const money = (c: number) =>
    (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isArchived = (row: any) => row.archived ?? archived;
  const correct = (row: any, receipt: any) => {
    setView(null);
    setCorrection({ purchase: row, receipt });
  };
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

  const pageRows = paging ? rows : sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const stepView = (delta: number) => {
    const index = sortedRows.findIndex((r) => r.id === view?.id),
      next = sortedRows[index + delta];
    if (next) {
      setView(next);
      if (!paging) setPage(Math.floor((index + delta) / PAGE_SIZE) + 1);
      return;
    }
    if (!paging || index < 0) return;
    const target = page + delta;
    if (target < 1 || target > Math.ceil(filteredTotal / PAGE_SIZE)) return;
    pendingEdge.current = delta > 0 ? 'first' : 'last';
    paging.onPage(target);
  };
  const panelActions = (row: any) => (
    <>
      {canEdit && (!isArchived(row) || superMode) && (
        <button
          onClick={() => {
            edit(row);
            setView(null);
          }}
        >
          <Pencil size={14} />
          编辑
        </button>
      )}
      {entity === 'purchases' && (
        <BusinessDocumentButton
          kind="purchase"
          id={row.id}
          version={row.version}
          status={row.businessStatus}
        />
      )}
      {extraActions?.(row)}
      <MoreMenu label={'更多操作 ' + (row.number || row.name)}>
        <button
          disabled={!canEdit || busy}
          onClick={() =>
            void executeLifecycle({ action: isArchived(row) ? 'restore' : 'archive', rows: [row] })
          }
        >
          {isArchived(row) ? '恢复' : '归档'}
        </button>
        {session?.actor?.localAdministrator && (
          <button
            onClick={() => {
              setContextId(row.id);
              setView(null);
            }}
          >
            修改历史
          </button>
        )}
        <button
          className="danger-text"
          disabled={!session?.actor?.localAdministrator || busy}
          onClick={() => setPermanent([row])}
        >
          <Trash2 size={14} />
          删除
        </button>
      </MoreMenu>
    </>
  );
  return (
    <section className="panel business-records" data-entity={entity}>
      <div className="section-heading">
        <h2>
          <span className="sr-only">
            {
              {
                customers: '客户档案',
                products: '产品档案',
                orders: '订单台账',
                suppliers: '供应商档案',
                purchases: '采购单',
                stock_items: '库存台账',
              }[entity]
            }
          </span>
          <span className="record-title-count">
            共 {totalRecords ?? rows.length}{' '}
            {entity === 'customers' || entity === 'suppliers'
              ? '家'
              : entity === 'products'
                ? '款'
                : entity === 'orders' || entity === 'purchases'
                  ? '张'
                  : '项'}
          </span>
        </h2>
        {totalRecords !== undefined && totalRecords !== filteredTotal && (
          <span className="record-filter-count">筛选结果 {filteredTotal} 条</span>
        )}
        {entity !== 'orders' && !hideSearch && (
          <input
            aria-label="搜索档案"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索当前档案"
          />
        )}
        <div className="business-selection">
          <label className="list-sort-control">
            排序
            <select
              aria-label="业务列表排序"
              value={sort}
              onChange={(e) => {
                const next = e.target.value as RecordSort;
                if (paging) paging.onSort(next);
                else setLocalSort(next);
                setPage(1);
              }}
            >
              <option value="recent">最近创建</option>
              <option value="oldest">最早创建</option>
              <option value="name">名称 / 单号</option>
              {['orders', 'purchases'].includes(entity) && (
                <option value="due">交货日期由近到远</option>
              )}
            </select>
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
        </div>
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
              <th>
                <input
                  type="checkbox"
                  aria-label={(paging ? '全选当前页（' : '全选当前筛选结果（') + rows.length + '条）'}
                  title={(paging ? '全选当前页（' : '全选当前筛选结果（') + rows.length + '条）'}
                  checked={!!rows.length && rows.every((r) => selected.includes(r.id))}
                  onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
                />
              </th>
              {entity === 'purchases' ? (
                <>
                  <th>采购单</th>
                  <th>供应商</th>
                  <th>纸板</th>
                  <th className="num">已到 / 订购</th>
                  <th className="num">金额</th>
                  <th>预计到货</th>
                  <th>状态</th>
                  <th>关联订单</th>
                </>
              ) : entity === 'stock_items' ? (
                <>
                  <th>库存品</th>
                  <th>规格</th>
                  <th>楞型 / 配纸</th>
                  <th className="num">现存</th>
                  <th className="num" title="送货草稿和生产登记草稿将要用掉的数量">
                    已安排
                  </th>
                  <th className="num">可用</th>
                  <th className="num" title="已订货尚未到齐的数量">
                    在途
                  </th>
                  <th>单位</th>
                  <th>备注</th>
                </>
              ) : entity === 'orders' ? (
                <>
                  <th>单号</th>
                  <th>客户</th>
                  <th>产品</th>
                  <th className="num">数量</th>
                  <th className="num">金额</th>
                  <th>交期</th>
                  <th>状态</th>
                  <th>进度</th>
                </>
              ) : entity === 'customers' || entity === 'suppliers' ? (
                <>
                  <th>{entity === 'suppliers' ? '供应商' : '客户'}</th>
                  <th>联系人</th>
                  <th>电话</th>
                  <th>地址</th>
                  <th>备注</th>
                </>
              ) : (
                <>
                  <th>产品</th>
                  <th>尺寸</th>
                  <th>配纸 / 楞型</th>
                  <th>加工要求</th>
                  <th className="num">参考单价</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr
                key={row.id}
                tabIndex={0}
                className={'record-row' + (view?.id === row.id ? ' selected' : '')}
                aria-selected={view?.id === row.id}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('input,button,a')) setView(row);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) setView(row);
                }}
              >
                <td>{check(row.id)}</td>
                {entity === 'purchases' ? (
                  <>
                    <td className="record-no">{rowKey(row, row.number)}</td>
                    <td className="cell-wrap">{row.supplierName}</td>
                    <td className="cell-wrap" title={row.lines.map((l: any) => l.name).join('、')}>
                      {row.lines[0]?.name}
                      {row.lines.length > 1 && <span className="sub">+{row.lines.length - 1}</span>}
                    </td>
                    <td className="num">
                      {row.lines.length === 1
                        ? row.lines[0].receivedQuantity +
                          ' / ' +
                          row.lines[0].quantity +
                          ' ' +
                          row.lines[0].unit
                        : row.arrivalProgress}
                    </td>
                    <td className="num">
                      {row.totalAmount === null ? '待定价' : displayAmount(row.totalAmount)}
                    </td>
                    <td
                      className={
                        row.expectedDate &&
                        row.expectedDate < today() &&
                        !['全部到货', '已取消'].includes(row.status)
                          ? 'overdue'
                          : ''
                      }
                    >
                      {row.expectedDate || '待确认'}
                    </td>
                    <td>
                      <StatusBadge status={row.status} />
                      {isArchived(row) && <span className="record-state">已归档</span>}
                    </td>
                    <td>{row.customerOrderNumber || '—'}</td>
                  </>
                ) : entity === 'stock_items' ? (
                  <>
                    <td className="cell-wrap">
                      {rowKey(row, row.name)}
                      {isArchived(row) && <span className="record-state">已归档</span>}
                    </td>
                    <td>{row.specification || formatStockSize(row)}</td>
                    <td>
                      {row.flute || '—'} / {row.material || '—'}
                    </td>
                    <td className="num op-quantity">{row.quantity}</td>
                    <td className="num">{row.reservedUnits ? row.reserved : '—'}</td>
                    <td className={'num' + (row.availableUnits < 0 ? ' overdue' : '')}>
                      {row.availableUnits < 0 ? '-' : ''}
                      {quantityString(Math.abs(row.availableUnits ?? row.balanceUnits ?? 0))}
                    </td>
                    <td className="num">{row.onOrderUnits ? row.onOrder : '—'}</td>
                    <td>{row.unit}</td>
                    <td className="cell-wrap">{row.notes || '—'}</td>
                  </>
                ) : entity === 'orders' ? (
                  <>
                    <td className="record-no">{rowKey(row, row.number)}</td>
                    <td className="cell-wrap">{row.customerName}</td>
                    <td
                      className="cell-wrap"
                      title={row.lines.map((l: any) => l.productName).join('、')}
                    >
                      {row.lines[0]?.productName}
                      {row.lines.length > 1 && <span className="sub">+{row.lines.length - 1}</span>}
                    </td>
                    <td className="num">
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
                    <td className="num">
                      {row.totalAmountExact ? displayAmount(row.totalAmountExact) : money(row.totalCents)}
                    </td>
                    <td
                      className={
                        row.deliveryDate < today() &&
                        !['已发货', '已取消', '草稿'].includes(row.status)
                          ? 'overdue'
                          : ''
                      }
                    >
                      {row.deliveryDate}
                    </td>
                    <td>
                      <StatusBadge status={orderDisplayStatus(row)} />
                      {isArchived(row) && <span className="record-state">已归档</span>}
                    </td>
                    <td>
                      <Chain order={row} />
                    </td>
                  </>
                ) : entity === 'customers' || entity === 'suppliers' ? (
                  <>
                    <td className="cell-wrap">
                      {rowKey(row, row.name)}
                      {isArchived(row) && <span className="record-state">已停用</span>}
                    </td>
                    <td>{row.contact || '—'}</td>
                    <td>{row.phone || '—'}</td>
                    <td className="cell-wrap">{row.address || '—'}</td>
                    <td className="cell-wrap">{row.notes || '—'}</td>
                  </>
                ) : (
                  <>
                    <td className="cell-wrap">
                      {rowKey(row, row.name)}
                      {isArchived(row) && <span className="record-state">已停用</span>}
                    </td>
                    <td>{formatDimensions(row)}</td>
                    <td>
                      {row.material || '—'} / {row.flute || '—'}
                    </td>
                    <td className="cell-wrap">{row.requirements || '—'}</td>
                    <td className="num">{row.priceExact || money(row.priceCents)}</td>
                  </>
                )}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10}>
                  <EmptyState />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableRegion>
      {!!selected.length && (
        <div className="batch-bar">
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
        </div>
      )}
      <Pagination
        page={page}
        total={filteredTotal}
        pageSize={PAGE_SIZE}
        onChange={paging ? paging.onPage : setPage}
      />
      {contextId !== null && (
        <RecordContextDialog module={entity} id={contextId} close={() => setContextId(null)} />
      )}
      {view && (
        <DetailPanel
          title={view.number || view.name}
          status={
            view.status || view.businessStatus ? (
              <StatusBadge
                status={entity === 'orders' ? orderDisplayStatus(view) : view.status || view.businessStatus}
              />
            ) : undefined
          }
          summary={entity === 'orders' ? <Chain order={view} large /> : undefined}
          actions={panelActions(view)}
          close={() => setView(null)}
          previous={() => stepView(-1)}
          next={() => stepView(1)}
        >
          <RecordDetails
            entity={entity}
            row={view}
            correctReceipt={canEdit ? (receipt) => correct(view, receipt) : undefined}
          />
        </DetailPanel>
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
      {correction && (
        <ReceiptCorrectionDialog
          {...correction}
          close={() => setCorrection(null)}
          done={(result) => {
            setCorrection(null);
            changed(result.summary || '到货更正已核验。');
          }}
        />
      )}
    </section>
  );
}
