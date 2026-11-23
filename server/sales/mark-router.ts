import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError, requirePermission, route, type RequestAuth, type Store } from '../core/index.js';
import type { MarksApi } from '../../shared/business/index.js';
import { MARK_MAX_MB, MarkService } from './product-marks.js';

/** 文件名里 encodeURIComponent 不转的几个字符（' ( ) *）按 %XX 转写时用十六进制 */
const HEX = 16;
const markId = (raw: unknown) => z.coerce.number().int().positive().parse(raw);

/**
 * 产品唛头资料（挂在 /api 下，接口表 shared/business/sales/mark-api.ts）：列出、上传、看原件、改、删（AI 识别唛头在识别导入，识别完也落到这里）。
 * 上传收原始字节、看原件回文件，不是 JSON，照旧用 express 注册。
 */
export function marksRouter(store: Store, auth?: RequestAuth) {
  const router = Router(),
    on = route<MarksApi>(router),
    service = new MarkService(store);
  const actor = (req: Request) => {
    // 页面凭证由装配层对所有写接口统一检查（server/http-guards.ts，RequestAuth.requireCsrf）
    if (!auth) throw new AppError('请登录并刷新页面凭据。', 403);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  on('GET /products/:id/marks', ({ param }) => service.list(markId(param('id'))));
  router.post(
    '/products/:id/marks/upload',
    (req, _res, next) => {
      actor(req);
      next();
    },
    express.raw({ type: () => true, limit: MARK_MAX_MB + 'mb' }),
    (req, res) => {
      res
        .status(201)
        .json(
          service.add(
            {
              productId: markId(req.params.id),
              bytes: z.instanceof(Uint8Array).parse(req.body),
              name: z.string().min(1).parse(req.query.name),
              mime: req.get('Content-Type') || 'application/octet-stream',
              title: z.string().optional().parse(req.query.title),
              sourceKind: 'manual',
            },
            actor(req),
          ),
        );
    },
  );
  router.get('/marks/:id/file', (req, res) => {
    const file = service.file(markId(req.params.id));
    // 类型来自上传方，只有不能执行脚本的格式才内联；SVG 等一律下载。
    const inline = /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(HEX))}`,
    );
    res.type(file.mime).send(file.content);
  });
  on('PUT /marks/:id', ({ param, body, req }) => service.update(markId(param('id')), body, actor(req)));
  on('DELETE /marks/:id', ({ param, body, req }) => service.remove(markId(param('id')), body, actor(req)));
  return router;
}
