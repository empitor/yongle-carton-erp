import { z } from 'zod';
import { purchaseReturnDocumentSchema, purchaseReturnStatuses, type purchaseReturnViewSchema } from '../../../shared/business/index.js';
import { parseStoredJson, rows } from '../../core/index.js';

/*
 * 采购退货单（purchase_returns）的行和内容。内容和视图的结构在 shared/business/flow-results.ts（接口表也引它）。
 * 写的地方：returns.ts 新建和撤销、maintenance-cascade.ts 解除采购明细、deletion.ts 删库存品和采购明细时清掉编号；
 * 读和写都按同一份结构（strictObject：多出的键算对不上）。
 */

export const returnRow = rows.purchase_returns.extend({ status: z.enum(purchaseReturnStatuses) });
type ReturnRow = z.output<typeof returnRow>;
export type ReturnDocument = z.output<typeof purchaseReturnDocumentSchema>;

/** 读一张退货单的内容：对不上按库里的数据报（StoredDataError，回 500、记日志） */
export const readReturnDocument = (row: { id: number; number: string; document: string }): ReturnDocument =>
  parseStoredJson(purchaseReturnDocumentSchema, row.document, 'purchase_returns.document（退货单 ' + row.id + '，单号 ' + row.number + '）');

/**
 * 要写进 document 列的文字：写之前按同一份结构核对。对不上是服务端自己拼错了内容，
 * 按服务端错误报（出错处理回 500、写进日志），不当成“输入不对”。which 说明是哪张退货单。
 */
export function returnDocumentText(document: ReturnDocument, which: string) {
  const checked = purchaseReturnDocumentSchema.safeParse(document);
  if (!checked.success)
    throw new Error('退货单内容不合库里的结构，没有写入（' + which + '）：' + z.prettifyError(checked.error), { cause: checked.error });
  return JSON.stringify(checked.data);
}

/** 一行退货单组装成视图（接口、助手看到的样子）；内容另外读过了就传进来，不再读一遍 */
export function returnViewOf(r: ReturnRow, document = readReturnDocument(r)): z.output<typeof purchaseReturnViewSchema> {
  return {
    id: r.id,
    number: r.number,
    arrivalId: r.arrival_id,
    date: r.date,
    status: r.status,
    version: r.version,
    actorName: r.actor_name,
    createdAt: r.created_at,
    ...document,
  };
}
