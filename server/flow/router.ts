import express, { Router, type Request } from 'express';
import { z, ZodError } from 'zod';
import type { Store } from '../db.js';
import type { AuthManager } from '../auth.js';
import type { ReceiptAi } from './receipt-ai.js';
import { FlowService } from './service.js';
import { ImportError } from '../import/errors.js';
import { AiConnectionError } from '../ai/connection-error.js';
import { flowKinds } from '../../shared/physical-flow.js';
import { AI_HTTP_TIMEOUT_MS } from '../../shared/ai-runtime.js';
import { requirePermission } from '../business/management.js';
import { deliveryPrint } from './printing.js';
export function flowRouter(store: Store, auth?: AuthManager, receiptAi?: ReceiptAi) {
  const router = Router(),
    service = new FlowService(store);
  const actor = (req: Request, write = true) => {
    if (!auth) throw new ImportError('此业务需要登录身份验证。', 403);
    if (write && req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('页面凭证失效，请刷新。', 403);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  const id = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/sources', (req, res) => {
    actor(req, false);
    res.json(receiptAi?.sources() || []);
  });
  router.post(
    '/sources/upload',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    (req, res) => {
      const who = actor(req);
      if (!receiptAi) throw new ImportError('供应商AI识别未配置。', 503);
      const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      if (!Buffer.isBuffer(req.body)) throw new ImportError('请选择有效文件。');
      res.status(201).json(receiptAi.upload(req.body, name, who));
    },
  );
  router.get('/sources/:sourceId', (req, res) => {
    actor(req, false);
    if (!receiptAi) throw new ImportError('供应商AI识别未配置。', 503);
    res.json(receiptAi.source(String(req.params.sourceId)));
  });
  router.get('/sources/:sourceId/file', (req, res) => {
    actor(req, false);
    const s = store.db
      .prepare('SELECT file_name,bytes,format FROM flow_sources WHERE id=?')
      .get(z.string().uuid().parse(req.params.sourceId));
    if (!s) throw new ImportError('原件不存在。', 404);
    const mime: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
    };
    res.set('Content-Type', mime[String(s.format)] || 'application/octet-stream');
    res.set(
      'Content-Disposition',
      "inline; filename*=UTF-8''" + encodeURIComponent(String(s.file_name)),
    );
    res.send(Buffer.from(s.bytes as Uint8Array));
  });
  router.post('/sources/:sourceId/analyze', async (req, res, next) => {
    let done = false;
    const sourceId = String(req.params.sourceId);
    try {
      const who = actor(req);
      if (!receiptAi) throw new ImportError('供应商AI识别未配置。', 503);
      req.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.setTimeout(AI_HTTP_TIMEOUT_MS);
      res.on('close', () => {
        if (!done) receiptAi.abort(sourceId);
      });
      if (!req.body.stream) {
        res.json(await receiptAi.analyze(sourceId, req.body, who));
        done = true;
        return;
      }
      res
        .set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        })
        .flushHeaders();
      const send = (event: string, data: unknown) => {
        if (!res.destroyed)
          res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      };
      const started = Date.now();
      let last = 0;
      const timer = setInterval(
        () => send('progress', { elapsedMs: Date.now() - started, stage: 'waiting' }),
        10000,
      );
      timer.unref();
      try {
        const result = await receiptAi.analyze(sourceId, req.body, who, (p) => {
          if (Date.now() - last > 200 || p.stage === 'validating') {
            send('progress', p);
            last = Date.now();
          }
        });
        send('result', result);
      } catch (e) {
        send('error', {
          message:
            e instanceof ImportError || e instanceof AiConnectionError
              ? e.message
              : e instanceof ZodError
                ? '模型返回结构不符合送货单格式，未保存草稿。'
                : '识别失败，未保存不完整结果。',
        });
      } finally {
        clearInterval(timer);
        done = true;
        res.end();
      }
    } catch (e) {
      done = true;
      if (e instanceof AiConnectionError && !res.headersSent) {
        res.status(e.status).json({ message: e.message, code: e.code });
        return;
      }
      next(e);
    }
  });
  router.get('/', (req, res) => {
    if (!auth?.actor(req)) throw new ImportError('请先登录管理账号。', 401);
    const kind = z.enum(flowKinds).optional().parse(req.query.kind);
    res.json(
      service
        .list(kind, req.query.archived === '1')
        .filter((d) => req.query.archived !== '1' || d.archived),
    );
  });
  router.get('/:id/print', (req, res) => {
    if (!auth?.actor(req)) throw new ImportError('请先登录。', 401);
    const d = service.get(id(req));
    if (d.kind !== 'delivery') throw new ImportError('仅送货单支持此打印格式。');
    const lines = d.lines.map((l: any) => {
      const o = store.order(l.orderId, true),
        ol = o?.lines.find((x) => x.id === l.orderLineId);
      return { ...ol, ...l, orderNumber: o?.number };
    });
    res.type('html');
    if (req.query.download === '1')
      res.set('Content-Disposition', `attachment; filename="delivery-${d.id}.html"`);
    res.send(deliveryPrint({ ...d, lines }, store.customer(d.customerId, true)));
  });
  router.get('/:id', (req, res) => {
    if (!auth?.actor(req)) throw new ImportError('请先登录管理账号。', 401);
    res.json(service.get(id(req)));
  });
  router.post('/:kind', (req, res) =>
    res
      .status(201)
      .json(service.save(z.enum(flowKinds).parse(req.params.kind), req.body, actor(req))),
  );
  router.put('/:id', (req, res) =>
    res.json(service.save(service.get(id(req)).kind, req.body, actor(req), id(req))),
  );
  router.post('/:id/preview', (req, res) =>
    res.json(service.preview(id(req), actor(req), auth!.sessionBinding(req))),
  );
  router.post('/:id/confirm', (req, res) =>
    res.json(service.confirm(id(req), req.body, actor(req), auth!.sessionBinding(req))),
  );
  for (const action of ['cancel', 'reverse'] as const)
    router.post('/:id/' + action, (req, res) =>
      res.json(service[action](id(req), req.body, actor(req))),
    );
  router.post('/:id/lifecycle', (req, res) => {
    const input = z
      .object({
        action: z.enum(['archive', 'restore']),
        version: z.number().int().positive(),
        acknowledged: z.literal(true),
      })
      .parse(req.body);
    res.json(service.archive(id(req), input.action === 'restore', actor(req), input.version));
  });
  return router;
}
