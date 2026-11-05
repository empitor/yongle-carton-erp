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

/**
 * 多行共用一个成品档案时，按勾选先后从同一份可用量里分配。
 * 返回每行本次数量和每个档案分配后的余量，单位都是千分整数。
 */
export function allocateShipments(
  candidates: Pick<Candidate, 'key' | 'stockId' | 'remaining' | 'available'>[],
  checked: string[],
) {
  const left = new Map(candidates.map((c) => [c.stockId, c.available]));
  const allocated = new Map<string, number>();
  for (const key of checked) {
    const c = candidates.find((row) => row.key === key);
    if (!c) continue;
    const quantity = Math.min(quantityUnits(String(c.remaining)), left.get(c.stockId) ?? 0);
    if (quantity <= 0) continue;
    allocated.set(key, quantity);
    left.set(c.stockId, (left.get(c.stockId) ?? 0) - quantity);
  }
  return { allocated, left };
}

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
      managementRequest<any[]>('/orders?view=pending'),
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
  const { allocated, left } = allocateShipments(candidates, checked);
  // 按勾选先后建单，分配到数量的行才进入送货单。
  const chosen = checked
    .map((key) => candidates.find((c) => c.key === key))
    .filter((c): c is Candidate => !!c && allocated.has(c.key));
  const customer = chosen[0]?.customerId;
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
                quantity: quantityString(allocated.get(c.key)!),
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
            const otherCustomer = customer !== undefined && c.customerId !== customer,
              picked = allocated.get(c.key),
              used = !picked && !(left.get(c.stockId)! > 0),
              blocked = otherCustomer || used;
            return (
              <label
                className={'queue-row' + (blocked ? ' disabled' : '')}
                key={c.key}
                title={
                  otherCustomer
                    ? '一张送货单只能发给一个客户'
                    : used
                      ? '这个成品的可用量已分配给已选的行'
                      : undefined
                }
              >
                <input
                  type="checkbox"
                  aria-label={'选择 ' + c.orderNumber + ' ' + c.productName}
                  disabled={blocked}
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
                  待发 {c.remaining} {c.unit} ·{' '}
                  {picked
                    ? '本次 ' + quantityString(picked)
                    : '可用 ' + quantityString(left.get(c.stockId)!)}
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
