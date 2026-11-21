// 产品改了名称、尺寸、材质、楞型、加工要求（规格说明由它们拼成），它的成品库存跟着改（登记点见 server/core/db.ts 的 registerProductStockSync）。由本模块的 index.ts 引入。
import { audit, one, registerProductStockSync, rows } from '../../core/index.js';
import { OperationsRepository } from '../ledger/repository.js';
import { readStockDocument, stockDocumentText } from '../ledger/stock-document.js';
import { finishedFromProduct } from './stock-items.js';

/** 按产品现在的资料对齐它的成品库存（没有成品库存就不动；跟着产品的几项没变也不动） */
export const syncFinishedStock: Parameters<typeof registerProductStockSync>[0] = (store, product, actor) => {
  const row = one(store.db, rows.stock_items.pick({ id: true, name: true, document: true }), 'SELECT id,name,document FROM stock_items WHERE product_id=?', product.id);
  if (!row) return;
  const { name, ...fields } = finishedFromProduct(product),
    stored = readStockDocument(row.document, row.id),
    current: Record<string, unknown> = stored;
  if (
    row.name === name &&
    Object.entries(fields).every(([k, v]) => JSON.stringify(current[k] ?? null) === JSON.stringify(v ?? null))
  )
    return;
  const repo = new OperationsRepository(store),
    before = repo.items(true, row.id)[0];
  // 只改跟着产品的几项（名称、尺寸、材质、楞型、规格说明）；备注不动。和库存品自己保存一样版本号加一，打开着的编辑窗保存时会提示刷新
  store.db
    .prepare('UPDATE stock_items SET name=?,document=?,updated_at=?,version=version+1 WHERE id=?')
    .run(name, stockDocumentText({ ...stored, ...fields }, '库存品 ' + row.id), new Date().toISOString(), row.id);
  if (actor)
    audit(store, actor, {
      action: 'update',
      entity: 'stock_items',
      id: row.id,
      document: {
        reason: '产品资料改了，成品库存的名称、尺寸、材质、楞型、规格跟着改',
        productId: product.id,
        before,
        after: repo.items(true, row.id)[0],
      },
    });
};
registerProductStockSync(syncFinishedStock);
