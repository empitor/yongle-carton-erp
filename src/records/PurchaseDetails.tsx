import BatchCard from '../operations/BatchCard';
import { ARRIVAL_HISTORY_TITLE, UNPRICED_TEXT, formatStockSize, priceText, type PurchaseView } from '../../shared/business/index';
import { displayAmount, quantityString, fieldShort } from '../../shared/core/index';
import { ReceiptHistory } from '../flow/FulfillmentDetails';
import { Facts, Progress, Section } from '../ui/index';
import { useAgentRecord } from '../recordkit/record-meta';

type PurchaseLine = PurchaseView['lines'][number];
/** 采购单的一条到货记录（一张到货单） */
export type PurchaseReceipt = PurchaseView['receipts'][number];

const money = (v: string | null | undefined) => (v == null ? UNPRICED_TEXT : displayAmount(v) + ' 元');

/** 所有明细同一数量单位时才显示总到货进度；张和公斤不相加。 */
function arrivalTotals(lines: readonly PurchaseLine[]) {
  const units = [...new Set(lines.map((l) => l.unit))];
  if (units.length !== 1 || !lines.length) return null;
  return {
    unit: units[0],
    done: quantityString(lines.reduce((n, l) => n + (Number(l.receivedUnits) || 0), 0)),
    total: quantityString(lines.reduce((n, l) => n + (Number(l.quantityUnits) || 0), 0)),
  };
}

/** 采购明细表：纸板、订购、已到 / 待到（订过货才有）、金额 */
function PurchaseLines({ lines, ordered }: { lines: readonly PurchaseLine[]; ordered: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>纸板</th>
            <th className="num">{fieldShort('quantity', { record: 'purchases', parent: 'lines' })}</th>
            {ordered && <th className="num">已到 / 待到</th>}
            <th className="num">金额</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.name}
                <small>
                  {[l.specification || formatStockSize(l), [l.material, l.flute].filter(Boolean).join(' / ')]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                {l.notes && <small>{l.notes}</small>}
                {l.customerOrderId && l.customerOrderNumber && <small>给订单 {l.customerOrderNumber}</small>}
              </td>
              <td className="num">
                {l.quantity} {l.unit}
                <small>{priceText(l.unitPrice, l.priceBasis, l.unit)}</small>
              </td>
              {ordered && (
                <td className="num">
                  {l.receivedQuantity} / {l.remainingQuantity}
                  <small>{l.arrivalStatus}</small>
                </td>
              )}
              <td className="num">
                {l.amount == null ? '待定' : displayAmount(l.amount)}
                {ordered && <small>到货 {l.receivedAmount == null ? '待定' : displayAmount(l.receivedAmount)}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 关联订单：一张采购单可以给几张订单订料，单头和各行关联的订单都列出来 */
function linkedOrders(row: PurchaseView) {
  if (row.customerOrders.length)
    return (
      <>
        {row.customerOrders.map((o, i) => (
          <span key={o.id}>
            {i > 0 && '、'}
            <a href={'#orders?order=' + o.id}>{o.number}</a>
          </span>
        ))}
      </>
    );
  if (row.customerOrderId)
    return <a href={'#orders?order=' + row.customerOrderId}>{row.customerOrderNumber || '查看订单'}</a>;
  return '独立采购';
}

/** 采购单正文：提示 → 到货进度 → 明细 → 订货单 → 基本信息 → 到货记录。操作都在头部。 */
export function PurchaseDetails({
  row,
  correctReceipt,
}: {
  row: PurchaseView;
  correctReceipt?: (receipt: PurchaseReceipt) => void;
}) {
  const totals = arrivalTotals(row.lines);
  const agent = useAgentRecord('purchases', row);
  const ordered = row.businessStatus !== '待订货' || row.receipts.length > 0;
  return (
    <div className="pur-details" {...agent}>
      {totals && ordered && row.businessStatus !== '已取消' && (
        <Progress label="到货进度" done={totals.done} total={totals.total} unit={totals.unit} />
      )}
      <Section title={'采购明细 · ' + row.lines.length + ' 种纸板'}>
        <PurchaseLines lines={row.lines} ordered={ordered} />
      </Section>
      <BatchCard purchaseId={row.id} />
      <Section title="基本信息">
        <Facts
          items={[
            { label: '供应商', value: row.supplierName },
            { label: '关联订单', value: linkedOrders(row) },
            { label: '采购日期', value: row.orderDate },
            { label: '预计到货', value: row.expectedDate },
            { label: '订货金额', value: money(row.totalAmount) },
            { label: '有效到货金额', value: money(row.receivedAmount), hidden: !ordered },
            { label: '备注', value: row.notes, wide: true },
          ]}
        />
      </Section>
      {ordered && (
        <Section title={ARRIVAL_HISTORY_TITLE}>
          {row.receipts.length ? (
            <ReceiptHistory row={row} correct={correctReceipt} />
          ) : (
            <p className="pur-empty">还没有到货。</p>
          )}
        </Section>
      )}
    </div>
  );
}
