import { useState } from 'react';
import { deliveryBlockers, deliveryCandidates, formatStockSize } from '../../shared/business/index';
import { FormField, FormSection } from '../ui/index';
import DeliveryBlockers from './DeliveryBlockers';
import DeliveryLineRows from './DeliveryLineRows';
import { BlockedStock, DeliveryStockChoices } from './DeliveryStockChoices';
import { describeStock, seedLine, type DeliveryEditing, type DeliveryFormData, type DeliveryPick, type StockItem } from './delivery-stock';

/** 超订单数量发货的两项：勾没勾、原因 */
type OverdeliveryFields = Pick<DeliveryEditing, 'allowOverdelivery' | 'overdeliveryReason'>;

/**
 * 送货单里“送哪些货”：先在上面勾选这个客户能送的成品（DeliveryStockChoices），再在下面每行选订单明细、
 * 填本次数量（DeliveryLineRows）。不能送的成品（没有这个客户的订单或没有库存）收在最后，说明原因。导出送货单时才出库。
 */
export default function DeliveryStockPicker({
  value,
  data,
  change,
}: {
  value: Pick<DeliveryEditing, 'customerId' | 'lines'> & OverdeliveryFields;
  data: Pick<DeliveryFormData, 'items' | 'products' | 'orders'>;
  change: (patch: Partial<DeliveryEditing>) => void;
}) {
  const [search, setSearch] = useState('');
  const customerId = value.customerId;
  const all = data.items.filter((i) => i.kind === 'finished' && !i.archived);
  const products = new Map(data.products.map((p) => [p.id, p]));
  const productOf = (item: StockItem) => (item.productId == null ? undefined : products.get(item.productId));
  const rows = all.filter((i) =>
    [i.name, i.specification, formatStockSize(i), productOf(i)?.customerProductCode]
      .join(' ')
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const lines = value.lines.filter((l) => l.stockId != null);
  const candidates = (item: StockItem) => deliveryCandidates(item, customerId, data.orders, value.allowOverdelivery);
  const pick: DeliveryPick = {
    lines,
    candidates,
    seed: (item, current) => seedLine(candidates(item), item, current),
    change,
  };
  const isSelected = (item: StockItem) => lines.some((l) => l.stockId === item.id);
  const eligible = rows.filter((i) => customerId && i.balanceUnits > 0 && candidates(i).length > 0);
  // 有库存、这个客户也有订单在等，却对不上的（没写单位、规格不一致……）
  const blockers = customerId
    ? all.filter((i) => i.balanceUnits > 0).flatMap((i) => deliveryBlockers(i, data.orders, customerId))
    : [];
  const shown = rows.filter((i) => isSelected(i) || eligible.includes(i));
  const blocked = rows.filter((i) => !shown.includes(i));
  const pickedItems = all.filter(isSelected);
  return (
    <FormSection
      title="送哪些货"
      hint={customerId ? '只列这个客户有待交付订单、又有库存的成品；导出送货单时出库。' : undefined}
      columns={1}
      extra={
        customerId ? (
          <div className="wh-picker-filters">
            <input
              aria-label="搜索送货成品"
              placeholder="名称、型号、规格"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
        ) : undefined
      }
    >
      {!customerId ? (
        <p className="choice-list-empty wh-picker-empty">先选客户，再勾选要送的成品。</p>
      ) : (
        <>
          {blockers.length > 0 && <DeliveryBlockers blockers={blockers} />}
          <DeliveryStockChoices
            pick={pick}
            shown={shown}
            eligible={eligible}
            picked={pickedItems.length}
            emptyText={
              rows.length || !all.length
                ? '这个客户没有可送的成品：先确认订单，或等成品入库。'
                : '没有符合筛选条件的成品。'
            }
            describe={(item) => describeStock(item, productOf(item))}
          />
          {lines.length > 0 && <DeliveryLineRows pick={pick} pickedItems={pickedItems} />}
          {blocked.length > 0 && (
            <BlockedStock blocked={blocked} candidates={candidates} orders={data.orders} customerId={customerId} />
          )}
        </>
      )}
      <Overdelivery value={value} change={change} />
    </FormSection>
  );
}

/** 超订单数量发货（特殊情况）：勾上要写原因，服务端还要有效的超级管理员；仍不能超库存。安排送货和更正送货单共用 */
export function Overdelivery({ value, change }: { value: OverdeliveryFields; change: (patch: Partial<OverdeliveryFields>) => void }) {
  return (
    <details className="line-card-more">
      <summary>超订单数量发货（特殊情况）</summary>
      <div className="ed-grid cols-1">
        <label className="wh-check-line">
          <input
            type="checkbox"
            checked={value.allowOverdelivery}
            onChange={(e) => change({ allowOverdelivery: e.currentTarget.checked })}
          />
          申请超订单发货：需有效超级管理员并写明原因，仍不能超库存
        </label>
        {value.allowOverdelivery && (
          <FormField label="超订单原因" required>
            <textarea
              aria-label="超订单发货原因"
              value={value.overdeliveryReason}
              onChange={(e) => change({ overdeliveryReason: e.currentTarget.value })}
            />
          </FormField>
        )}
      </div>
    </details>
  );
}
