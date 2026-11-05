import { useEffect, useMemo, useState } from 'react';
import { managementRequest } from './session';
import { quantityString, quantityUnits } from '../shared/operations';

type Candidate = {
  key: string;
  orderId: number;
  orderNumber: string;
  orderLineId: number;
  customerId: number;
  customerName: string;
  productName: string;
  deliveryDate: string;
  remaining: number;
  unit: string;
  stockId: number;
  available: number;
};

/** 可发货清单：列出有成品可发的订单明细，勾选同一客户的多行一起生成送货单。 */
export default function ReadyToShip({
  revision,
  create,
}: {
  revision: number;
  create: (
    customerId: number,
    lines: { orderId: number; orderLineId: number; stockId: number; quantity: string }[],
  ) => void;
}) {
  const [orders, setOrders] = useState<any[]>([]),
    [items, setItems] = useState<any[]>([]),
    [checked, setChecked] = useState<string[]>([]),
    [open, setOpen] = useState(true);
  useEffect(() => {
    let active = true;
    Promise.all([
      managementRequest<any[]>('/orders'),
      managementRequest<any[]>('/warehouse/items?kind=finished'),
    ])
      .then(([o, i]) => {
        if (active) {
          setOrders(o);
          setItems(i);
          setChecked([]);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [revision]);
  const candidates = useMemo(() => {
    const rows: Candidate[] = [];
    for (const order of orders) {
      if (!['已确认', '生产中', '待发货'].includes(order.status)) continue;
      for (const line of order.lines) {
        const remaining = line.remainingQuantity ?? line.quantity;
        if (remaining <= 0 || !line.unit) continue;
        // 产品和单位都一致的成品档案才算可发，不能跨单位或按名称猜。
        const stock = items.find(
          (i) => i.productId === line.productId && i.unit === line.unit && i.availableUnits > 0,
        );
        if (!stock) continue;
        rows.push({
          key: order.id + ':' + line.id,
          orderId: order.id,
          orderNumber: order.number,
          orderLineId: line.id,
          customerId: order.customerId,
          customerName: order.customerName,
          productName: line.productName,
          deliveryDate: line.deliveryDate || order.deliveryDate,
          remaining,
          unit: line.unit,
          stockId: stock.id,
          available: stock.availableUnits,
        });
      }
    }
    return rows.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
  }, [orders, items]);
  if (!candidates.length) return null;
  const chosen = candidates.filter((c) => checked.includes(c.key)),
    customer = chosen[0]?.customerId;
  const quantityOf = (c: Candidate) =>
    quantityString(Math.min(quantityUnits(String(c.remaining)), c.available));
  return (
    <section className="panel ready-to-ship">
      <header>
        <button
          className="ready-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          可发货 {candidates.length} 行
        </button>
        {!!chosen.length && (
          <span className="sub">
            已选 {chosen.length} 行 · {chosen[0].customerName}
          </span>
        )}
        <button
          className="primary"
          disabled={!chosen.length}
          onClick={() =>
            create(
              customer,
              chosen.map((c) => ({
                orderId: c.orderId,
                orderLineId: c.orderLineId,
                stockId: c.stockId,
                quantity: quantityOf(c),
              })),
            )
          }
        >
          合并生成送货单
        </button>
      </header>
      {open && (
        <div className="ready-list">
          {candidates.map((c) => {
            const otherCustomer = customer !== undefined && c.customerId !== customer;
            return (
              <label
                className={'queue-row' + (otherCustomer ? ' disabled' : '')}
                key={c.key}
                title={otherCustomer ? '一张送货单只能发给一个客户' : undefined}
              >
                <input
                  type="checkbox"
                  aria-label={'选择 ' + c.orderNumber + ' ' + c.productName}
                  disabled={otherCustomer}
                  checked={checked.includes(c.key)}
                  onChange={(e) =>
                    setChecked((v) =>
                      e.target.checked ? [...v, c.key] : v.filter((k) => k !== c.key),
                    )
                  }
                />
                <span className="record-no">{c.orderNumber}</span>
                <span className="queue-main">
                  {c.customerName} · {c.productName}
                </span>
                <span className="queue-note">
                  待发 {c.remaining} {c.unit} · 可用 {quantityString(c.available)}
                </span>
                <span className="queue-note">交期 {c.deliveryDate}</span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
