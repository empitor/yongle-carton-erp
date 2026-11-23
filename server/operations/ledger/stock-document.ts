import { z } from 'zod';
import { parseStoredJson } from '../../core/index.js';
import { stockDocumentSchema } from '../../../shared/business/index.js';

/*
 * 库存品存进 document 列的内容（规格说明、长宽高、尺寸单位、材质、楞型、备注）：结构是共用的 stockDocumentSchema
 * （shared/business/operations/operations-stored.ts）。写（stock-items.ts、product-stock.ts）和读都按这一份。
 */
type StockDocument = z.output<typeof stockDocumentSchema>;

/** 读一个库存品的 document 列：对不上按库里的数据报（StoredDataError，回 500、记日志） */
export const readStockDocument = (text: string, stockId: number) =>
  parseStoredJson(stockDocumentSchema, text, 'stock_items.document（库存品 ' + stockId + '）');

/**
 * 要写进 document 列的文字：写之前按同一份结构核对。对不上是服务端自己拼错了内容，
 * 按服务端错误报（出错处理回 500、写进日志），不当成“输入不对”。which 说明是哪个库存品。
 */
export function stockDocumentText(document: StockDocument, which: string) {
  const checked = stockDocumentSchema.safeParse(document);
  if (!checked.success)
    throw new Error('库存品内容不合库里的结构，没有写入（' + which + '）：' + z.prettifyError(checked.error), {
      cause: checked.error,
    });
  return JSON.stringify(checked.data);
}
