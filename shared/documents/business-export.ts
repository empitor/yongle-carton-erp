import { z } from 'zod';
import { MAX_BATCH_PURCHASES, MAX_SCHEDULE_ENTRIES, scheduleEntrySchema } from '../business/index.js';
import { documentKinds, templateIdSchema, templateSchema } from './document-templates.js';
/*
 * 单据导出收的请求（服务端 server/documents 先按这里校验，接口表 documents-api.ts 照这里的输入写）。
 */
/** 预览时模板编号最长几个字（一份订货单最多合几张采购单、到货安排最多几段是共用-业务的 MAX_BATCH_PURCHASES、MAX_SCHEDULE_ENTRIES）。 */
const MAX_PREVIEW_TEMPLATE_ID = 80;
/** 导出文件的格式：Word、Excel */
export const documentFormats = ['docx', 'xlsx'] as const;
export type DocumentFormat = (typeof documentFormats)[number];

const recordId = z.number().int().positive();
const mergedPurchaseIds = z.array(recordId).min(1).max(MAX_BATCH_PURCHASES);
const exportSchedule = z.array(scheduleEntrySchema).max(MAX_SCHEDULE_ENTRIES);
const previewTemplateId = z.string().max(MAX_PREVIEW_TEMPLATE_ID);

export const documentExportSchema = z
  .strictObject({
    kind: z.enum(documentKinds),
    id: recordId,
    format: z.enum(documentFormats),
    templateId: templateIdSchema.optional(),
    markOrdered: z.boolean().default(false),
    /** 送货单：导出就是装车出库，完整交付后核对出库（扣库存），送货单变“送货中” */
    markShipped: z.boolean().default(false),
    expectedVersion: recordId,
    /** 几张采购单合在一份订货单里：每张的编号和版本（含 id 那张）。不传就是只有 id 这一张。 */
    purchases: z
      .array(z.strictObject({ id: recordId, version: recordId }))
      .min(1)
      .max(MAX_BATCH_PURCHASES)
      .optional(),
    /** 到货安排：每行几段“数量 + 截止日期（可空）”，印在订货单上，交付完成后存进订货批次 */
    schedule: exportSchedule.optional(),
    requestId: z.uuid(),
  })
  .refine((v) => !v.markOrdered || v.kind === 'purchase', '只有采购订货单可以标记已订货')
  .refine((v) => !v.markShipped || v.kind === 'delivery', '只有送货单可以导出出库');

/** 几张采购单合在一份订货单里的预览（还没导出时）：和导出时生成的是同一份内容 */
export const batchPreviewSchema = z.strictObject({
  purchaseIds: mergedPurchaseIds,
  schedule: exportSchedule.optional(),
  templateId: previewTemplateId.optional(),
});
/**
 * 预览 Word 排版：订货单传 purchaseIds（一张或几张，可带到货安排），送货单传 id；
 * shipping 和送货单预览一样，按导出并出库后印出来的样子。
 */
export const previewFileSchema = z.discriminatedUnion('kind', [
  batchPreviewSchema.extend({ kind: z.literal('purchase') }),
  z.strictObject({
    kind: z.literal('delivery'),
    id: recordId,
    templateId: previewTemplateId.optional(),
    shipping: z.boolean().optional(),
  }),
]);
/**
 * 单张单据预览的查询参数：templateId 不给或给空用默认模板；shipping=1 按导出并出库后印出来的样子，
 * 别的取值当没给。别的查询参数不看。
 */
export const documentPreviewQuerySchema = z.object({
  templateId: z.string().optional(),
  shipping: z.enum(['1']).optional().catch(undefined),
});
/** 按当前（可能还没保存的）模板排虚构测试样张：预览内容只收模板，样张文件还要格式 */
export const templatePreviewSchema = z.object({ template: templateSchema });
export const templateSampleSchema = templatePreviewSchema.extend({ format: z.enum(documentFormats) });
/** 文件完整下载、校验过以后交回执：文件内容的 SHA-256（64 位小写十六进制） */
export const exportCompleteSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) });
