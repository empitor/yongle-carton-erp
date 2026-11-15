import { z } from 'zod';
import type { AiProgress } from '../ai/index.js';
import { mappingSchema } from './import-mapping.js';
import { importTaskStates, orderDraftSchema, type ImportWorkspaceView } from './order-draft.js';
import { recognitionModes } from './workspace-inputs.js';

/*
 * 识别工作区视图的结构（服务端 server/import/workspace-store.ts 的 view() 交出来的那份，类型 ImportWorkspaceView）。
 * 不在接口表里的回答（上传原件收原始字节）页面按它认；结构和类型对不上 tsc 会报（下面标了 z.ZodType<…> 和 satisfies）。
 * 库里存的那份（server/import/workspace-document.ts）在它上面扩展：多存改动历史和操作记录（页面不该看到），
 * 任务、识别规则版本、到货关联上传时就写，库里必有；视图的类型 ImportWorkspaceView 里这几栏可省略，这里照类型写。
 */

/** 识别进度（事件流里的 progress、排队任务里的进度） */
export const aiProgressSchema: z.ZodType<AiProgress> = z.object({
  stage: z.enum(['connecting', 'processing', 'thinking', 'receiving', 'validating']),
  receivedChars: z.number(),
  reasoningChars: z.number().optional(),
  elapsedMs: z.number(),
});
const importedSchema = z.object({
  orderId: z.number(),
  orderNumber: z.string(),
  executionId: z.string(),
  archived: z.boolean(),
  permanentlyDeleted: z.boolean().optional(),
  historical: z.boolean().optional(),
  sourceId: z.string().optional(),
});
const taskSchema = z.object({
  state: z.enum(importTaskStates),
  startedAt: z.string().optional(),
  error: z.string().optional(),
  failureId: z.string().optional(),
  diagnosticStorageError: z.string().optional(),
  progress: aiProgressSchema.optional(),
  position: z.number().optional(),
  limit: z.number().optional(),
  attempt: z.number().optional(),
});
const evaluationSchema = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string(), severity: z.enum(['error', 'review']) })),
  lineAmounts: z.record(z.string(), z.string().nullable()),
  totalQuantity: z.string().nullable(),
  totalAmount: z.string().nullable(),
});
const changeSchema = z.object({
  path: z.string(),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  reason: z.string(),
  by: z.enum(['assistant', 'person']),
});

export const importWorkspaceViewSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  fileName: z.string(),
  fileHash: z.string(),
  size: z.number(),
  createdAt: z.string(),
  parsed: z.object({ format: z.enum(['xls', 'xlsx', 'docx', 'doc', 'pdf', 'png', 'jpg']) }),
  draft: orderDraftSchema.nullable(),
  archived: z.boolean().optional(),
  mode: z.enum(recognitionModes),
  arrivalDocId: z.number().nullable().optional(),
  arrivalSourceId: z.string().nullable().optional(),
  evaluation: evaluationSchema.nullable(),
  changes: z.array(changeSchema),
  canUndo: z.boolean(),
  mapping: mappingSchema.optional(),
  mappingInvalidated: z.object({ customer: z.string().optional(), products: z.record(z.string(), z.string()) }).optional(),
  task: taskSchema.optional(),
  promptVersion: z.string().optional(),
  promptPreset: z.object({ id: z.string(), name: z.string(), revision: z.number(), hash: z.string() }).optional(),
  imported: importedSchema.optional(),
  historyImport: importedSchema.optional(),
}) satisfies z.ZodType<ImportWorkspaceView>;
