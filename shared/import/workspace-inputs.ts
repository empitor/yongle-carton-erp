import { z } from 'zod';
import { archiveInputSchema, previewDigestSchema } from '../core/index.js';
import { mappingSchema } from './import-mapping.js';
import { patchOperationSchema } from './order-draft.js';

/*
 * 识别工作区接口收的正文和查询参数（服务端 server/import 按它们校验，接口表 imports-api.ts 照它们的输入写类型）。
 * 改识别结果、换类型都带打开时的版本号，别人先改过就拒绝。
 */

/** 识别类型：客户订单、供应商到货单 */
export const recognitionModes = ['order', 'arrival'] as const;
export type RecognitionMode = (typeof recognitionModes)[number];
/** 工作区编号是 UUID，版本号从 0 起 */
export const workspaceId = z.uuid();
export const WORKSPACE_FIRST_VERSION = 0;
/** 识别原件最多多少兆：服务端收文件、页面上传前都按它 */
export const ORIGINAL_MAX_MB = 10;
/** 一次最多改几处识别结果（页面和助手同一个上限）、最多永久删除几份 */
export const MAX_DRAFT_OPERATIONS = 100;
const MAX_DELETE = 200;
/** 正式导入时页面上勾了“是另一个产品”的行最多几行、每个行编号多长 */
const DISTINCT_MAX = 500;
const LINE_ID_MAX = 100;
/** 错误档案一页几条（服务端按它分页，页面按它翻）、翻页的偏移上限 */
export const FAILURE_PAGE = 50;
const MAX_OFFSET = 1_000_000;

export const workspaceRevisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
export const workspaceModeSchema = workspaceRevisionSchema.extend({ mode: z.enum(recognitionModes) });
export const workspaceEnqueueSchema = workspaceRevisionSchema.extend({ stream: z.boolean().default(true) });
export const workspaceEditSchema = workspaceRevisionSchema.extend({
  operations: z.array(patchOperationSchema).min(1).max(MAX_DRAFT_OPERATIONS),
});
export const workspaceMappingSchema = workspaceRevisionSchema.extend({ mapping: mappingSchema });
/** 把识别结果关联到登记好的到货单（docId 为 null 是解除），可以顺带记下到货原件 */
export const arrivalLinkSchema = workspaceRevisionSchema.extend({
  docId: z.number().int().positive().nullable(),
  sourceId: z.uuid().nullable().optional(),
});
/** 按导入预览正式导入：带回预览时识别结果的版本号和预览摘要，确认看过了 */
export const importExecuteSchema = workspaceRevisionSchema.extend({
  previewDigest: previewDigestSchema,
  acknowledged: z.literal(true),
  // 页面上勾了“是另一个产品”的行（已有同名、尺寸或材质不同的新产品）
  distinctProducts: z.array(z.string().max(LINE_ID_MAX)).max(DISTINCT_MAX).default([]),
});
/** 归档、恢复识别文件（和档案、单据的批量归档同一个写法） */
export const workspaceArchiveInputSchema = archiveInputSchema(workspaceId, WORKSPACE_FIRST_VERSION);
/** 批量永久删除 */
export const workspaceDeleteSchema = z.object({
  items: z.array(z.object({ id: workspaceId, version: z.number().int() })).min(1).max(MAX_DELETE),
});
/** 错误档案列表：只看一份工作区的，按偏移翻页 */
export const diagnosticsQuerySchema = z.object({
  workspaceId: workspaceId.optional(),
  offset: z.coerce.number<number | string>().int().min(0).max(MAX_OFFSET).default(0),
});
