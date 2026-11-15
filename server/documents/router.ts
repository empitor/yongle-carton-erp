import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AuthManager, Store } from '../core/index.js';
import { AppError, requirePermission, route } from '../core/index.js';
import {
  documentKinds,
  documentPreviewQuerySchema,
  exportCompleteSchema,
  templatePreviewSchema,
  templateSampleSchema,
  type DocumentFormat,
  type DocumentsApi,
} from '../../shared/documents/index.js';
import { BusinessDocuments } from './service.js';
import { DocumentTemplateSettings } from './settings.js';
import { sampleDocument } from './sample.js';
import { renderBusinessForm } from './render.js';

/*
 * 单据导出的地址（挂在 /api/documents 下，接口表 shared/documents/documents-api.ts）。
 * 回文件内容的三个地址（预览 Word 排版、测试样张、导出文件）不是 JSON 来回，照旧用 express 注册。
 * 注册顺序就是匹配顺序：/templates 要排在 /:id 前面。
 */
const mime: Record<DocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
/** 回文件内容：带文件名的是下载（附件），不带的是给页面直接看的预览 */
function sendFile(res: Response, bytes: Buffer, format: DocumentFormat, filename?: string) {
  res.set({
    'Content-Type': mime[format],
    'Content-Length': String(bytes.length),
    ...(filename
      ? { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename) }
      : {}),
  });
  res.send(bytes);
}
const recordId = z.coerce.number().int().positive();

type Routes = {
  router: Router;
  on: ReturnType<typeof route<DocumentsApi>>;
  store: Store;
  service: BusinessDocuments;
  /** 认人并要 business:edit；write=true 的读接口在这里补查页面凭证 */
  actor: (req: Request, write?: boolean) => ReturnType<typeof requirePermission>;
};

/** 单张、合并订货单的预览内容和 Word 排版预览 */
function previewRoutes({ router, on, service, actor }: Routes) {
  on('GET /documents/preview/:kind/:id', ({ param, query, req }) => {
    actor(req);
    const q = documentPreviewQuerySchema.parse(query);
    // 导出窗里看的是“导出并出库”后印出来的样子
    return service.form(z.enum(documentKinds).parse(param('kind')), recordId.parse(param('id')), q.templateId || undefined, {
      shipping: q.shipping === '1',
    }).form;
  });
  // 几张采购单合在一份订货单里的预览（还没导出时）
  on('POST /documents/preview-batch', ({ body, req }) => {
    actor(req);
    return service.batchPreview(body);
  });
  // 预览 Word 排版：只排版给人看，直接回文件内容；不占订货单号、不写导出记录和审计、不改状态。
  // 权限和正式导出一样（要页面凭证和 business:edit）
  router.post('/preview-file', async (req, res) => {
    const who = actor(req, true),
      bytes = await service.previewFile(req.body, who);
    if (actor(req, true).id !== who.id) throw new AppError('登录身份已变化。', 403);
    sendFile(res, bytes, 'docx');
  });
}

/** 模板设置、测试样张 */
function templateRoutes({ router, on, store, actor }: Routes) {
  on('GET /documents/templates', ({ req }) => {
    actor(req);
    return new DocumentTemplateSettings(store).get();
  });
  on('POST /documents/templates', ({ body, req }) => new DocumentTemplateSettings(store).save(body, actor(req, true)));
  on('POST /documents/templates/preview', ({ body, req }) => {
    actor(req, true);
    return sampleDocument(templatePreviewSchema.parse(body).template);
  });
  router.post('/templates/sample', async (req, res) => {
    const who = actor(req, true),
      { template, format } = templateSampleSchema.parse(req.body);
    const bytes = await renderBusinessForm(sampleDocument(template), format);
    if (actor(req, true).id !== who.id) throw new AppError('登录身份已变化。', 403);
    sendFile(res, bytes, format, '测试样张-' + template.title + '.' + format);
  });
}

/** 正式导出、查状态、下载文件、交付完成 */
function exportRoutes({ router, on, service, actor }: Routes) {
  on('POST /documents', async ({ body, req }) => {
    const who = actor(req, true),
      result = await service.generate(body, who);
    if (actor(req, true).id !== who.id) throw new AppError('登录身份已变化，未交付文件。', 403);
    return result;
  });
  on('GET /documents/:id', ({ param, req }) => service.status(param('id'), actor(req)));
  router.get('/:id/file', (req, res) => {
    const who = actor(req),
      v = service.file(String(req.params.id), who);
    res.on('finish', () => {
      try {
        if (req.method === 'GET') service.delivered(v.requestId, who);
      } catch {
        // 回完了才记“已下载”：这里抛出去没人接（会弄垮进程）。记不上（断线、身份失效）就当没交付，
        // 交付完成那一步会说“尚未完整交付”，让人重新下载，不会把没收到的文件记成已交付
      }
    });
    sendFile(res, v.buffer, v.format, v.filename);
  });
  on('POST /documents/:id/complete', ({ param, body, req }) =>
    service.complete(param('id'), exportCompleteSchema.parse(body).sha256, actor(req, true)),
  );
}

export function documentsRouter(store: Store, auth?: AuthManager) {
  const router = Router();
  const actor = (req: Request, write = false) => {
    if (!auth) throw new AppError('请先登录。', 401);
    // 写接口的页面凭证装配层已经统一查过；读接口带 write=true 的在这里补查
    if (write && req.method === 'GET') auth.requireCsrf(req);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const routes: Routes = { router, on: route<DocumentsApi>(router, '/documents'), store, service: new BusinessDocuments(store), actor };
  previewRoutes(routes);
  templateRoutes(routes);
  exportRoutes(routes);
  return router;
}
