import { batchKeysFor, flowInput, type FlowDocView } from '../../shared/business/index';
import { quantityString, quantityUnits } from '../../shared/core/index';
import type { FlowEditor } from '../flow/index';

/**
 * 到货识别结果核对的几条规则：比较改没改过、能不能改、挂订货单时交给服务端的行。只算不渲染，不依赖 React。
 * 识别完资料齐的直接登记成待入库到货单，之后改的都是这张到货单本身（表单用单据流转的到货表单）。
 */

/**
 * 核对中的到货单：单据流转的到货表单（FlowEditor 的到货那一种）改的内容，加上挂哪份订货单、是不是“不挂采购单”
 * （withoutPurchase，只在核对时用，不存）。
 */
export type ArrivalEditing = Extract<Parameters<typeof FlowEditor>[0], { kind: 'arrival' }>['value'];

/** 打开已存的到货单核对：没挂订货单的就是不挂采购单的货，不再列“要补订货单” */
export const reopenArrival = (saved: FlowDocView<'arrival'>): ArrivalEditing => ({
  ...structuredClone(saved),
  withoutPurchase: !saved.orderBatchId,
});

/** 服务端回来的单据要是到货单（保存、读、核对入库到货单回的） */
export function arrivalDoc(doc: FlowDocView): FlowDocView<'arrival'> {
  if (doc.kind !== 'arrival') throw new Error('回来的单据不是到货单，请刷新后查看。');
  return doc;
}

/** 用来比较“改没改过”的写法：按到货单要存的内容整理后再比，整理不了（资料还不全）就原样比。 */
export function arrivalValue(value: unknown) {
  try {
    return JSON.stringify(flowInput('arrival', value));
  } catch {
    // 资料还不全时整理不了，这时原样比，不是出错
    return JSON.stringify(value);
  }
}

/** 能不能改：还没登记成到货单的、待入库没归档的可以改；已入库的用“更正到货单”。 */
export function arrivalEditable(doc: { status?: string; archived?: boolean } | null | undefined) {
  return !doc || (doc.status === 'draft' && !doc.archived);
}

/** 到货的一行：纸板（对订货单的行）、实到、合格、不合格、实际入库（空着按默认算） */
type ReceivedLine = Parameters<typeof batchKeysFor>[0][number] & {
  quantity: string;
  acceptedQuantity?: string | null;
  rejectedQuantity?: string | null;
  stockedQuantity?: string | null;
};
/**
 * 挂了订货单的识别结果存成待入库到货单时交给服务端的行（POST /api/order-batches/:id/receive 的 rows）：
 * 每行按订货单对上行键（batchKeysFor），同一行键的实到、不合格相加；有人填了实际入库的那一组才带入库数，
 * 没填的按合格数。有的行在订货单里对不上返回 null。
 */
export function batchReceiveRows(lines: readonly ReceivedLine[], batch: Parameters<typeof batchKeysFor>[1]) {
  const keys = batchKeysFor(lines, batch);
  if (!keys) return null;
  const units = (v: string | null | undefined) => (v == null || v === '' ? null : quantityUnits(v));
  const sums = new Map<string, { quantity: number; rejected: number; stocked: number; stockedGiven: boolean }>();
  lines.forEach((l, i) => {
    const quantity = units(l.quantity) ?? 0,
      accepted = units(l.acceptedQuantity),
      rejected = units(l.rejectedQuantity) ?? (accepted === null ? 0 : quantity - accepted),
      stocked = units(l.stockedQuantity);
    const sum = sums.get(keys[i]) || { quantity: 0, rejected: 0, stocked: 0, stockedGiven: false };
    sum.quantity += quantity;
    sum.rejected += rejected;
    sum.stocked += stocked ?? quantity - rejected;
    sum.stockedGiven ||= stocked !== null;
    sums.set(keys[i], sum);
  });
  return [...sums].map(([key, s]) => ({
    key,
    quantity: quantityString(s.quantity),
    rejectedQuantity: quantityString(s.rejected),
    ...(s.stockedGiven ? { stockedQuantity: quantityString(s.stocked) } : {}),
  }));
}
