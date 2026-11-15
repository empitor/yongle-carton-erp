// 基础模块自己的表在删除、初始化时怎么处理（登记接口见 deletion-rules.ts）。由 core/index.ts 引入，加载基础模块时就登记。
import { registerReset, registerTableDeletion } from './deletion-rules.js';

registerTableDeletion({
  module: '基础',
  statements: {
    customers: { update: 'UPDATE customers SET', remove: 'DELETE FROM customers WHERE rowid=?' },
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
  // 附属于被删产品的别的产品：附属关系是可以为空的外键（products.parent_product_id），删除引擎的通用步骤会把它置空、
  // 版本号加一（删除前打开着的编辑窗保存时会提示刷新，不会把解除掉的关联又写回去）。这里把修改时间也带上。
  afterUpdate(store, ctx, table, row) {
    if (table === 'products') store.db.prepare('UPDATE products SET updated_at=? WHERE rowid=?').run(ctx.at, row.__rowid);
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
  module: '基础',
  order: 50,
  statements: [
    'DELETE FROM record_lifecycle',
    'DELETE FROM order_lines',
    'DELETE FROM orders',
    'DELETE FROM products',
    'DELETE FROM customers',
    // 单据模板设置在自己的表里（document_template_settings），按天的流水号计数（number_sequences）也不清：单号不回头
    'DELETE FROM operation_requests',
  ],
});
