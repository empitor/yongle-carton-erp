import type { z } from 'zod';
import type { deliveryCorrectionPreviewSchema, FlowDocView } from '../../shared/business/index';

/**
 * 更正送货单的输入：整理成服务端 POST /api/flow/:id/correction-preview、/correct 要的格式
 * （shared/business/flow-correction.ts 的 deliveryCorrectionPreviewSchema）。只算数据，不发请求、不依赖 React。
 *
 * - lines 是更正后整张单：带 index 的是原单那一行（只写数量，换挂了另写 orderLineId）；不带的是新加的行（要 orderLineId）；
 *   原单里没出现的行就是删掉（这一行其实没发）。
 * - 出库日期、换挂、加行只有本机管理员能做；增加数量超出订单剩余的要勾“允许超出订单数量”并写原因（超级管理员模式）。
 */

/** 交给服务端的输入（核验、提交同一份；提交时另加请求号和预览摘要） */
type DeliveryCorrectionBody = z.input<typeof deliveryCorrectionPreviewSchema>;
type BodyLine = DeliveryCorrectionBody['lines'][number];
/** 送货单里用到的：版本、出库日期，每行的数量和挂的订单明细 */
type DeliverySource = Pick<FlowDocView<'delivery'>, 'version' | 'date'> & {
  lines: Pick<FlowDocView<'delivery'>['lines'][number], 'quantity' | 'orderLineId'>[];
};

export type DeliveryRow = {
  /** 原单第几行；新加的行没有 */
  index?: number;
  quantity: string;
  /** 挂哪条订单明细（原单那一行的，或管理员换挂、新加的） */
  orderLineId: number | null;
};
export type DeliveryHead = { date: string; allowOverdelivery: boolean; overdeliveryReason: string };

const text = (v: unknown) => (v == null ? '' : String(v));

/** 打开窗口时的样子：原单每一行 */
export const deliveryRows = (doc: DeliverySource): DeliveryRow[] =>
  doc.lines.map((l, index) => ({ index, quantity: text(l.quantity), orderLineId: l.orderLineId }));
export const deliveryHead = (doc: DeliverySource): DeliveryHead => ({ date: text(doc.date), allowOverdelivery: false, overdeliveryReason: '' });
/** 管理员新加的一行：先选订单明细 */
export const newDeliveryRow = (): DeliveryRow => ({ quantity: '', orderLineId: null });

/** 交给服务端的输入，和这次有没有改东西（没改不去核验） */
export function deliveryCorrectionInput(
  doc: DeliverySource,
  head: DeliveryHead,
  rows: DeliveryRow[],
  reason: string,
): { input: DeliveryCorrectionBody; changed: boolean } {
  const original = doc.lines;
  let changed = rows.length !== original.length;
  const lines = rows.map((r): BodyLine => {
    const o = r.index === undefined ? null : original[r.index];
    const quantity = r.quantity.trim();
    if (!o || quantity !== text(o.quantity)) changed = true;
    // 换挂了（或新加的行选了）订单明细才写
    const relinked = r.orderLineId != null && r.orderLineId !== (o?.orderLineId ?? null) ? r.orderLineId : null;
    if (relinked != null) changed = true;
    return { ...(o ? { index: r.index } : {}), quantity, ...(relinked != null ? { orderLineId: relinked } : {}) };
  });
  const top: Pick<DeliveryCorrectionBody, 'date' | 'allowOverdelivery' | 'overdeliveryReason'> = {};
  if (head.date && head.date !== text(doc.date)) {
    top.date = head.date;
    changed = true;
  }
  if (head.allowOverdelivery) {
    top.allowOverdelivery = true;
    top.overdeliveryReason = head.overdeliveryReason.trim();
  }
  return { input: { expectedVersion: doc.version, reason: reason.trim(), ...top, lines }, changed };
}
