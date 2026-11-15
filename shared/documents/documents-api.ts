import type { z } from 'zod';
import type {
  batchPreviewSchema,
  documentExportSchema,
  documentPreviewQuerySchema,
  exportCompleteSchema,
  templatePreviewSchema,
} from './business-export.js';
import type { BusinessForm } from './business-form.js';
import type { DocumentTemplateState, templateSettingsSchema } from './document-templates.js';
import type { DocumentExportStatus } from './export-record.js';

/*
 * 单据导出的接口表（服务端 server/documents/router.ts，挂在 /api/documents 下）。表的写法见 shared/core/api-table.ts。
 * 回文件内容的三个地址不是 JSON 来回，不在表里，照旧用 express 注册：
 * POST /documents/preview-file（预览 Word 排版）、POST /documents/templates/sample（测试样张）、GET /documents/:id/file（导出文件）。
 */
export type DocumentsApi = {
  'GET /documents/preview/:kind/:id': { query?: z.input<typeof documentPreviewQuerySchema>; response: BusinessForm };
  'POST /documents/preview-batch': { body: z.input<typeof batchPreviewSchema>; response: BusinessForm };
  'GET /documents/templates': { response: DocumentTemplateState };
  'POST /documents/templates': { body: z.input<typeof templateSettingsSchema>; response: DocumentTemplateState };
  'POST /documents/templates/preview': { body: z.input<typeof templatePreviewSchema>; response: BusinessForm };
  'POST /documents': { body: z.input<typeof documentExportSchema>; response: DocumentExportStatus };
  'GET /documents/:id': { response: DocumentExportStatus };
  'POST /documents/:id/complete': { body: z.input<typeof exportCompleteSchema>; response: DocumentExportStatus };
};
