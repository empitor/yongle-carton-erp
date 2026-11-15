import { Plus } from 'lucide-react';
import { selectedStockUnits } from '../../shared/business/index';
import { quantityString } from '../../shared/core/index';
import { FormGroup, RowDelete } from '../ui/index';
import { stockText, type DeliveryEditLine, type DeliveryPick, type StockItem } from './delivery-stock';

/**
 * 送货单“送哪些货”下半“本次送货”：勾上的每种成品一行或几行（分配到几张订单），每行选订单明细、填本次数量和备注。
 * 一种成品的第一行写库存和本次合计，超出库存标红。
 */
export default function DeliveryLineRows({ pick, pickedItems }: { pick: DeliveryPick; pickedItems: StockItem[] }) {
  const { lines } = pick;
  return (
    <FormGroup label="本次送货">
      <div className="line-table">
        <table>
          <thead>
            <tr>
              <th>成品</th>
              <th>对应订单明细</th>
              <th className="num">本次送货</th>
              <th>备注</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {pickedItems.flatMap((item) =>
              lines.flatMap((l, index) => (l.stockId === item.id ? [index] : [])).map((index, n) => (
                <LineRow key={index} pick={pick} item={item} index={index} first={n === 0} />
              )),
            )}
          </tbody>
        </table>
      </div>
    </FormGroup>
  );
}

function LineRow({ pick, item, index, first }: { pick: DeliveryPick; item: StockItem; index: number; first: boolean }) {
  const { lines, change } = pick;
  const line = lines[index],
    choices = pick.candidates(item);
  const update = (patch: Partial<DeliveryEditLine>) => change({ lines: lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) });
  return (
    <tr>
      <td className="wh-cell-text">{first ? <ItemHead pick={pick} item={item} /> : <small>同上，另一订单</small>}</td>
      <td>
        <select
          aria-label={item.name + ' 对应订单明细 ' + (index + 1)}
          aria-required="true"
          value={line.orderLineId || ''}
          onChange={(e) => {
            const value = Number(e.currentTarget.value);
            const c = choices.find((c) => c.orderLineId === value);
            update({ orderId: c?.orderId || null, orderLineId: c?.orderLineId || null });
          }}
        >
          <option value="">选择这个客户的订单明细</option>
          {choices
            .filter((c) => c.orderLineId === line.orderLineId || !lines.some((l) => l.orderLineId === c.orderLineId))
            .map((c) => (
              <option key={c.orderLineId} value={c.orderLineId}>
                {c.orderNumber} · {c.productName} · 待交付 {c.remainingQuantity ?? c.quantity} {c.unit}
              </option>
            ))}
        </select>
      </td>
      <td className="num">
        <div className="wh-qty">
          <input
            aria-label={item.name + ' 本次送货数量 ' + (index + 1)}
            aria-required="true"
            inputMode="decimal"
            placeholder="数量"
            value={line.quantity}
            onChange={(e) => update({ quantity: e.currentTarget.value })}
          />
          <span>{item.unit}</span>
        </div>
      </td>
      <td>
        <input
          aria-label={item.name + ' 明细备注 ' + (index + 1)}
          placeholder="选填"
          value={line.notes}
          onChange={(e) => update({ notes: e.currentTarget.value })}
        />
      </td>
      <td>
        <RowDelete
          label={'移除 ' + item.name + ' ' + (index + 1)}
          onClick={() => change({ lines: lines.filter((_, i) => i !== index) })}
        />
      </td>
    </tr>
  );
}

/** 一种成品第一行的成品格：名称、库存和本次合计，还有订单明细没分完时“分配到另一订单” */
function ItemHead({ pick, item }: { pick: DeliveryPick; item: StockItem }) {
  const { lines, change } = pick;
  const used = selectedStockUnits(lines, item.id),
    over = used !== null && used > item.balanceUnits,
    more = pick.candidates(item).some((c) => !lines.some((l) => l.orderLineId === c.orderLineId));
  return (
    <>
      <strong>{item.name}</strong>
      <small className={over ? 'wh-danger' : undefined}>
        {stockText(item)} · {used === null ? '本次数量待填写' : '本次 ' + quantityString(used) + ' ' + item.unit}
        {over ? ' · 超出库存' : ''}
      </small>
      {more && (
        <button type="button" className="wh-link" onClick={() => change({ lines: [...lines, pick.seed(item, lines)] })}>
          <Plus size={12} aria-hidden="true" />
          分配到另一订单
        </button>
      )}
    </>
  );
}
