// 客户、产品、订单和明细的删除、初始化规则，由 sales/index.ts 加载时登记。
import type { Product } from '../../shared/core/index.js';
import { audit, registerRecordKinds, registerReset, registerTableDeletion, type DeletionRow } from '../core/index.js';
import { sales } from './records.js';

registerRecordKinds('客户产品订单', ['customers', 'products', 'orders']);

/** 删除客户置空产品归属前先记下修改前的产品，紧接着在 afterUpdate 同一事务里写修改历史审计 */
const detachedProducts = new WeakMap<DeletionRow, Product>();

registerTableDeletion({
  module: '客户产品订单',
  statements: {
    customers: { update: 'UPDATE customers SET', remove: 'DELETE FROM customers WHERE rowid=?' },
    customer_sites: { update: 'UPDATE customer_sites SET', remove: 'DELETE FROM customer_sites WHERE rowid=?' },
    products: { update: 'UPDATE products SET', remove: 'DELETE FROM products WHERE rowid=?' },
    orders: { update: 'UPDATE orders SET', remove: 'DELETE FROM orders WHERE rowid=?' },
    order_lines: { update: 'UPDATE order_lines SET', remove: 'DELETE FROM order_lines WHERE rowid=?' },
  },
  // 影响清单里订单明细叫“订单号 产品名”，规划时多读产品名
  columns: { order_lines: ['product_name'] },
  label(table, row, g) {
    if (table === 'order_lines') {
      const order = g.byId('orders').get(row.order_id);
      return [order?.number, row.product_name].filter(Boolean).join(' ') || undefined;
    }
  },
  beforeUpdate(store, _ctx, table, row, values) {
    if (table !== 'products' || !Object.hasOwn(values, 'customer_id') || values.customer_id !== null) return;
    const before = sales(store).product(Number(row.id), true);
    if (before) detachedProducts.set(row, before);
  },
  // 附属于被删产品的别的产品（parent_product_id）和被删客户名下的产品（customer_id）：
  // 删除引擎的通用步骤会把它置空、版本号加一（删除前打开着的编辑窗保存时会提示刷新，不会把解除掉的关联又写回去）。
  // 这里把修改时间也带上；若置空了所属客户，在同一事务内补写产品的修改历史审计。
  afterUpdate(store, ctx, table, row) {
    if (table !== 'products') return;
    store.db.prepare('UPDATE products SET updated_at=? WHERE rowid=?').run(ctx.at, row.__rowid);
    const before = detachedProducts.get(row);
    if (!before) return;
    detachedProducts.delete(row);
    const after = sales(store).product(Number(row.id), true);
    if (!after) return;
    audit(store, ctx.actor, {
      action: 'update',
      entity: 'products',
      id: after.id,
      document: {
        before,
        after,
        reason: '删除客户后解除产品归属',
        trigger: { action: 'delete', entity: 'customers', id: before.customerId, name: before.customerName },
        requestId: ctx.mark.requestId,
      },
    });
  },
  planners: [
    {
      // 明细全删光的订单一起删
      phase: 'cascade',
      order: 70,
      run(g) {
        if (!g.ids('order_lines').size) return;
        let progress = false;
        const linedOrders = new Set(
          g
            .rows('order_lines')
            .filter((l) => !g.gone('order_lines', l))
            .map((l) => l.order_id),
        );
        for (const order of g.rows('orders'))
          if (!g.gone('orders', order) && !linedOrders.has(order.id)) progress = g.remove('orders', order) || progress;
        return progress;
      },
    },
  ],
});

registerReset({
  module: '客户产品订单',
  order: 50,
  statements: [
    'DELETE FROM order_lines',
    'DELETE FROM orders',
    'DELETE FROM products',
    'DELETE FROM customer_sites',
    'DELETE FROM customers',
  ],
});
