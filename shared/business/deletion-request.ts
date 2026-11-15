import { z } from 'zod';
import { previewDigestSchema } from '../core/index.js';
import { dataManagementModules } from './data-management-modules.js';

/*
 * 业务界面删除（POST /deletions/preview、/deletions/execute）收什么、回什么：服务端删除引擎
 * （server/business/deletion-plan.ts、database-maintenance.ts）按它校验和读回，接口表 deletion-api.ts 照它写类型；
 * 助手的删除预览也用 deletionSelection。
 */

/** 一次最多删几条（页面批量删除、助手 records.delete 一次给几个编号，都是这个上限） */
export const DELETION_MAX_RECORDS = 100;
/** 选了哪些记录删：同一模块最多 DELETION_MAX_RECORDS 条，每条带读到时的版本号 */
export const deletionSelection = z.strictObject({
  module: z.enum(dataManagementModules),
  items: z
    .array(z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() }))
    .min(1)
    .max(DELETION_MAX_RECORDS),
  // 删掉动过库存的单据：默认库存一起改回（recalculate，当这张单子没发生过）；preserve 是备选：库存数量不动，它的流水留着、改成“系统维护”流水（来源 database-maintenance）
  inventoryPolicy: z.enum(['preserve', 'recalculate']).default('recalculate'),
});

/** 真删：在选了哪些之外带请求编号（防重复提交）和预览给的范围摘要（会连带别的记录时必须带，带了就要和现在的范围对上） */
export const deletionRequestSchema = deletionSelection.extend({
  requestId: z.uuid(),
  deletionDigest: previewDigestSchema.optional(),
});

/** 影响清单的一行（删除预览给界面和助手；删完的结果也带着它，同一请求重试时按它读回） */
export const impactRowSchema = z.object({
  table: z.string(),
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  action: z.enum(['delete', 'detach']),
  kind: z.string().optional(),
  direction: z.enum(['in', 'out']).optional(),
  partOf: z.string().optional(),
  keptBatch: z.string().optional(),
  removedMovements: z.enum(['in', 'out', 'both']).optional(),
  fields: z.array(z.string()).optional(),
});

/** 删完给页面、助手的结果；同一请求重试时按它读回上次的结果 */
export const deletionResultSchema = z.object({
  module: deletionSelection.shape.module,
  action: z.literal('delete'),
  count: z.number(),
  deleted: z.literal(true),
  impact: z.array(impactRowSchema),
  results: z.array(z.object({ id: z.number(), deleted: z.literal(true) })),
});
