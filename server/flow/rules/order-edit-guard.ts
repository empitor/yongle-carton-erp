import type { DatabaseSync } from 'node:sqlite';
import { InputError, exists, type OrderEditGuard } from '../../core/index.js';
import { shippedByLine } from '../documents/shipped.js';

/*
 * 改已有订单前按单据核对（Store.saveOrder 调，接口见 server/core/order-hooks.ts）：
 * 已关联生产、送货记录的订单，普通修改不能改客户、产品明细、规格、数量，已有送货的不能改状态；
 * 本机管理员的数据维护（maintenance）可以改，但明细编号要是这张单的。改完的状态由改单连带处理
 * （server/business/order-edit-cascade.ts 的 alignOrder）按全部单据重算一次（order-progress.ts 的 updateOrders）。
 */
export function orderEditGuard(db: DatabaseSync, maintenance = false): OrderEditGuard {
  return (id, previous, next) => {
    const linked = exists(db, 'SELECT 1 FROM flow_refs WHERE order_id=? LIMIT 1', id);
    if (!linked || !previous) return { linked };
    if (maintenance) {
      const ids = next.lines.map((l) => l.id).filter(Boolean);
      if (new Set(ids).size !== ids.length || ids.some((lineId) => !previous.lines.some((l) => l.id === lineId)))
        throw new InputError('明细编号重复或不属于当前订单。');
      return { linked, removeMissingLines: true };
    }
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
    const shipped = shippedByLine(db, [id]);
    if (previous.lines.some((l) => (shipped.get(Number(l.id)) || 0) > 0) && next.status !== previous.status)
      throw new InputError('已产生送货记录的订单状态由实际交付进度维护，请在送货管理更正。');
    return { linked };
  };
}
