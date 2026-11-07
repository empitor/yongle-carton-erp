import { useEffect, useState } from 'react';
import { Plus, FileUp, RefreshCw } from 'lucide-react';
import { managementRequest, useAuthState } from './session';
import { PageHeading, Pagination } from './ui/ListLayout';
import DateSchedule from './DateSchedule';
import FlowPage from './FlowPage';
import DetailPanel from './ui/DetailPanel';
import FinanceRelated from './finance/FinanceRelated';
import ReadyToShip from './ReadyToShip';
import StatusBadge from './StatusBadge';
import { ArrivalRecordLines } from './ArrivalRecordLines';
import { ReceiptHistory } from './FulfillmentDetails';
import ReceiptCorrectionDialog from './ReceiptCorrectionDialog';
import { today, dateSchema } from '../shared/domain';
import { formatStockSize } from '../shared/operations';
import BusinessExport from './BusinessExport';
const RECORD_PAGE_SIZE = 50;
export default function WarehouseRecords({ kind }: { kind: 'arrival' | 'delivery' }) {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const params = new URLSearchParams(location.hash.split('?')[1] || ''),
    focus = params.get('receipt') || (params.get('doc') ? 'flow-' + params.get('doc') : '');
  const [date, setDate] = useState(
      dateSchema.safeParse(params.get('date')).success ? params.get('date')! : today(),
    ),
    [data, setData] = useState<any>({ records: [], summary: {}, counts: {} }),
    [purchases, setPurchases] = useState<any[]>([]),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [q, setQ] = useState(''),
    [state, setState] = useState(params.get('state') || ''),
    [allDates, setAllDates] = useState(params.get('scope') === 'all'),
    [selectedKey, setSelectedKey] = useState(focus),
    [launch, setLaunch] = useState<any>(
      params.get('createArrival') ? { purchase: params.get('purchase') || '' } : null,
    ),
    [correction, setCorrection] = useState<any>(null),
    [page, setPage] = useState(1);
  const name = kind === 'arrival' ? '到货' : '送货';
  useEffect(() => {
    const change = () => setRevision((v) => v + 1);
    window.addEventListener('erp-business-changed', change);
    return () => window.removeEventListener('erp-business-changed', change);
  }, []);
  useEffect(() => {
    if (!auth?.actor) {
      setData({ records: [], summary: {}, counts: {} });
      setPurchases([]);
      return;
    }
    let active = true;
    setBusy(true);
    setError('');
    Promise.all([
      managementRequest<any>(
        '/flow/daily?kind=' + kind + '&date=' + date + (allDates ? '&scope=all' : ''),
      ),
      kind === 'arrival' ? managementRequest<any[]>('/purchases') : Promise.resolve([]),
      focus
        ? kind === 'arrival'
          ? Promise.all([
              managementRequest<any[]>('/flow/arrival-records'),
              managementRequest<any[]>('/flow/arrival-plans'),
            ]).then(([records, plans]) => [
              ...records,
              ...plans.filter((p) => p.isPlan).map((p) => ({ ...p, id: 'flow-' + p.id })),
            ])
          : managementRequest<any[]>('/flow?kind=delivery')
        : Promise.resolve([]),
    ])
      .then(([d, p, history]) => {
        if (!active) return;
        setData(d);
        setPurchases(p);
        const found = history.find((r: any) => String(r.id) === focus || 'flow-' + r.id === focus);
        if (found) {
          const actual = found.status === 'confirmed' ? found.date : null,
            target = actual || found.plannedDate || found.date;
          if (target !== date) {
            setDate(target);
            return;
          }
          if (!d.records.some((r: any) => String(r.id) === String(found.id)))
            setData({ ...d, records: [found, ...d.records] });
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [kind, date, revision, auth?.actor?.id, focus, allDates]);
  const changeDate = (d: string) => {
    setAllDates(false);
    setDate(d);
    setPage(1);
    const p = new URLSearchParams(location.hash.split('?')[1] || '');
    p.set('date', d);
    p.delete('receipt');
    p.delete('doc');
    history.replaceState(null, '', '#warehouse?' + p.toString());
  };
  const filtered = data.records.filter(
    (r: any) =>
      (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())) &&
      (!state ||
        (state === 'pending' ? r.pending : state === 'completed' ? r.completed : r.cancelled)) &&
      (!params.get('purchase') ||
        r.lines.some(
          (l: any) =>
            Number(
              l.purchaseId ||
                purchases.find((p) => p.lines.some((x: any) => x.id === l.purchaseLineId))?.id,
            ) === Number(params.get('purchase')),
        )),
  );
  const detail = (r: any) => setLaunch({ doc: String(r.flowId || r.id).replace('flow-', '') });
  useEffect(
    () => setPage((p) => Math.min(p, Math.max(1, Math.ceil(filtered.length / RECORD_PAGE_SIZE)))),
    [filtered.length],
  );
  const act = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const purchaseOf = (l: any) =>
    purchases.find(
      (p) => l.purchaseId === p.id || p.lines.some((x: any) => x.id === l.purchaseLineId),
    );
  const statusOf = (r: any) =>
    r.status === 'reversed'
      ? '已冲销'
      : r.cancelled
        ? '已取消'
        : r.pending
          ? '待' + name
          : r.status === 'confirmed'
            ? '已完成' + name
            : '历史记录';
  const selected =
    filtered.find((r: any) => String(r.id) === selectedKey) ||
    data.records.find((r: any) => String(r.id) === selectedKey);
  const selectedPurchase =
    kind === 'arrival' && selected
      ? selected.lines.map(purchaseOf).find(Boolean) || null
      : null;
  const step = (delta: number) => {
    const index = filtered.findIndex((r: any) => String(r.id) === selectedKey),
      next = filtered[index + delta];
    if (next) setSelectedKey(String(next.id));
  };
  const panelActions = (r: any) => {
    const planId = r.flowId || Number(String(r.id).replace('flow-', ''));
    return (
      <>
        {kind === 'arrival' && r.isPlan && r.pending && (
          <button
            className="primary"
            disabled={!canEdit}
            onClick={() => setLaunch({ receivePlan: String(planId) })}
          >
            登记实际到货
          </button>
        )}
        {!!planId && (
          <button onClick={() => detail(r)}>
            {r.pending ? (r.isPlan ? '修改计划' : '修改 / 确认' + name) : '查看正式记录'}
          </button>
        )}
        {kind === 'arrival' && selectedPurchase && r.effective && (
          <button
            disabled={!canEdit}
            onClick={() =>
              setCorrection({
                purchase: selectedPurchase,
                receipt: selectedPurchase.receipts.find((x: any) => x.id === r.id),
              })
            }
          >
            更正到货单
          </button>
        )}
        {r.pending && (
          <button
            disabled={!canEdit || busy}
            onClick={() =>
              void act(async () => {
                await managementRequest('/flow/' + planId + '/cancel', {
                  version: r.version,
                  reason: '取消未执行业务计划',
                  acknowledged: true,
                });
              })
            }
          >
            取消计划
          </button>
        )}
      </>
    );
  };
  return (
    <div className="arrival-warehouse">
      <PageHeading
        title={name}
        meta={
          <div className="list-summary" aria-label={'每日' + name + '汇总'}>
            <div>
              <span>计划</span>
              <strong>{data.summary.planned || 0}</strong>
            </div>
            <div>
              <span>已完成</span>
              <strong>{data.summary.completed || 0}</strong>
            </div>
            <div>
              <span>待{name}</span>
              <strong>{data.summary.pending || 0}</strong>
            </div>
          </div>
        }
        actions={
        <>
          <button onClick={() => setRevision((v) => v + 1)} disabled={busy}>
            <RefreshCw size={15} aria-hidden="true" />
            <span className="sr-only">刷新</span>
          </button>
          {kind === 'arrival' && (
            <button disabled={!canEdit} onClick={() => setLaunch({ ai: '1' })}>
              <FileUp size={15} />
              AI收货
            </button>
          )}
          <button
            disabled={!canEdit}
            onClick={() =>
              setLaunch(
                kind === 'arrival'
                  ? { purchase: params.get('purchase') || '' }
                  : { plannedDate: date },
              )
            }
          >
            登记实际{name}
          </button>
          <button
            className="primary"
            disabled={!canEdit}
            onClick={() =>
              setLaunch(
                kind === 'arrival'
                  ? { isPlan: '1', plannedDate: date, purchase: params.get('purchase') || '' }
                  : { plannedDate: date },
              )
            }
          >
            <Plus size={15} />
            新建{name}计划
          </button>
        </>
        }
      />
      <DateSchedule value={date} onChange={changeDate} label={name} counts={data.counts} />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="arrival-toolbar warehouse-record-filters">
        <button className={!allDates ? 'selected' : ''} onClick={() => setAllDates(false)}>
          当日记录
        </button>
        <button className={allDates ? 'selected' : ''} onClick={() => setAllDates(true)}>
          全部日期
        </button>
        <input
          aria-label={'搜索' + name + '记录'}
          placeholder={
            '搜索单号、' + (kind === 'arrival' ? '供应商、采购' : '客户、销售') + '单或产品'
          }
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="业务记录状态"
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="pending">待{name}</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消 / 冲销</option>
        </select>
      </div>
      {kind === 'delivery' && canEdit && (
        <ReadyToShip
          revision={revision}
          create={(customerId, lines) =>
            setLaunch({ lines: JSON.stringify({ customerId, lines }), plannedDate: date })
          }
        />
      )}
      <section className="panel business-records">
        <div className="table-wrap unified-table-region" tabIndex={0}>
          <table className="flow-table arrival-table">
            <thead>
              <tr>
                {[
                  '单号',
                  kind === 'arrival' ? '供应商' : '客户',
                  kind === 'arrival' ? '采购单' : '订单',
                  '本批内容',
                  '计划',
                  '实际',
                  '状态',
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered
                .slice((page - 1) * RECORD_PAGE_SIZE, page * RECORD_PAGE_SIZE)
                .map((r: any) => {
                  const key = String(r.id),
                    actual = r.status === 'confirmed',
                    numbers = [
                      ...new Set(
                        r.lines
                          .map((l: any) =>
                            kind === 'arrival'
                              ? l.purchaseNumber || purchaseOf(l)?.number
                              : l.orderNumber,
                          )
                          .filter(Boolean),
                      ),
                    ] as string[],
                    first = r.lines[0];
                  return (
                    <tr
                      key={key}
                      tabIndex={0}
                      className={'record-row' + (selectedKey === key ? ' selected' : '')}
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest('input,button,a')) setSelectedKey(key);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.target === e.currentTarget) setSelectedKey(key);
                      }}
                    >
                      <td className="record-no">
                        <button
                          className="row-key"
                          aria-label={'查看 ' + r.number}
                          onClick={() => setSelectedKey(key)}
                        >
                          {r.number}
                        </button>
                      </td>
                      <td className="cell-wrap">{r.supplierName || r.customerName}</td>
                      <td>
                        {numbers[0] && (
                          <a
                            href={
                              '#' +
                              (kind === 'arrival' ? 'purchases' : 'orders') +
                              '?q=' +
                              encodeURIComponent(numbers[0])
                            }
                          >
                            {numbers[0]}
                          </a>
                        )}
                        {numbers.length > 1 && <span className="sub">+{numbers.length - 1}</span>}
                      </td>
                      <td className="cell-wrap">
                        {first && (
                          <>
                            {first.item?.name || first.productName}：{first.quantity}{' '}
                            {first.item?.unit || first.unit}
                          </>
                        )}
                        {r.lines.length > 1 && <span className="sub">+{r.lines.length - 1}</span>}
                      </td>
                      <td>
                        {r.plannedDate || '—'}
                        {r.plannedTime && <span className="sub">{r.plannedTime}</span>}
                      </td>
                      <td>{r.actualDate || (!r.isPlan && actual ? r.date : '—')}</td>
                      <td>
                        <StatusBadge status={statusOf(r)} />
                      </td>
                    </tr>
                  );
                })}
              {!filtered.length && (
                <tr>
                  <td colSpan={8}>
                    {busy ? '正在读取…' : '当前日期暂无记录，可新建计划或登记实际业务。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          total={filtered.length}
          pageSize={RECORD_PAGE_SIZE}
          onChange={setPage}
        />
      </section>
      {selected && (
        <DetailPanel
          title={selected.number}
          status={<StatusBadge status={statusOf(selected)} />}
          actions={panelActions(selected)}
          close={() => setSelectedKey('')}
          previous={() => step(-1)}
          next={() => step(1)}
        >
          {kind === 'arrival' ? (
            <>
              {(selected.inspectionStatus || selected.inventoryStatus) && (
                <p className="sub">
                  {selected.inspectionStatus} · {selected.inventoryStatus}
                </p>
              )}
              <ArrivalRecordLines record={selected} />
              {selectedPurchase && (
                <details>
                  <summary>全部到货批次及更正历史</summary>
                  <ReceiptHistory
                    row={selectedPurchase}
                    correct={
                      canEdit
                        ? (receipt) => setCorrection({ purchase: selectedPurchase, receipt })
                        : undefined
                    }
                  />
                </details>
              )}
            </>
          ) : (
            <>
              <DeliveryRecordLines record={selected} />
              <FinanceRelated kind="delivery" id={selected.id} />
              <BusinessExport
                kind="delivery"
                id={selected.id}
                version={selected.version}
                status={selected.status}
              />
            </>
          )}
        </DetailPanel>
      )}
      {launch && (
        <FlowPage
          key={JSON.stringify(launch)}
          mode={kind}
          dialogOnly
          launch={launch}
          onClose={() => {
            setLaunch(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
      {correction?.receipt && (
        <ReceiptCorrectionDialog
          {...correction}
          close={() => setCorrection(null)}
          done={() => {
            setCorrection(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
function DeliveryRecordLines({ record }: { record: any }) {
  return (
    <div className="table-wrap fulfillment-lines">
      <table>
        <thead>
          <tr>
            {[
              '销售订单',
              '产品名称 / 规格尺寸',
              '单位',
              '订单订购',
              '本批送货',
              '累计已送',
              '剩余待送',
              '状态',
              '库存流水',
            ].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {record.lines.map((l: any, i: number) => (
            <tr key={i}>
              <td>
                <a href={'#orders?q=' + encodeURIComponent(l.orderNumber)}>{l.orderNumber}</a>
              </td>
              <td>
                {l.productName}
                <span className="sub">{l.specification}</span>
                {(l.length != null || l.width != null) && (
                  <span className="sub">{formatStockSize(l)}</span>
                )}
              </td>
              <td>{l.unit}</td>
              <td>{l.orderedQuantity ?? '待核对'}</td>
              <td>{l.quantity}</td>
              <td>{l.shippedQuantity ?? '待核对'}</td>
              <td>{l.remainingQuantity ?? '待核对'}</td>
              <td>{l.shippingStatus}</td>
              <td>
                {l.movements?.length ? (
                  <details>
                    <summary>{l.movements.length}笔</summary>
                    {l.movements.map((m: any) => (
                      <p key={m.id}>
                        {m.date} · {m.delta_units / 1000} {l.unit}
                        <span className="sub">{m.id}</span>
                      </p>
                    ))}
                  </details>
                ) : (
                  '尚无出库流水'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
