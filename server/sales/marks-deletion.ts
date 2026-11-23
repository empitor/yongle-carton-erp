// 产品唛头资料（客户产品订单的表）在删除、初始化时怎么处理（登记接口见 server/core/records/deletion-rules.ts）。
// 由本模块的 index.ts 引入，加载客户产品订单时就登记（删除引擎不点模块名，按表查登记）。
import { registerReset, registerTableDeletion, textOf } from '../core/index.js';

registerTableDeletion({
  module: '客户产品订单',
  statements: {
    product_marks: { update: 'UPDATE product_marks SET', remove: 'DELETE FROM product_marks WHERE rowid=?' },
    mark_files: { update: 'UPDATE mark_files SET', remove: 'DELETE FROM mark_files WHERE rowid=?' },
  },
  // 影响清单里的叫法：唛头是“产品名 唛头标题”，原文件是文件名。
  // 规划时多读标题、文件名（文件内容不读）
  columns: { product_marks: ['title'], mark_files: ['file_name'] },
  label(table, row, g) {
    if (table === 'product_marks')
      return (textOf(g.byId('products').get(row.product_id)?.name) || '产品') + ' ' + (textOf(row.title) || '唛头');
    if (table === 'mark_files') return textOf(row.file_name) || undefined;
  },
  planners: [
    {
      // 没有唛头再用的文件一起删（只读文件指纹，不读文件内容）
      phase: 'after',
      order: 30,
      run(g) {
        const usedFiles = new Set(
          g
            .rows('product_marks')
            .filter((m) => !g.gone('product_marks', m))
            .map((m) => textOf(m.file_sha256)),
        );
        for (const file of g.rows('mark_files')) if (!usedFiles.has(textOf(file.sha256))) g.remove('mark_files', file);
      },
    },
  ],
});

registerReset({
  module: '客户产品订单',
  order: 10,
  statements: [
    'DELETE FROM product_marks',
    'DELETE FROM mark_files',
  ],
});
