import type { z } from 'zod';
import type { ArchiveResult } from '../core/index.js';
import type { ArrivalSource } from './arrival-source.js';
import type { ImportFailureRecord } from './failure-record.js';
import type { ImportPreview, ImportReceipt, StandardOrderCheck } from './import-plan.js';
import type { ImportMatchData } from './import-matching.js';
import type { ImportWorkspaceView } from './order-draft.js';
import type { ImportList } from './workspace-list.js';
import type {
  arrivalLinkSchema,
  diagnosticsQuerySchema,
  importExecuteSchema,
  workspaceArchiveInputSchema,
  workspaceDeleteSchema,
  workspaceEditSchema,
  workspaceEnqueueSchema,
  workspaceMappingSchema,
  workspaceModeSchema,
  workspaceRevisionSchema,
} from './workspace-inputs.js';

/*
 * AI 导入工作区的接口表（服务端 server/import/router.ts、arrival-router.ts、workspace-admin-router.ts，挂在 /api/ai/imports 下；
 * 到货原件的识别记录 receipt-router.ts 挂在 /api/flow 下）。表的写法见 shared/core/api-table.ts。
 * 不在表里的几条照旧由 express 直接注册：上传（收原始字节）、下载原件（回文件）、识别（边收边推进度）、错误档案下载（带下载头）。
 * 写入要带工作区自己的页面凭证（请求头 X-ERP-AI-Token，凭证在列表的 csrfToken 里）。
 */
type Revision = z.input<typeof workspaceRevisionSchema>;
type Workspace = ImportWorkspaceView;
/** 错误档案一页 */
type FailurePage = { items: ImportFailureRecord[]; total: number; offset: number; limit: number };

export type ImportsApi = {
  'GET /ai/imports': { response: ImportList };
  'GET /ai/imports/diagnostics': { query?: z.input<typeof diagnosticsQuerySchema>; response: FailurePage };
  'POST /ai/imports/batch': { body: z.input<typeof workspaceArchiveInputSchema>; response: ArchiveResult<string> };
  /** 永久删除的逐份结果和批量归档同一个样子 */
  'POST /ai/imports/delete-many': { body: z.input<typeof workspaceDeleteSchema>; response: ArchiveResult<string> };
  'GET /ai/imports/:id': { response: Workspace };
  'POST /ai/imports/:id/mode': { body: z.input<typeof workspaceModeSchema>; response: Workspace };
  'POST /ai/imports/:id/enqueue': { body: z.input<typeof workspaceEnqueueSchema>; response: Workspace };
  'POST /ai/imports/:id/edit': { body: z.input<typeof workspaceEditSchema>; response: Workspace };
  'POST /ai/imports/:id/undo': { body: Revision; response: Workspace };
  'POST /ai/imports/:id/mapping': { body: z.input<typeof workspaceMappingSchema>; response: Workspace };
  'POST /ai/imports/:id/cancel': { body: Revision; response: Workspace };
  'GET /ai/imports/:id/matches': { response: ImportMatchData };
  'POST /ai/imports/:id/arrival/link': { body: z.input<typeof arrivalLinkSchema>; response: Workspace };
  'GET /ai/imports/:id/standard-order': { response: StandardOrderCheck };
  'POST /ai/imports/:id/preview': { body: Revision; response: ImportPreview };
  'POST /ai/imports/:id/execute': { body: z.input<typeof importExecuteSchema>; response: ImportReceipt };
  'GET /flow/sources/:sourceId': { response: ArrivalSource };
};
