import { sales } from '../../sales/index.js';
import { z } from 'zod';
import { lineShippingProgress, quantityUnits, type Order } from '../../../shared/core/index.js';
import type { DeliveryDaily } from '../../../shared/business/index.js';
import type { Store } from '../../core/index.js';
import { many, rows } from '../../core/index.js';
import type { DeliveryLine } from '../documents/base.js';
import { shippedByLine } from '../documents/shipped.js';
import { FlowService } from '../rules/service.js';

/*
 * 仓库台账里的送货单：单据视图加上客户名、订单明细的品名规格和发货进度、每行挂的出库流水（daily.ts 用；结构在 shared/business/flow-views.ts）。
 * 订单、库存品、客户、流水都按这批送货单里出现的编号一次批量读，不逐张查。
 */

type MovementRow = z.output<typeof rows.stock_movements>;
type StockItem = ReturnType<FlowService['ops']['repo']['items']>[number];

/**
 * 送货单详情的出库流水按行挂（和到货的 FlowService.arrivalRecords 同一个做法）：同一成品库存几行时，
 * 每行挂和它同一张订单、同样数量的那一笔出库；配不上的（管理员改过数、撤销扣回的）挂在这个库存品的第一行。
 * 同一笔只出现在一行，详情不重复列；不然前端同一个 key 出现两次，换单时会留下上一张的残行。
 * movementsOf 给出这张单这个库存品的出库、撤销流水（按 created_at,id 排好）。
 */
export function deliveryLineMovements(
  lines: readonly Pick<DeliveryLine, 'stockId' | 'quantity' | 'orderId'>[],
  movementsOf: (stockId: number) => MovementRow[],
) {
  const out = lines.map((): MovementRow[] => []);
  const first = new Map<number, number>();
  lines.forEach((l, i) => {
    if (!first.has(l.stockId)) first.set(l.stockId, i);
  });
  for (const [stockId, head] of first) {
    const movements = movementsOf(stockId),
      owner = new Map<MovementRow, number>();
    lines.forEach((l, i) => {
      if (l.stockId !== stockId) return;
      const units = quantityUnits(l.quantity);
      const m = movements.find(
        (m) => !owner.has(m) && m.source_kind === 'flow_delivery' && m.customer_order_id === l.orderId && -m.delta_units === units,
      );
      if (m) owner.set(m, i);
    });
    for (const m of movements) out[owner.get(m) ?? head].push(m);
  }
  return out;
}

/** 这批送货单的出库及冲销流水，一次取回，按“送货单:库存品”分组；同组按 created_at,id 排 */
function movementGroups(store: Store, deliveryIds: readonly number[]) {
  const groups = new Map<string, MovementRow[]>();
  for (const m of many(
    store.db,
    rows.stock_movements,
    "SELECT * FROM stock_movements WHERE source_kind IN ('flow_delivery','flow_reversal') AND source_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id",
    JSON.stringify(deliveryIds.map(String)),
  )) {
    const key = String(m.source_id) + ':' + m.item_id;
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}

/** 一行送货明细带上订单明细（品名、规格、订购和已发）、库存品（没快照时的品名规格）和挂的出库流水 */
function lineView(l: DeliveryLine, o: Order | undefined, stock: StockItem | undefined, movements: MovementRow[], shipped: ReadonlyMap<number, number>) {
  const ol = o?.lines.find((x) => x.id === l.orderLineId);
  const progress = ol && lineShippingProgress(ol.quantity, shipped.get(ol.id) ?? 0);
  const { taxRate: _rate, taxMode: _mode, taxText: _text, ...orderDetails } = ol ?? {};
  return {
    ...orderDetails,
    ...progress,
    ...l,
    orderNumber: l.orderNumber || o?.number,
    productName: l.productName || ol?.productName || stock?.name,
    specification: l.specification || ol?.specification || stock?.specification,
    unit: l.unit || ol?.unit || stock?.unit,
    orderedQuantity: ol?.quantity,
    movements,
  };
}

/**
 * 台账里的送货单。workbenchDate：今日页只要待送货、本月已出库、计划在这天的，不带流水；
 * flowIds：只组装这几张（按主键）；includeArchived 为真时已归档的也组装（点开一张已归档的详情）。
 */
export function deliveryRecords(
  store: Store,
  workbenchDate?: string,
  flowIds?: readonly number[],
  includeArchived = false,
): DeliveryDaily<MovementRow>[] {
  const flow = new FlowService(store);
  const deliveries = flow.list('delivery', includeArchived, workbenchDate, flowIds);
  const orderIds = [...new Set(deliveries.flatMap((d) => d.lines.map((l) => l.orderId)))];
  const orders = new Map(sales(store).ordersByIds(orderIds, true).map((o) => [o.id, o]));
  const shipped = shippedByLine(store.db, orderIds);
  const stocks = new Map(flow.ops.items(true, deliveries.flatMap((d) => d.lines.map((l) => l.stockId))).map((s) => [s.id, s]));
  const customers = new Map(
    many(
      store.db,
      rows.customers.pick({ id: true, name: true }),
      'SELECT id,name FROM customers WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(deliveries.map((d) => d.customerId)),
    ).map((c) => [c.id, c.name]),
  );
  const groups = !workbenchDate && deliveries.length ? movementGroups(store, deliveries.map((d) => d.id)) : null;
  return deliveries.map((d) => {
    const perLine = groups && deliveryLineMovements(d.lines, (stockId) => [...(groups.get(d.id + ':' + stockId) || [])]);
    return {
      ...d,
      customerName: customers.get(d.customerId) || '历史客户',
      completed: d.status === 'confirmed',
      pending: d.status === 'draft',
      cancelled: ['cancelled', 'reversed'].includes(d.status),
      lines: d.lines.map((l, index) => lineView(l, orders.get(l.orderId), stocks.get(l.stockId), perLine ? perLine[index] : [], shipped)),
    };
  });
}
