import { type OrderEditCheck } from '../../sales/index.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Order } from '../../../shared/core/index.js';
import { InputError, exists } from '../../core/index.js';
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
