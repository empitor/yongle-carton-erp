import { formatStockSize } from '../shared/operations';
import StatusBadge from './StatusBadge';
import { precisionTotal } from '../shared/precision';
import { displayAmount } from '../shared/display-amount';

export function SalesLines({ row }: { row: any }) {
  return (
    <div className="table-wrap fulfillment-lines">
      <table>
        <thead>
          <tr>
            {[
              '产品名称',
              '规格型号',
              '备注',
              '订购数量',
              '单位',
              '单价 / 元',
              '金额 / 元',
              '已发货',
              '待发货',
              '行状态',
            ].map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row.lines.map((l: any, i: number) => (
            <tr key={l.id || i}>
              <td>{l.productName}</td>
              <td>{l.specification || '未填写'}</td>
              <td>
                {l.notes || '—'}
                {(l.taxRate || l.taxMode || l.deliveryDate) && (
                  <span className="sub">
                    {l.taxRate} {l.taxMode} {l.deliveryDate}
                  </span>
                )}
              </td>
              <td>{l.quantity}</td>
              <td>{l.unit || '未确认'}</td>
              <td>{l.unitPriceExact ?? String(l.unitPriceCents / 100)}</td>
              <td>{precisionTotal([l]).exact}</td>
              <td>{l.shippedQuantity == null ? '历史数量待核对' : l.shippedQuantity}</td>
              <td>{l.remainingQuantity == null ? '历史数量待核对' : l.remainingQuantity}</td>
              <td>
                <StatusBadge status={l.shippingStatus || '历史数量待核对'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProgressSummary({ row, purchase = false }: { row: any; purchase?: boolean }) {
  const summary = purchase ? row.arrivalSummary : row.shippingSummary;
  return (
    <div className="fulfillment-summary">
      <StatusBadge
        status={(purchase ? row.arrivalProgress : row.shippingProgress) || '历史数量待核对'}
      />
      {summary && (
        <span className="sub">
          {summary.completedLines}/{summary.totalLines} 行{purchase ? '已到齐' : '已发完'}
          {summary.unknownLines > 0 && `；${summary.unknownLines} 行待核对`}
        </span>
      )}
      {purchase && row.discrepancies?.length > 0 && <span className="sub"><StatusBadge status="待核对差异" /></span>}
    </div>
  );
}

export function ReceiptHistory({
  row,
  lineId,
  correct,
}: {
  row: any;
  lineId?: number;
  correct?: (receipt: any) => void;
}) {
  const receipts = (row.receipts || []).filter(
    (r: any) => lineId === undefined || r.items.some((l: any) => l.lineId === lineId),
  );
  const chain = (record: any) => {
    const ids = new Set([record.id]);
    for (let i = 0; i < row.receipts.length; i++)
      for (const r of row.receipts)
        if (ids.has(r.id) || ids.has(r.correctionOf) || ids.has(r.replacedBy)) {
          ids.add(r.id);
          if (r.correctionOf) ids.add(r.correctionOf);
          if (r.replacedBy) ids.add(r.replacedBy);
        }
    return row.receipts
      .filter((r: any) => ids.has(r.id))
      .slice()
      .reverse();
  };
  return (
    <div className="table-wrap receipt-history">
      <table>
        <thead>
          <tr>
            {['到货日期 / 单号或批次', '本次登记数量', '更正状态 / 关联历史', '操作'].map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {receipts.map((r: any) => (
            <tr key={r.id}>
              <td>
                <strong>{r.reference}</strong>
                <span className="sub">
                  {r.date} · {r.actorName}
                </span>
              </td>
              <td>
                {r.items
                  .filter((l: any) => lineId === undefined || l.lineId === lineId)
                  .map((l: any) => (
                    <div key={l.index}>
                      {l.item.name}：{l.quantity} {l.item.unit}
                    </div>
                  ))}
              </td>
              <td>
                <StatusBadge
                  status={
                    r.effective
                      ? r.correctionOf
                        ? '更正后有效'
                        : '有效到货'
                      : r.reversed
                        ? '已冲销'
                        : r.status === 'draft'
                          ? '草稿'
                          : '已取消'
                  }
                />
                {r.reason && <span className="sub">原因：{r.reason}</span>}
                {r.dataEdits?.length > 0 && <details className="data-edit-history"><summary>管理员数据编辑历史</summary>
                  <ol>{r.dataEdits.map((edit: any) => <li key={edit.auditId}>{edit.at} · {edit.actorName} · {edit.reason}
                    {edit.after.map((l: any, i: number) => <span className="sub" key={i}>{l.item.name}：{edit.before[i].quantity} → {l.quantity} {l.item.unit}；库存未调整</span>)}
                  </li>)}</ol>
                </details>}
                {r.discrepancies?.length > 0 && <div className="reconciliation-warning"><StatusBadge status={r.effective ? '待核对差异' : '历史统计差异（原单已失效）'} />
                  {r.discrepancies.map((d: any) => <p key={d.index}>{d.name}：原入库 {d.recordedQuantity} {d.unit}；当次有效到货 {d.effectiveQuantity} {d.unit}；当次数据编辑未调整库存</p>)}
                </div>}
                {(r.correctionOf || r.replacedBy) && (
                  <details>
                    <summary>查看原始与更正历史</summary>
                    <ol>
                      {chain(r).map((event: any) => (
                        <li key={event.id}>
                          {event.correctionOf ? '更正到货' : '原始到货'} · {event.date} ·{' '}
                          {event.effective ? '当前有效' : '已被更正'}
                          {event.items.map((l: any) => (
                            <span className="sub" key={l.index}>
                              {l.item.name}：{l.quantity} {l.item.unit}
                            </span>
                          ))}
                          {event.reason && <span className="sub">原因：{event.reason}</span>}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {r.sourceId && (
                  <a
                    className="sub"
                    href={'/api/flow/sources/' + r.sourceId + '/file'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看原始文件
                  </a>
                )}
              </td>
              <td>
                {r.missingFlow ? (
                  '关联到货单缺失，请核对'
                ) : r.effective && correct ? (
                  <button onClick={() => correct(r)}>更正到货单</button>
                ) : r.flowId ? (
                  <a href={'#arrivals?doc=' + r.flowId}>查看单据</a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {!receipts.length && (
            <tr>
              <td colSpan={4}>暂无到货记录</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function PurchaseLines({ row, correct }: { row: any; correct?: (receipt: any) => void }) {
  return (
    <div className="table-wrap fulfillment-lines">
      <table className="op-detail-table">
        <thead>
          <tr>
            {[
              '纸板名称 / 规格',
              '楞型 / 材质',
              '订购数量',
              '已到货',
              '待到货',
              '行状态',
              '单价 / 元',
              '订购金额 / 元',
              '有效到货金额 / 元',
              '备注 / 到货记录',
            ].map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row.lines.map((l: any) => (
            <tr key={l.id}>
              <td>
                {l.name}
                <span className="sub">{l.specification || formatStockSize(l)}</span>
              </td>
              <td>
                {l.flute || '—'} / {l.material || '—'}
              </td>
              <td>
                {l.quantity} {l.unit}
              </td>
              <td>
                {l.receivedQuantity} {l.unit}
              </td>
              <td>
                {l.remainingQuantity} {l.unit}
              </td>
              <td>
                <StatusBadge status={l.arrivalStatus} />
                {l.discrepancies?.length > 0 && <span className="sub"><StatusBadge status="待核对差异" /></span>}
              </td>
              <td>
                {l.unitPrice ?? '待定'}
                <span className="sub">{l.priceBasis === 'area' ? '每平方米' : '每' + l.unit}</span>
              </td>
              <td>{l.amount == null ? '待定' : displayAmount(l.amount)}</td>
              <td>{l.receivedAmount == null ? '待定' : displayAmount(l.receivedAmount)}</td>
              <td>
                {l.notes || '—'}
                <details className="line-receipts">
                  <summary>查看到货记录</summary>
                  <ReceiptHistory row={row} lineId={l.id} correct={correct} />
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
