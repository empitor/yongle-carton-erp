import { useEffect } from 'react';
import { flowStatusLabel, sheetArea, purchaseLineAmount } from '../../shared/physical-flow';
import { formatStockSize } from '../../shared/operations';
import ProductMarks from '../marks/ProductMarks';
import { planDate } from '../../shared/schedule';

export function safeArea(l: any) {
  try {
    return sheetArea(l.item, l.quantity) || '待确认';
  } catch {
    return '待确认';
  }
}
export function safeAmount(l: any) {
  try {
    return (
      purchaseLineAmount({
        ...l.item,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceBasis: l.priceBasis,
      }) || '待确认'
    );
  } catch {
    return '待确认';
  }
}
export default function FlowDetails({ doc: d, data }: { doc: any; data: any }) {
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('erp-ai-record-context', {
        detail: {
          module: (
            {
              arrival: 'arrivals',
              task: 'production_tasks',
              production: 'production_records',
              delivery: 'deliveries',
            } as any
          )[d.kind],
          id: d.id,
          label: d.number,
        },
      }),
    );
  }, [d.kind, d.id]);
  return (
    <div
      className="flow-details"
      data-agent-module={
        (
          {
            arrival: 'arrivals',
            task: 'production_tasks',
            production: 'production_records',
            delivery: 'deliveries',
          } as any
        )[d.kind]
      }
      data-agent-record={d.id}
      data-agent-label={d.number}
    >
      {(d.kind === 'task' || d.kind === 'production') && d.productId && (
        <ProductMarks productId={d.productId} readOnly />
      )}
      <dl className="record-detail-grid">
        <div>
          <dt>业务日期 / 状态</dt>
          <dd>
            {d.date} · {flowStatusLabel(d)}
            {(d.kind === 'task' || d.kind === 'delivery') && (
              <span className="sub">
                计划日期：{planDate(d)}；
                {d.kind === 'delivery'
                  ? '实际发货：' + (d.actualDate || '尚未发货')
                  : '实际完工：' + (d.actualCompletionDate || '尚未完工')}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>操作人员</dt>
          <dd>{d.confirmedBy || d.actorName}</dd>
        </div>
        {d.kind === 'arrival' && (
          <div>
            <dt>{d.isPlan ? '预计到货' : '实际到货时间'}</dt>
            <dd>
              {d.isPlan
                ? `${d.plannedDate} ${d.plannedTime || '时间未填写'}`
                : `${d.date} ${d.actualTime || '时间未记录'}`}
            </dd>
          </div>
        )}
        {d.reference && (
          <div>
            <dt>供应商送货单号</dt>
            <dd>{d.reference}</dd>
          </div>
        )}
        {d.kind === 'task' && (
          <>
            <div>
              <dt>计划 / 累计完工</dt>
              <dd>
                {d.quantity} / {d.completed} {d.unit}
              </dd>
            </div>
            <div>
              <dt>关联客户订单</dt>
              <dd>
                {d.orderIds
                  .map((id: number) => data.orders.find((o: any) => o.id === id)?.number || id)
                  .join('、') || '独立生产'}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>备注</dt>
          <dd>{d.notes || '—'}</dd>
        </div>
      </dl>
      {d.sourceId && (
        <a
          className="secondary"
          target="_blank"
          rel="noreferrer"
          href={'/api/flow/sources/' + d.sourceId + '/file'}
        >
          查看供应商送货单原件
        </a>
      )}
      {d.kind === 'arrival' && (
        <div className="table-wrap">
          <table className="flow-table">
            <thead>
              <tr>
                {[
                  '纸板名称 / 规格',
                  '材质 / 楞型',
                  d.isPlan ? '预计到货数量' : '实收到货数量',
                  '合格 / 不合格 / 实际入库',
                  '面积 m²',
                  '计价 / 金额 元',
                  '采购关联 / 差异',
                ].map((n) => (
                  <th key={n}>{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td>
                    {l.item.name}
                    <span className="sub">{l.item.specification || formatStockSize(l.item)}</span>
                  </td>
                  <td>
                    {l.item.material} / {l.item.flute}
                  </td>
                  <td>
                    {l.quantity} {l.item.unit}
                  </td>
                  <td>
                    {d.isPlan ? (
                      '尚未验收 / 尚未入库'
                    ) : (
                      <>
                        {l.acceptedQuantity ?? '未记录'} / {l.rejectedQuantity ?? '未记录'} /{' '}
                        {l.stockedQuantity ?? '确认后核验'}
                      </>
                    )}
                  </td>
                  <td>{safeArea(l)}</td>
                  <td>
                    {l.unitPrice ?? '待定'} /{' '}
                    {l.priceBasis === null
                      ? '依据待确认'
                      : l.priceBasis === 'area'
                        ? 'm²'
                        : l.item.unit}
                    <span className="sub">金额 {safeAmount(l)}</span>
                  </td>
                  <td>
                    {l.purchaseNumber ||
                      data.purchases.find((p: any) =>
                        p.lines.some((x: any) => x.id === l.purchaseLineId),
                      )?.number ||
                      '无采购单'}
                    <span className="sub">{l.differenceReason || '无差异说明'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.kind === 'production' && (
        <>
          <h3>
            合格 {d.goodQuantity} · 报废 {d.scrapQuantity}{' '}
            {data.items.find((s: any) => s.id === d.finishedStockId)?.unit} · 实际操作 {d.operator}
          </h3>
          <div className="table-wrap">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>原材料</th>
                  <th>领用 / 张</th>
                  <th>退料 / 张</th>
                  <th>净耗用 / 张</th>
                </tr>
              </thead>
              <tbody>
                {d.materials.map((m: any) => (
                  <tr key={m.stockId}>
                    <td>{data.items.find((s: any) => s.id === m.stockId)?.name || m.stockId}</td>
                    <td>{m.issued}</td>
                    <td>{m.returned}</td>
                    <td>{Number(m.issued) - Number(m.returned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {d.kind === 'delivery' && (
        <>
          <p>
            {data.customers.find((c: any) => c.id === d.customerId)?.name} · {d.address}
          </p>
          <div className="table-wrap">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>客户订单</th>
                  <th>产品名称</th>
                  <th>规格型号</th>
                  <th>本次发货</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l: any, i: number) => {
                  const o = data.orders.find((o: any) => o.id === l.orderId),
                    ol = o?.lines.find((x: any) => x.id === l.orderLineId);
                  return (
                    <tr key={i}>
                      <td>{l.orderNumber || o?.number}</td>
                      <td>{l.productName || ol?.productName}</td>
                      <td>{l.specification || ol?.specification}</td>
                      <td>
                        {l.quantity} {l.unit || ol?.unit}
                      </td>
                      <td>{l.notes}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {d.reversal && (
        <p className="flow-warning">
          已冲销 · {d.reversal.by} · {d.reversal.at} · 原因：{d.reversal.reason}
        </p>
      )}
      {d.cancellation && (
        <p className="flow-warning">
          取消原因：{d.cancellation.reason} · {d.cancellation.by} · {d.cancellation.at}
          。已确认的生产和库存历史保留。
        </p>
      )}
    </div>
  );
}
