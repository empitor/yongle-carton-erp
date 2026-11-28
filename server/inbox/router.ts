import express, { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { RequestAuth } from '../core/index.js';
import { AppError, route } from '../core/index.js';
import { audit, requirePermission, requireSuperAdminAccount, requireSuperModeFor } from '../core/index.js';
import { INBOX_MAX_FILE, botChannels, inboxFilterSchema, inboxStatusSchema, inboxTextSchema, type InboxApi } from '../../shared/import/index.js';
import { InboxService, type InboxImportTarget } from './service.js';
import { inboxChannelList, type BotManager } from './bots/manager.js';

/*
 * 收件箱的地址（挂在 /api/inbox 下，接口表 shared/import/inbox-api.ts）。
 * 下载原件（回文件）和上传文件（收原始字节，先过 express.raw）不是 JSON 来回，照旧用 express 注册。
 */
type InboxRoutes = {
  router: Router;
  on: ReturnType<typeof route<InboxApi>>;
  store: Store;
  service: InboxService;
  auth?: RequestAuth;
  imports?: InboxImportTarget;
  bots?: BotManager;
  /** 写操作：要页面凭证和业务编辑权限 */
  actor: (req: Request) => ReturnType<typeof requirePermission>;
  id: (raw: string) => number;
};

/** 百分号编码用十六进制 */
const HEX = 16;
/** 下载时的文件名：RFC 5987 的写法，' ( ) * 也编码，浏览器才不会截断 */
const contentDisposition = (name: string) =>
  `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(HEX))}`;

/**
 * 机器人凭据只有超级管理员账号能看，改要先进超级管理员模式（偷到登录状态的人不能换掉凭据）；
 * 拒绝的说法和类别跟全站一致（server/core/http/permissions.ts）。设置里有应用编号，和 AI 设置一样不让浏览器和代理缓存。
 */
function botRoutes({ router, on, store, auth, bots, actor }: InboxRoutes) {
  const botAdmin = (req: Request, change = false) => {
    const who = auth?.actor(req);
    if (change) requireSuperModeFor(who, '设置机器人');
    else requireSuperAdminAccount(who, '设置机器人');
    if (!bots) throw new AppError('机器人接入未启用。', 503);
    return bots;
  };
  router.use('/bots', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  on('GET /inbox/bots', ({ req }) => botAdmin(req).views());
  on('POST /inbox/bots/:channel', ({ param, body, req }) => {
    const who = actor(req),
      manager = botAdmin(req, true),
      channel = z.enum(botChannels).parse(param('channel'));
    const previous = manager.settings.view(channel);
    const saved = manager.settings.save(channel, body);
    // 审计只记改没改，不记应用编号和 Secret 本身
    audit(store, who, {
      action: 'bot-settings',
      entity: 'inbox_channel',
      id: null,
      document: {
        channel,
        enabled: saved.enabled,
        enabledChanged: previous.enabled !== saved.enabled,
        appIdChanged: previous.appId !== saved.appId,
        secretChanged: saved.secretChanged,
      },
    });
    manager.restart(channel);
    return manager.views();
  });
}

/** 手动添加：一段文字，或上传一个文件（原样存，按类型分图片和文件） */
function addRoutes({ router, on, service, actor }: InboxRoutes) {
  on(
    'POST /inbox',
    ({ body, req }) => {
      actor(req);
      const v = inboxTextSchema.parse(body);
      return service.ingest({ channel: 'manual', externalId: randomUUID(), kind: 'text', text: v.text, receivedAt: new Date().toISOString() });
    },
    { status: 201 },
  );
  router.post(
    '/upload',
    (req, _res, next) => {
      actor(req);
      next();
    },
    express.raw({ type: () => true, limit: INBOX_MAX_FILE }),
    (req, res) => {
      const name = z.string().min(1).parse(req.query.name),
        mime = req.get('Content-Type') || 'application/octet-stream';
      const bytes = z.instanceof(Uint8Array).parse(req.body);
      res.status(201).json(
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
}

/** 一条收件：看、下载原件、转入 AI 导入、改处理状态 */
function itemRoutes({ router, on, service, imports, actor, id }: InboxRoutes) {
  on('GET /inbox/:id', ({ param }) => service.get(id(param('id'))));
  router.get('/:id/file', (req, res) => {
    const file = service.file(id(String(req.params.id)));
    res.setHeader('Content-Disposition', contentDisposition(file.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(file.mime).send(Buffer.from(file.content));
  });
  on('POST /inbox/:id/convert', async ({ param, body, req }) => {
    const who = actor(req);
    if (!imports) throw new AppError('AI 导入服务未启用。', 503);
    return service.toImport(id(param('id')), body, who, imports);
  });
  // 先查权限再看正文：没权限的不管正文写成什么都回没权限
  on('POST /inbox/:id/status', ({ param, body, req }) => {
    const who = actor(req);
    return service.setStatus(id(param('id')), inboxStatusSchema.parse(body), who);
  });
}

export function inboxRouter(
  store: Store,
  auth?: RequestAuth,
  imports?: InboxImportTarget,
  bots?: BotManager,
) {
  const router = Router(),
    service = new InboxService(store);
  const routes: InboxRoutes = {
    router,
    on: route<InboxApi>(router, '/inbox'),
    store,
    service,
    auth,
    imports,
    bots,
    actor: (req) => {
      if (!auth || req.headers['x-erp-auth-token'] !== auth.csrf)
        throw new AppError('请登录并刷新页面凭据。', 403);
      return requirePermission(auth.actor(req), 'business:edit');
    },
    id: (raw) => z.coerce.number().int().positive().parse(raw),
  };
  // 先挂固定地址（/channels、/bots），再挂 /:id，免得被它接走
  routes.on('GET /inbox', ({ query }) => service.list(inboxFilterSchema.parse(query), query));
  routes.on('GET /inbox/channels', () => inboxChannelList(bots));
  botRoutes(routes);
  itemRoutes(routes);
  addRoutes(routes);
  return router;
}
