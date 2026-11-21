import { useEffect, useMemo, useState } from 'react';
import { readCatalog, type CatalogLists } from '../recordkit/catalog-api';
import { SelectionBar } from '../ui/index';
import { today } from '../../shared/core/index';
import { isPhoneNow } from '../ui/index';
import { quantityString, quantityUnits } from '../../shared/core/index';
import { deliveryCandidates, planOrderDelivery, stockByProduct, type PlanPreset } from '../../shared/business/index';

type Orders = CatalogLists['pendingOrders'];
type Items = CatalogLists['finishedItems'];
type Candidate = {
  key: string;
  orderId: number;
  orderNumber: string;
  orderLineId: number;
  customerId: number;
  customerName: string;
  productName: string;
  deliveryDate: string;
  remaining: string;
  unit?: string;
  stockId: number;
  available: number;
};
type Props = {
  revision: number;
  /** 勾好的几行（同一个客户）：给哪个客户、哪几行本次多少 */
  create: (customerId: number, lines: PlanPreset['lines']) => void;
};

const lineKey = (orderId: number, orderLineId: number) => orderId + ':' + orderLineId;

/**
 * 勾选的几行能发多少：只排勾了的明细，按交期从早到晚分同一份可用量（和按订单安排送货同一个 planOrderDelivery）。
 * 返回每行本次数量和每个成品库存品分配后的余量，单位都是千分整数。
 */
export function allocateShipments(
  orders: Parameters<typeof planOrderDelivery>[0],
  items: Parameters<typeof planOrderDelivery>[1],
  checked: string[],
) {
  const picked = new Set(checked);
  const chosen = orders
    .map((o) => ({ ...o, lines: o.lines.filter((l) => picked.has(lineKey(o.id, l.id))) }))
    .filter((o) => o.lines.length);
  const allocated = new Map<string, number>();
  const left = new Map<number, number>(items.map((i) => [i.id, Math.max(0, Number(i.availableUnits) || 0)]));
  for (const group of planOrderDelivery(chosen, items).groups)
    for (const l of group.lines) {
      const units = quantityUnits(l.quantity);
      allocated.set(lineKey(l.orderId, l.orderLineId), units);
      left.set(l.stockId, (left.get(l.stockId) ?? 0) - units);
    }
  return { allocated, left };
}

/**
 * 有成品可发的订单明细，按交期先后。读的就是成品库存品，一个产品只有一个（数据库约束）：按产品直接取。
 * 哪些明细能发和送货窗口、服务端出库同一个判断（deliveryCandidates：订单能送、还没发完、规格对得上）
 */
function shippable(orders: Orders, items: Items) {
  const rows: Candidate[] = [];
  const finished = stockByProduct(items);
  for (const order of orders)
    for (const line of order.lines) {
      const stock = finished.get(line.productId);
      if (!stock || !(stock.availableUnits > 0)) continue;
      if (!deliveryCandidates(stock, order.customerId, [order]).some((c) => c.orderLineId === line.id)) continue;
      rows.push({
        key: lineKey(order.id, line.id),
        orderId: order.id,
        orderNumber: order.number,
        orderLineId: line.id,
        customerId: order.customerId,
        customerName: order.customerName,
        productName: line.productName,
        deliveryDate: line.deliveryDate || order.deliveryDate || '',
        remaining: String(line.remainingQuantity ?? line.quantity),
        unit: line.unit,
        stockId: stock.id,
        available: stock.availableUnits,
      });
    }
  return rows.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
}

/** 读还没发完的订单和成品库存品；业务变了（revision）重读，勾选清空 */
function useShipData(revision: number) {
  const [orders, setOrders] = useState<Orders>([]),
    [items, setItems] = useState<Items>([]),
    [checked, setChecked] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    readCatalog(['pendingOrders', 'finishedItems'])
      .then(({ pendingOrders: o, finishedItems: i }) => {
        if (active) {
          setOrders(o);
          setItems(i);
          setChecked([]);
        }
      })
      // 读不到就不显示“可发货”这一块：它只是送货页上方的快捷入口，页头“安排送货”打开的窗口自己读、读不到会说原因
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [revision]);
  return { orders, items, checked, setChecked };
}

// 默认摊开几行：手机上少一点，下面的送货单不被挤到第二屏以外
const limit = () => (isPhoneNow() ? 3 : 6);

/**
 * 可发货：列出有成品可发的订单明细，按交期先后。勾选同一客户的几行，底部选择条“安排送货（N 行）”。
 * 默认只摊开前几行，其余点“全部 N 行”展开，不在小框里滚动。
 */
export default function ReadyToShip({ revision, create }: Props) {
  const { orders, items, checked, setChecked } = useShipData(revision);
  const [expanded, setExpanded] = useState(false);
  const candidates = useMemo(() => shippable(orders, items), [orders, items]);
  if (!candidates.length) return null;
  const { allocated, left } = allocateShipments(orders, items, checked);
  // 每个可发的成品都在 left 里（和候选行出自同一份成品库存品）
  const leftOf = (stockId: number) => left.get(stockId) ?? 0;
  // 按勾选先后建单，分配到数量的行才进入送货单。
  const chosen = checked.flatMap((key) => {
    const c = candidates.find((x) => x.key === key),
      units = allocated.get(key);
    return c && units !== undefined ? [{ ...c, units }] : [];
  });
  const customer = chosen.at(0)?.customerId;
  // 勾过的行一直显示，收起时不会藏到下面
  const LIMIT = limit();
  const shown = expanded ? candidates : candidates.filter((c, i) => i < LIMIT || checked.includes(c.key));
  const now = today();
  return (
    <section className="panel wh-ready" aria-label="可发货">
      <header>
        <h2>可发货</h2>
        <span className="wh-muted">{candidates.length} 行有成品可以送，勾选同一个客户的几行一起安排</span>
      </header>
      <div className="wh-ready-list">
        {shown.map((c) => {
          const otherCustomer = customer !== undefined && c.customerId !== customer,
            picked = allocated.get(c.key),
            used = !picked && !(leftOf(c.stockId) > 0),
            blocked = otherCustomer || used;
          return (
            <label
              className={'queue-row' + (blocked ? ' disabled' : '')}
              key={c.key}
              title={otherCustomer ? '一张送货单只能发给一个客户' : used ? '这个成品的可用量已分配给已选的行' : undefined}
            >
              <input
                type="checkbox"
                aria-label={'选择 ' + c.orderNumber + ' ' + c.productName}
                disabled={blocked}
                checked={checked.includes(c.key)}
                onChange={(e) => setChecked((v) => (e.target.checked ? [...v, c.key] : v.filter((k) => k !== c.key)))}
              />
              <span className="record-no">{c.orderNumber}</span>
              <span className="queue-main">
                {c.customerName} · {c.productName}
              </span>
              <span className="queue-note">
                待发 {c.remaining} {c.unit} · {picked ? '本次 ' + quantityString(picked) : '可用 ' + quantityString(leftOf(c.stockId))}
              </span>
              <span className={'queue-note' + (c.deliveryDate && c.deliveryDate < now ? ' wh-late' : '')}>
                交期 {c.deliveryDate || '未定'}
              </span>
            </label>
          );
        })}
      </div>
      {candidates.length > LIMIT && (
        <button type="button" className="wh-link wh-ready-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '全部 ' + candidates.length + ' 行'}
        </button>
      )}
      <SelectionBar
        count={chosen.length}
        unit="行"
        note={chosen.at(0)?.customerName}
        primary={{
          label: '安排送货（' + chosen.length + ' 行）',
          onClick: () => {
            if (customer === undefined) return;
            create(
              customer,
              chosen.map((c) => ({ orderId: c.orderId, orderLineId: c.orderLineId, stockId: c.stockId, quantity: quantityString(c.units) })),
            );
          },
        }}
        onClear={() => setChecked([])}
      />
    </section>
  );
}
