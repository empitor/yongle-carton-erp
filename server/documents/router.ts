import { Router } from 'express';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { AuthManager } from '../auth.js';
import { ImportError } from '../import/errors.js';
import { requirePermission } from '../business/management.js';
import { BusinessDocuments } from './service.js';
import { DocumentTemplateSettings } from './settings.js';
import { templateSchema } from '../../shared/document-templates.js';
import { sampleDocument } from './sample.js';
import { renderBusinessForm } from './templates.js';
export function documentsRouter(store: Store, auth?: AuthManager) {
  const router = Router(),
    service = new BusinessDocuments(store);
  const actor = (req: any, write = false) => {
    if (!auth) throw new ImportError('请先登录。', 401);
    if (write && req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('页面凭证失效。', 403);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/preview/:kind/:id', (req, res) => {
    actor(req);
    res.json(
      service.form(
        z.enum(['purchase', 'delivery']).parse(req.params.kind),
        z.coerce.number().int().positive().parse(req.params.id),
        req.query.templateId ? String(req.query.templateId) : undefined,
      ).form,
    );
  });
  router.get('/templates', (req, res) => {
    actor(req);
    res.json(new DocumentTemplateSettings(store).get());
  });
  router.post('/templates', (req, res) =>
    res.json(new DocumentTemplateSettings(store).save(req.body, actor(req, true))),
  );
  router.post('/templates/preview', (req, res) => {
    actor(req, true);
    res.json(sampleDocument(templateSchema.parse(req.body.template)));
  });
  router.post('/templates/sample', async (req, res) => {
    const who = actor(req, true),
      template = templateSchema.parse(req.body.template),
      format = z.enum(['docx', 'xlsx']).parse(req.body.format);
    const bytes = await renderBusinessForm(sampleDocument(template), format);
    if (actor(req, true).id !== who.id) throw new ImportError('登录身份已变化。', 403);
    res.set({
      'Content-Type':
        format === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        "attachment; filename*=UTF-8''" +
        encodeURIComponent('测试样张-' + template.title + '.' + format),
    });
    res.send(bytes);
  });
  router.post('/', async (req, res, next) => {
    try {
      const who = actor(req, true),
        result = await service.generate(req.body, who);
      if (actor(req, true).id !== who.id)
        throw new ImportError('登录身份已变化，未交付文件。', 403);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  router.get('/:id', (req, res) => res.json(service.status(String(req.params.id), actor(req))));
  router.get('/:id/file', (req, res) => {
    const who = actor(req),
      v = service.file(String(req.params.id), who);
    res.set({
      'Content-Type':
        v.format === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(v.filename),
      'Content-Length': String(v.buffer.length),
    });
    res.on('finish', () => {
      try {
        if (req.method === 'GET') service.delivered(v.requestId, who);
      } catch {
        /* 断线或身份失效不报告交付成功 */
      }
    });
    res.send(v.buffer);
  });
  router.post('/:id/complete', (req, res) =>
    res.json(
      service.complete(
        String(req.params.id),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(req.body.sha256),
        actor(req, true),
      ),
    ),
  );
  return router;
}
