// 识别导入的表在删除、初始化时怎么处理（登记接口见 server/core/deletion-rules.ts）。由本模块的 index.ts 引入。
import { many, parseStoredJson, registerRecordDeletion, registerReset, registerTableDeletion, rows } from '../core/index.js';
import { receiptForMarking } from './import-receipt.js';

const receiptRow = rows.import_executions.pick({ id: true, document: true });

registerTableDeletion({
  module: '识别导入',
  statements: {
    // 导入记录引用的订单删了，只解除引用（外键可以为空），导入记录和原件凭据保留
    import_executions: { update: 'UPDATE import_executions SET', remove: 'DELETE FROM import_executions WHERE rowid=?' },
  },
  // 影响清单里按导入出来的订单号称呼（表名“导入记录”由界面显示），不露导入记录的内部编号
  label(table, row, g) {
    if (table !== 'import_executions') return undefined;
    const number = g.byId('orders').get(row.order_id)?.number;
    return typeof number === 'string' && number ? number : '没有关联订单';
  },
});

// 订单删掉前：从它导入的记录标上“已永久删除”（谁、什么时候、哪次删除），并解除引用。
// 包括还挂着这张订单的和这次删除里刚被解除引用的（导入记录只在删订单时解除引用，订单编号不复用）。
registerRecordDeletion('识别导入', 'orders', (store, ctx, orderId) => {
  const justDetached = ctx
    .updated('import_executions')
    .filter((r) => r.order_id === orderId)
    .map((r) => r.id);
  const receipts = many(
    store.db,
    receiptRow,
    'SELECT id,document FROM import_executions WHERE order_id=? OR id IN (SELECT value FROM json_each(?))',
    orderId,
    JSON.stringify(justDetached),
  );
  for (const receipt of receipts) {
    const doc = parseStoredJson(receiptForMarking, receipt.document, `import_executions.document（${receipt.id}）`);
    doc.permanentDeletion = { ...ctx.mark };
    store.db
      .prepare('UPDATE import_executions SET order_id=NULL,document=? WHERE id=?')
      .run(JSON.stringify(doc), receipt.id);
  }
});

registerReset({
  module: '识别导入',
  order: 20,
  statements: [
    'DELETE FROM inbox_items',
    'DELETE FROM inbox_files',
    'DELETE FROM import_executions',
  ],
});
