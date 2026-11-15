import { quantityString } from '../../shared/core/index';
import { FormSection } from '../ui/index';
import type { planOrderDelivery, StockItemView } from '../../shared/business/index';

/** 这里要显示的库存品：名称、单位、可用量 */
type ShownStock = Pick<StockItemView, 'id' | 'name' | 'unit' | 'availableUnits'>;
type DeliveryPlan = ReturnType<typeof planOrderDelivery>;

/** 安排送货：几个客户在等同一种成品时，先选给谁（默认按交期先后排满） */
export function StockOwners({
  contested,
  owners,
  setOwners,
  customerName,
}: {
  contested: { stock: ShownStock; customers: number[] }[];
  owners: Record<number, number>;
  setOwners: (update: (o: Record<number, number>) => Record<number, number>) => void;
  customerName: (id: number) => string;
}) {
  return (
    <FormSection title="先选给谁" hint="这几种成品有几个客户在等。默认按交期先后排满，也可以指定给某个客户。">
      {contested.map(({ stock, customers }) => (
        <label className="form-field span-full" key={stock.id}>
          <span className="form-field-label">
            {stock.name} · 可用 {quantityString(Math.max(0, stock.availableUnits))} {stock.unit}
          </span>
          <select
            aria-label={stock.name + ' 给哪个客户'}
            value={owners[stock.id] ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value);
              setOwners((o) => {
                const next = { ...o };
                if (v) next[stock.id] = v;
                else delete next[stock.id];
                return next;
              });
            }}
          >
            <option value="">按交期先后分给 {customers.map(customerName).join('、')}</option>
            {customers.map((id) => (
              <option key={id} value={id}>
                只给 {customerName(id)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </FormSection>
  );
}

/** 安排送货：这次送不了的成品和订单，各说原因 */
export function Unplanned({
  idle,
  skipped,
  missing,
  orderNumber,
}: {
  idle: { stock: Pick<ShownStock, 'id' | 'name'>; reason: string }[];
  skipped: DeliveryPlan['skipped'];
  missing: DeliveryPlan['missing'];
  orderNumber: (orderId: number) => string;
}) {
  if (!idle.length && !skipped.length && !missing.length) return null;
  return (
    <FormSection title="这次送不了的" columns={1}>
      <ul className="help-list">
        {idle.map(({ stock, reason }) => (
          <li key={'s' + stock.id}>
            {stock.name}：{reason}
          </li>
        ))}
        {skipped.map((s) => (
          <li key={'o' + s.orderId}>
            {s.orderNumber}：{s.reason}
          </li>
        ))}
        {missing.map((m) => (
          <li key={'m' + m.orderId + m.productName}>
            {orderNumber(m.orderId)} · {m.productName}：还差 {m.quantity} {m.unit} 没有库存
          </li>
        ))}
      </ul>
    </FormSection>
  );
}
