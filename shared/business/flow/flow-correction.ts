import { z } from 'zod';
import { chosenId, dateSchema, exactPriceSchema, positiveQuantity, previewDigestSchema, quantityText } from '../../core/index.js';
import { noteText } from '../operations/operations.js';
import { arrivalDatedMessage, arrivalLineSchema } from './physical-flow.js';

/*
 * 更正已生效单据的输入（server/flow/correction.ts）：到货、送货、完工三种，各一份预览输入；
 * 提交时在同一份输入上加请求号和预览摘要（correctionCommit）。更正 = 撤销原单 + 另出一张替代单，流水只追加。
 * 明细都按“更正后整张单”写：带 index 的行是原单第几行（从 0 起），没写的内容沿用原单那一行；
 * 不带 index 的是新加的行；原单里没被引用的行就是删掉了。哪些人能改哪些内容由服务核对。
 */

const correctionHead = {
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1, '请填写更正原因').max(1000),
};
const lineIndex = z.number().int().min(0).optional();

/** 到货：业务账号改数量和验收数；日期、送货单号、供应商、单价、库存品、采购明细、增删行要本机管理员 */
export const arrivalCorrectionPreviewSchema = z.strictObject({
  ...correctionHead,
  date: dateSchema.optional(),
  reference: z.string().trim().min(1, arrivalDatedMessage).max(100).optional(),
  supplierId: chosenId('供应商').optional(),
  lines: z
    .array(
      z.strictObject({
        index: lineIndex,
        quantity: quantityText,
        acceptedQuantity: quantityText.optional(),
        rejectedQuantity: quantityText.optional(),
        stockedQuantity: quantityText.optional(),
        // 下面几项不写就是沿用原单那一行；写 null 是不关联
        stockId: chosenId('库存品', true).nullable().optional(),
        purchaseLineId: chosenId('采购明细', true).nullable().optional(),
        item: arrivalLineSchema.shape.item.optional(),
        unitPrice: exactPriceSchema.nullable().optional(),
        priceBasis: arrivalLineSchema.shape.priceBasis.unwrap().optional(),
      }),
    )
    .min(1, '至少要有一行明细')
    .max(100),
});

/**
 * 送货：业务账号改每行数量、删掉没发的行（至少留一行）；数量变多超出订单剩余的要超级管理员模式并写原因。
 * 改出库日期、把一行换挂到同一客户的另一条订单明细（orderLineId）、加行要本机管理员。
 */
export const deliveryCorrectionPreviewSchema = z.strictObject({
  ...correctionHead,
  date: dateSchema.optional(),
  allowOverdelivery: z.boolean().optional(),
  overdeliveryReason: noteText.optional(),
  lines: z
    .array(
      z.strictObject({
        index: lineIndex,
        quantity: positiveQuantity,
        orderLineId: chosenId('订单明细').optional(),
      }),
    )
    .min(1, '至少要留一行；整张没发生请用“撤销这次送货”')
    .max(100),
});

/**
 * 完工（超级管理员模式）：合格数、报废数、整张领料表（materials 给了就是更正后的全部领料，能加减行、换纸板）。
 * 改完工日期、产品、挂哪张生产任务（taskId 写 null 是不挂）要本机管理员。
 */
export const productionCorrectionPreviewSchema = z.strictObject({
  ...correctionHead,
  goodQuantity: quantityText.optional(),
  scrapQuantity: quantityText.optional(),
  materials: z
    .array(
      z.strictObject({
        index: lineIndex,
        stockId: chosenId('领用的库存品').optional(),
        issued: positiveQuantity,
        returned: quantityText.optional(),
      }),
    )
    .min(1, '至少要有一行领料')
    .max(100)
    .optional(),
  date: dateSchema.optional(),
  productId: chosenId('产品').optional(),
  taskId: chosenId('生产任务', true).nullable().optional(),
});

/** 提交更正：预览的输入加上请求号（防重复提交）和预览时拿到的摘要（核对影响没变） */
export const correctionCommit = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.extend({
    requestId: z.uuid(),
    previewDigest: previewDigestSchema,
  });
