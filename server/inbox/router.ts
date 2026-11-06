import express, { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { AuthManager } from '../auth.js';
import { ImportError } from '../import/errors.js';
import { audit, requirePermission } from '../business/management.js';
import { InboxService, filterSchema, statusSchema, type InboxImportTarget } from './service.js';
import { listInboxChannels } from './channels.js';
import type { WecomBotConnection } from './wecom-bot.js';
import type { WecomBotSettings } from './wecom-bot-settings.js';
export type WecomBotControl = { settings: WecomBotSettings; connection: WecomBotConnection };
export function inboxRouter(
  store: Store,
  auth?: AuthManager,
  imports?: InboxImportTarget,
  bot?: WecomBotControl,
) {
  const router = Router(),
    service = new InboxService(store);
  const botView = () => ({ ...bot!.settings.view(), status: bot!.connection.status() });
  /** 机器人凭据只有管理员能看和改。 */
  const botAdmin = (req: Request) => {
    const who = auth?.actor(req);
    if (who?.role !== 'super_admin') throw new ImportError('只有管理员可以设置企业微信机器人。', 403);
    if (!bot) throw new ImportError('企业微信机器人未启用。', 503);
    return who;
  };
  const actor = (req: Request) => {
    if (!auth || req.headers['x-erp-auth-token'] !== auth.csrf)
      throw new ImportError('请登录并刷新页面凭据。', 403);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  const id = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);
  router.get('/', (req, res) => res.json(service.list(filterSchema.parse(req.query), req.query)));
  router.get('/channels', (_req, res) => {
    if (!bot) return res.json(listInboxChannels());
    const view = bot.settings.view();
    res.json(
      listInboxChannels({
        configured: view.enabled && view.hasSecret,
        state: bot.connection.status().state,
      }),
    );
  });
  router.get('/wecom-bot', (req, res) => {
    botAdmin(req);
    res.json(botView());
  });
  router.post('/wecom-bot', (req, res) => {
    const who = actor(req);
    botAdmin(req);
    const saved = bot!.settings.save(req.body);
    audit(store, who, 'manual-ui', 'wecom-bot-settings', 'inbox_channel', null, {
      botId: saved.botId,
      enabled: saved.enabled,
      secretChanged: saved.secretChanged,
    });
    bot!.connection.start();
    res.json(botView());
  });
  router.get('/:id', (req, res) => res.json(service.get(id(req))));
  router.get('/:id/file', (req, res) => {
    const file = service.file(id(req));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(file.mime).send(Buffer.from(file.content));
  });
  router.post('/', (req, res) => {
    actor(req);
    const v = z.object({ text: z.string().min(1) }).parse(req.body);
    res
      .status(201)
      .json(
        service.ingest({
          channel: 'manual',
          externalId: randomUUID(),
          kind: 'text',
          text: v.text,
          receivedAt: new Date().toISOString(),
        }),
      );
  });
  router.post(
    '/upload',
    (req, _res, next) => {
      actor(req);
      next();
    },
    express.raw({ type: () => true, limit: '20mb' }),
    (req, res) => {
      const name = z.string().min(1).parse(req.query.name),
        mime = req.get('Content-Type') || 'application/octet-stream';
      const bytes = z.instanceof(Uint8Array).parse(req.body);
      res
        .status(201)
        .json(
          service.ingest({
            channel: 'manual',
            externalId: randomUUID(),
            kind: mime.startsWith('image/') ? 'image' : 'file',
            file: { name, mime, bytes },
            receivedAt: new Date().toISOString(),
          }),
        );
    },
  );
  router.post('/:id/convert', async (req, res, next) => {
    try {
      const who = actor(req);
      if (!imports) throw new ImportError('AI 导入服务未启用。', 503);
      res.json(await service.toImport(id(req), req.body, who, imports));
    } catch (e) {
      next(e);
    }
  });
  router.post('/:id/status', (req, res) =>
    res.json(service.setStatus(id(req), statusSchema.parse(req.body), actor(req))),
  );
  return router;
}
