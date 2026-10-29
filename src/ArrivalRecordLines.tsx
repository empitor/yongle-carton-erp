import StatusBadge from './StatusBadge';
import { formatStockSize, quantityString } from '../shared/operations';
const amount = (value: string | null, unit: string) =>
  value == null ? '未记录' : value + ' ' + unit;
export function ArrivalRecordLines({ record }: { record: any }) {
  return (
    <div className="table-wrap fulfillment-lines arrival-record-lines">
      <table>
        <thead>
          <tr>
            {[
              '产品名称 / 规格',
              '关联采购',
              '采购数量',
              '本批到货',
              '累计到货',
              '剩余待到货',
              '合格',
              '不合格',
              '实际入库',
              '库存流水',
            ].map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {record.lines.map((l: any) => (
            <tr key={l.index}>
              <td>
                <strong>{l.item.name}</strong>
                <span className="sub">{l.item.specification || formatStockSize(l.item)}</span>
              </td>
              <td>
                {l.purchaseId ? (
                  <a
                    className="record-expand"
                    href={'#purchases?q=' + encodeURIComponent(l.purchaseNumber)}
                  >
                    {l.purchaseNumber}
                  </a>
                ) : (
                  '未关联采购'
                )}
              </td>
              <td>{amount(l.orderedQuantity, l.item.unit)}</td>
              <td>
                {amount(l.quantity, l.item.unit)}
                {l.recordedQuantity != null && l.recordedQuantity !== l.quantity && (
                  <span className="sub">原始实收 {amount(l.recordedQuantity, l.item.unit)}</span>
                )}
              </td>
              <td>
                {amount(l.receivedQuantity, l.item.unit)}
                {l.arrivalStatus && (
                  <span className="sub">
                    <StatusBadge status={l.arrivalStatus} />
                  </span>
                )}
              </td>
              <td>{amount(l.remainingQuantity, l.item.unit)}</td>
              <td>{amount(l.acceptedQuantity, l.item.unit)}</td>
              <td>{amount(l.rejectedQuantity, l.item.unit)}</td>
              <td>
                {record.status === 'draft' ? '尚未入库' : amount(l.stockedQuantity, l.item.unit)}
                {!record.effective && record.status !== 'draft' && (
                  <span className="sub">原单已失效，请查看更正链</span>
                )}
              </td>
              <td>
                {l.movements.length ? (
                  <details>
                    <summary>{l.movements.length} 笔关联流水</summary>
                    {l.movements.map((m: any) => (
                      <p key={m.id} className="arrival-movement">
                        {m.date} · {Number(m.delta_units) >= 0 ? '+' : '-'}
                        {quantityString(Math.abs(Number(m.delta_units)))} {l.item.unit}
                        <span className="sub">{m.notes}</span>
                        <code>{m.id}</code>
                      </p>
                    ))}
                  </details>
                ) : (
                  '无入库流水'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
