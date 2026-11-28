import { type OrderEditCheck } from '../../sales/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { FINISHED_UNIT, quantityString, quantityUnits, type Order } from '../../../shared/core/index.js';
import { InputError, exists, many } from '../../core/index.js';
import { shippedByLine } from '../documents/shipped.js';

/*
 * 订单服务按已有单据准备核对，保存订单时用补齐后的明细校验：
 * 已关联生产、送货记录的订单，普通修改不能改客户、产品明细、规格、数量，已有送货的不能改状态；
 * 本机管理员的数据维护可以改。改完的状态由改单连带处理
 * （server/orders/order-edit-cascade.ts 的 alignOrder）按全部单据重算一次（order-progress.ts 的 updateOrders）。
 */
export function orderEditGuard(db: DatabaseSync, previous: Order): OrderEditCheck | undefined {
  if (!exists(db, 'SELECT 1 FROM flow_refs WHERE order_id=? LIMIT 1', previous.id)) return undefined;
  const shipped = shippedByLine(db, [previous.id]);
  const sent = previous.lines.some((line) => (shipped.get(line.id) ?? 0) > 0);
  return (next) => {
    if (
      next.customerId !== previous.customerId ||
      next.lines.length !== previous.lines.length ||
      next.lines.some((l) => {
        const old = previous.lines.find((o) => o.id === l.id);
        return (
          !old ||
          old.productId !== l.productId ||
          old.quantity !== l.quantity ||
          old.unit !== l.unit ||
          old.specification !== l.specification
        );
      })
    )
      throw new InputError(
        '订单已关联生产/送货记录，不能改变客户、产品明细、规格、数量或单位。请通过后续更正单处理。',
      );
    if (sent && next.status !== previous.status)
      throw new InputError('已产生送货记录的订单状态由实际交付进度维护，请在送货管理更正。');
  };
}

/** 提示里最多列几张送货单，多的写“等 N 张” */
const LISTED_DELIVERIES = 5;
const deliveryRef = z.object({ lineId: z.number(), number: z.string() });
/** 这张订单每一行挂着哪些已出库的送货单（按单据先后，一次查齐） */
function shippedDeliveries(db: DatabaseSync, orderId: number) {
  const byLine = new Map<number, string[]>();
  for (const r of many(
    db,
    deliveryRef,
    "SELECT DISTINCT r.order_line_id AS lineId,d.number AS number,d.id FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.order_id=? AND r.order_line_id IS NOT NULL AND d.kind='delivery' AND d.status='confirmed' ORDER BY d.id",
    orderId,
  ))
    byLine.set(r.lineId, [...(byLine.get(r.lineId) ?? []), r.number]);
  return byLine;
}
/** 送货单号：最多列 5 张，多的写“等 N 张”；返回单号和“这张 / 这些”的说法 */
function deliveryNames(numbers: readonly string[]) {
  const listed = numbers.slice(0, LISTED_DELIVERIES).join('、') + (numbers.length > LISTED_DELIVERIES ? ' 等 ' + numbers.length + ' 张' : '');
  return { listed, these: numbers.length > 1 ? '这些送货单' : '这张送货单' };
}

/**
 * 本机管理员改订单（数据维护）的核对（用户定“两种都拦住”）：某一行已有已出库的送货，不许给这一行换产品；
 * 数量不许改得比已发的少。已出库只算已确认的送货单（含已送达；撤销了、被更正替代的不算，和 shippedByLine 同一个口径）。
 * 别的连带照旧：删掉整行、改大数量、改客户这些不拦；待送货单（没出库）引用的那一行换产品也不拦，出库时由送货核对拒下。
 * 改单之前取好已发数量和单号，订单服务把它传给 saveOrder，按补齐后的明细逐行核对，撞上几行就逐行说清楚。
 */
export function maintenanceEditGuard(db: DatabaseSync, previous: Order): OrderEditCheck {
  const shipped = shippedByLine(db, [previous.id]),
    numbers = shippedDeliveries(db, previous.id);
  return (next) => {
    const problems = next.lines.flatMap((l, i) => {
      const old = previous.lines.find((o) => o.id === l.id),
        sent = old ? (shipped.get(old.id) ?? 0) : 0;
      if (!old || !sent) return [];
      const head = '第 ' + (i + 1) + ' 行“' + old.productName + '”',
        unit = old.unit || FINISHED_UNIT,
        { listed, these } = deliveryNames(numbers.get(old.id) ?? []);
      if (l.productId !== old.productId)
        return [head + '已经出库 ' + quantityString(sent) + ' ' + unit + '（送货单 ' + listed + '），不能换产品。要换，先撤销' + these + '，再改订单。'];
      if (quantityUnits(String(l.quantity)) < sent)
        return [
          head + '已发 ' + quantityString(sent) + ' ' + unit + '，数量不能改成 ' + String(l.quantity) + ' ' + unit + '（比已发的少）。' +
            '要少发，先更正送货单 ' + listed + '，或者撤销' + these + '，再改订单。',
        ];
      return [];
    });
    if (problems.length) throw new InputError(problems.join(''));
  };
}
