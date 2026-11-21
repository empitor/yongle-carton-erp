import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import { one, rows } from '../core/index.js';
import type { deliveryCorrectionPreviewSchema, FlowDocument } from '../../shared/business/index.js';
import type { Order } from '../../shared/core/index.js';
import { quantityString, quantityUnits } from '../../shared/core/index.js';
import { fail, type DeliveryLine, type FlowCommands } from './base.js';
import { shippedByLine, shippedUnits } from './shipped.js';
import { checkOverdelivery } from './validate-delivery.js';

/*
 * 更正送货单的逐行部分（方案在 delivery-correction-plan.ts）：更正后的每一行从哪来、订单现价变了的提示、
 * 只查数量变多的行超没超订单、每条订单明细的已发前后、预览里逐行的前后。
 */
export type DeliveryInput = z.infer<typeof deliveryCorrectionPreviewSchema>;
type InputLine = DeliveryInput['lines'][number];
type Stored = FlowDocument<'delivery'>;
/** 方案里取到的订单（原单和更正后各行挂的），按编号 */
export type Orders = Map<number, Order>;
/** 更正后的一行（还没按订单明细补全）：订单、订单明细、成品库存、数量、备注 */
type NextLine = Pick<DeliveryLine, 'orderId' | 'orderLineId' | 'stockId' | 'quantity' | 'notes'>;

const text = (units: number) => quantityString(units);
/** 每条订单明细的数量合计（千分整数） */
const sumByLine = (lines: readonly Pick<DeliveryLine, 'orderLineId' | 'quantity'>[]) => {
  const m = new Map<number, number>();
  for (const l of lines) m.set(l.orderLineId, (m.get(l.orderLineId) || 0) + quantityUnits(l.quantity));
  return m;
};

const lineRow = rows.order_lines.pick({ order_id: true, product_id: true });
const stockRow = rows.stock_items.pick({ id: true });
/** 订单明细在哪张订单上、出哪个成品库存（一个产品只有一个成品库存） */
function lineTarget(flow: FlowCommands, orderLineId: number) {
  const row = one(flow.store.db, lineRow, 'SELECT order_id,product_id FROM order_lines WHERE id=?', orderLineId);
  if (!row) return fail('订单明细不存在，请重新选择。');
  const stock = one(flow.store.db, stockRow, 'SELECT id FROM stock_items WHERE product_id=?', row.product_id);
  if (!stock) return fail('这条订单明细的产品还没有成品库存，不能发货。');
  return { orderId: row.order_id, stockId: stock.id };
}

/** 这一行沿用原单的哪一行（带 index 的；对不上、重复的报错），新加的行是 null */
function baseOf(stored: Stored, l: InputLine, used: Set<number>): DeliveryLine | null {
  if (l.index === undefined) return null;
  const base = stored.lines.at(l.index);
  if (!base) return fail('更正明细和原送货单对不上，请刷新后重填。', 409);
  if (used.has(l.index)) fail('更正明细重复。');
  used.add(l.index);
  return base;
}

/** 更正后的一行：没换订单明细的沿用原单那一行（kept），给了不同 orderLineId 的是换挂，没有 base 的是新加的 */
function nextLine(flow: FlowCommands, l: InputLine, base: DeliveryLine | null): { line: NextLine; kept: DeliveryLine | null } {
  if (base && (l.orderLineId === undefined || l.orderLineId === base.orderLineId))
    return {
      line: { orderId: base.orderId, orderLineId: base.orderLineId, stockId: base.stockId, quantity: l.quantity, notes: base.notes },
      kept: base,
    };
  if (l.orderLineId === undefined) return fail('新加的行要选订单明细。');
  return { line: { ...lineTarget(flow, l.orderLineId), orderLineId: l.orderLineId, quantity: l.quantity, notes: base?.notes ?? '' }, kept: null };
}

/** 更正后的每一行：带 index 的沿用原单那一行（给了不同的 orderLineId 是换挂），不带的是新加的行 */
export function replacementLines(flow: FlowCommands, stored: Stored, input: DeliveryInput) {
  const used = new Set<number>(),
    picked = input.lines.map((l) => nextLine(flow, l, baseOf(stored, l, used)));
  const changed =
    used.size !== stored.lines.length ||
    picked.some(({ line, kept }) => !kept || quantityUnits(line.quantity) !== quantityUnits(kept.quantity));
  return {
    lines: picked.map((p) => p.line),
    used,
    structural: picked.some((p) => !p.kept),
    changed,
  };
}

/**
 * 沿用的行留着出库时的单价（keepSnapshot），订单现价不一样时提示一句，说清这张单仍按出库时的价。
 * current 是按订单现在的明细补全的行（核对结果），kept 是替代单上的同一行
 */
export function shippedPriceWarnings(current: readonly DeliveryLine[], kept: readonly DeliveryLine[]) {
  return kept.flatMap((l, i) =>
    l.unitPriceExact === current[i].unitPriceExact
      ? []
      : ['订单 ' + l.orderNumber + ' 的“' + l.productName + '”单价现在是 ' + current[i].unitPriceExact + '，这张单仍按出库时的 ' + l.unitPriceExact + '。'],
  );
}

/** 订单明细和它所在的订单：方案按更正前后各行的订单都取过，核对过的行一定在；取不到是数据刚被改了 */
function orderLineOf(orders: Orders, lineId: number) {
  for (const order of orders.values()) {
    const line = order.lines.find((x) => x.id === lineId);
    if (line) return { order, line };
  }
  return fail('订单明细不存在，请刷新后重新核对。', 409);
}

/** 超订单发货只查数量变多的行（和新送货单同一句话、同一个规则）；变少的不卡历史超发 */
export function overdeliveryWarnings(
  flow: FlowCommands,
  actor: Actor,
  c: { lines: DeliveryLine[]; stored: Stored; orders: Orders; originalId: number; allow: { allowOverdelivery: boolean; overdeliveryReason: string } },
) {
  const before = sumByLine(c.stored.lines),
    warnings: string[] = [];
  for (const l of c.lines) {
    const quantity = quantityUnits(l.quantity);
    if (quantity <= (before.get(l.orderLineId) || 0)) continue;
    const { order, line } = orderLineOf(c.orders, l.orderLineId);
    const over = checkOverdelivery(actor, c.allow, { order, line, quantity, shipped: shippedUnits(flow.store.db, l.orderLineId, c.originalId) });
    if (over) warnings.push(over);
  }
  return warnings;
}

/** 每条订单明细的已发：现在的（含原单）− 原单 + 替代单 */
export function orderImpactOf(flow: FlowCommands, stored: Stored, lines: DeliveryLine[], orders: Orders) {
  const before = sumByLine(stored.lines),
    after = sumByLine(lines),
    shipped = shippedByLine(flow.store.db, [...orders.keys()]);
  return [...new Set([...before.keys(), ...after.keys()])].map((lineId) => {
    const { order: o, line: ol } = orderLineOf(orders, lineId),
      now = shipped.get(lineId) || 0;
    return {
      orderId: o.id,
      orderNumber: o.number,
      orderLineId: lineId,
      productName: ol.productName,
      unit: ol.unit,
      ordered: text(quantityUnits(String(ol.quantity))),
      before: text(now),
      after: text(now - (before.get(lineId) || 0) + (after.get(lineId) || 0)),
    };
  });
}

/** 预览里的一行：更正前后的数量、单价（换挂、新加的行是订单现价）、金额 */
function viewRow(l: DeliveryLine, index: number | null, quantity: { before: string | null; after: string }, amount: string | null | undefined) {
  return {
    index,
    orderId: l.orderId,
    orderNumber: l.orderNumber,
    orderLineId: l.orderLineId,
    productName: l.productName,
    unit: l.unit,
    before: quantity.before,
    after: quantity.after,
    unitPrice: l.unitPriceExact ?? null,
    amount: amount ?? null,
  };
}

/** 预览里逐行的前后：更正后的每一行，删掉的原单行更正后是 0 */
export function viewLines(lines: DeliveryLine[], stored: Stored, input: DeliveryInput, used: Set<number>) {
  return [
    ...lines.map((l, i) => {
      const index = input.lines[i].index ?? null,
        base = index === null ? undefined : stored.lines.at(index);
      return viewRow(l, index, { before: base ? text(quantityUnits(base.quantity)) : null, after: text(quantityUnits(l.quantity)) }, l.amountExact);
    }),
    ...stored.lines.flatMap((l, index) =>
      used.has(index) ? [] : [viewRow(l, index, { before: text(quantityUnits(l.quantity)), after: '0' }, '0')],
    ),
  ];
}
