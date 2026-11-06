import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { AuthManager } from '../auth.js';
import { requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { MarkService } from './service.js';
export function marksRouter(store: Store, auth?: AuthManager) {
  const router = Router(),
    service = new MarkService(store);
  const id = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);
  const actor = (req: Request) => {
    if (!auth || req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('请登录并刷新页面凭据。', 403);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  router.get('/products/:id/marks', (req, res) => res.json(service.list(id(req))));
  router.post(
    '/products/:id/marks/upload',
    (req, _res, next) => {
      actor(req);
      next();
    },
    express.raw({ type: () => true, limit: '20mb' }),
    (req, res) => {
      res
        .status(201)
        .json(
          service.add(
            {
              productId: id(req),
              bytes: z.instanceof(Uint8Array).parse(req.body),
              name: z.string().min(1).parse(req.query.name),
              mime: req.get('Content-Type') || 'application/octet-stream',
              title: z.string().optional().parse(req.query.title),
              fields: {},
              sourceKind: 'manual',
            },
            actor(req),
          ),
        );
    },
  );
  router.get('/marks/:id/file', (req, res) => {
    const file = service.file(id(req));
    // 类型来自上传方，只有不能执行脚本的格式才内联；SVG 等一律下载。
    const inline = /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
    );
    res.type(file.mime).send(file.content);
  });
  router.put('/marks/:id', (req, res) => res.json(service.update(id(req), req.body, actor(req))));
  router.delete('/marks/:id', (req, res) =>
    res.json(service.remove(id(req), req.body, actor(req))),
  );
  return router;
}
