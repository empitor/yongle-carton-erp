import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { dateSchema, statuses, type Order } from '../shared/domain.js';
import { Store, ConflictError, InputError } from './db.js';
import { createBusinessService, BusinessAccessError, NotFoundError } from './business/service.js';
import { getBusinessMetadata } from './business/metadata.js';
import { AiSettingsManager } from './ai/settings-manager.js';
import { aiSettingsRouter } from './ai/settings-router.js';
import { importRouter } from './import/router.js';
import type { ImportManager } from './import/manager.js';
import { AuthManager } from './auth.js';
import { matchDraft } from './import/matching.js';
import { standardOrderDraft } from './import/standard-order.js';
import { ImportError } from './import/errors.js';
import { promptSettingsRouter } from './ai/prompt-router.js';
import type { PromptPresetManager } from './ai/prompt-presets.js';
import { promptModules } from '../shared/prompt-modules.js';
import { changeLifecycle, audit, requirePermission, isSuperMode } from './business/management.js';
import { PermanentDeletionService } from './business/permanent-deletion.js';
import type { BusinessCommand } from './business/service.js';
import { ImportExecutionService } from './business/import-execution.js';
import { fileURLToPath } from 'node:url';
import { operationsRouter } from './operations/router.js';
import { flowRouter } from './flow/router.js';
import type { ReceiptAi } from './flow/receipt-ai.js';
import type { AssistantManager } from './assistant/manager.js';
import { assistantRouter } from './assistant/router.js';
import { orderInView } from '../shared/date-ranges.js';
import { buildDashboard } from './business/dashboard.js';
import { developerRouter } from './developer-router.js';
import { isLocalAdministrator } from './developer-capability.js';
import { APP_VERSION } from '../shared/version.js';
import {
  orderMetrics,
  productMetrics,
  productIncomplete,
  matchesProduct,
} from '../shared/business-metrics.js';

function filters(req: Request, rows: Order[]) {
  const f = z
    .object({
      customerId: z.coerce.number().int().positive().optional(),
      start: dateSchema.optional(),
      end: dateSchema.optional(),
      status: z.enum(statuses).optional(),
      q: z.string().max(200).optional(),
      view: z.enum(['current', 'pending', 'history']).optional(),
      retainPending: z.enum(['1', '0']).optional(),
    })
    .parse(req.query);
  if (f.start && f.end && f.start > f.end) throw new InputError('开始日期不能晚于结束日期');
  return rows.filter(
    (o) =>
      (!f.customerId || o.customerId === f.customerId) &&
      orderInView(o, {
        view: f.view,
        start: f.start,
        end: f.end,
        retainPending: f.retainPending === '1',
      }) &&
      (!f.status || o.status === f.status) &&
      (!f.q ||
        [o.number, o.customerName, ...o.lines.map((l) => l.productName)]
          .join(' ')
          .toLowerCase()
          .includes(f.q.toLowerCase())),
  );
}
export function createApp(
  store: Store,
  options: {
    aiSettings?: AiSettingsManager;
    imports?: ImportManager;
    auth?: AuthManager;
    enableReviewedImports?: boolean;
    importArchiveDirectory?: string;
    receiptAi?: ReceiptAi;
    assistant?: AssistantManager;
    promptModules?: Partial<Record<string, PromptPresetManager>>;
  } = {},
) {
  const app = express();
  if (options.imports)
    options.imports.arrivalDocumentExists = (id) =>
      !!store.db.prepare("SELECT 1 FROM flow_documents WHERE id=? AND kind='arrival'").get(id);
  const business = createBusinessService(store);
  function includeArchived(req: Request) {
    if (req.query.archived === 'all') {
      if (!options.auth) throw new ImportError('请先登录并进入超级管理员模式。', 403);
      options.auth.requireSuperMode(req);
      return true;
    }
    return req.query.archived === '1';
  }
  // 暂时维持本机人工录入；未来此处从真实登录会话构建身份与权限上下文。
  function manualWrite(command: BusinessCommand, req: Request) {
    const actor = options.auth ? requirePermission(options.auth.actor(req), 'business:edit') : null;
    if (options.auth && req.headers['x-erp-auth-token'] !== options.auth.csrf)
      throw new ImportError('页面凭证已过期，请刷新。', 403);
    const elevated = isSuperMode(actor);
    const id = 'id' in command ? Number(command.id) : null,
      before = id ? store[command.entity](elevated).find((r) => r.id === id) : null;
    store.db.exec('SAVEPOINT manual_business');
    try {
      const result = business.execute(command, {
        source: 'manual-ui',
        operatorId: actor?.id || null,
        superAdminMode: elevated,
        developerActor: actor || undefined,
      });
      if (actor)
        audit(
          store,
          actor,
          elevated ? 'super-admin' : 'manual-ui',
          command.action,
          command.entity,
          result.id,
          {
            before,
            after: result,
            beforeArchived: id ? store.archived(command.entity, id) : false,
          },
        );
      store.db.exec('RELEASE manual_business');
      return result;
    } catch (error) {
      store.db.exec('ROLLBACK TO manual_business; RELEASE manual_business');
      throw error;
    }
  }
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
      strictTransportSecurity: false,
    }),
  );
  app.use((req, res, next) => {
    const host = req.headers.host?.split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host || ''))
      return res.status(403).json({ message: '仅允许本机访问' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        const allowed = [
          `http://127.0.0.1:${process.env.PORT || 3001}`,
          `http://localhost:${process.env.PORT || 3001}`,
          'http://127.0.0.1:5173',
          'http://localhost:5173',
        ];
        if (!allowed.includes(origin)) return res.status(403).json({ message: '请求来源不允许' });
      }
      const rawUpload =
        req.method === 'POST' &&
        ([
          '/api/ai/imports/upload',
          '/api/flow/sources/upload',
          '/api/assistant/transcribe',
        ].includes(req.path) ||
          /^\/api\/assistant\/threads\/[0-9a-f-]{36}\/attachments$/.test(req.path)) &&
        req.is('application/octet-stream');
      if (!req.is('application/json') && !rawUpload)
        return res
          .status(415)
          .json({ message: '请使用 JSON 请求；文件仅允许从导入上传入口提交。' });
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      app: 'carton-workshop-erp',
      version: APP_VERSION,
      processId: process.pid,
      mode: '本机开发验收版',
      database: 'SQLite',
    }),
  );
  app.get('/api/business/metadata', (_req, res) =>
    res.json(
      getBusinessMetadata({
        authentication: !!options.auth,
        importExecution: !!(options.auth && options.imports && options.enableReviewedImports),
        assistantTools:
          options.auth && options.assistant
            ? Object.fromEntries(options.assistant.registry.exposed().map((t) => [t.name, true]))
            : {},
      }),
    ),
  );
  // 新增核对身份仅服务于导入准备，不改变既有业务或AI设置的访问策略。
  if (options.auth) app.use('/api/auth', options.auth.router());
  if (options.auth)
    app.use(['/api/management', '/api/developer'], developerRouter(store, options.auth, options.imports));
  if (options.assistant && options.auth) {
    app.use('/api/assistant', assistantRouter(options.assistant, options.auth));
    app.use(
      '/api/ai/assistant-prompts',
      (req, res, next) => {
        requirePermission(options.auth!.actor(req), 'business:edit');
        next();
      },
      promptSettingsRouter(options.assistant.prompts, options.auth.csrf),
    );
  }
  app.use('/api', operationsRouter(store, options.auth));
  app.use('/api/flow', flowRouter(store, options.auth, options.receiptAi));
  if (options.receiptAi && options.auth)
    app.use(
      '/api/ai/receipt-prompts',
      (req, res, next) => {
        requirePermission(options.auth!.actor(req), 'business:edit');
        next();
      },
      promptSettingsRouter(options.receiptAi.prompts, options.auth.csrf),
    );
  // 统一提示词模块目录：按模块标识隔离预设，旧 /api/ai/prompts 等路径继续兼容。
  if (options.auth) {
    app.get('/api/ai/prompt-modules', (req, res) => {
      requirePermission(options.auth!.actor(req), 'business:edit');
      res.json(
        promptModules.map((module) => ({
          id: module.id,
          name: module.name,
          description: module.description,
          purpose: module.purpose,
          apiPath: module.apiPath,
          status: module.status,
          documents: module.documents,
          usage: module.usage,
        })),
      );
    });
    for (const module of promptModules) {
      const manager =
        options.promptModules?.[module.id] ??
        (module.id === 'sales-order'
          ? options.imports?.promptPresets
          : module.id === 'supplier-delivery'
            ? options.receiptAi?.prompts
            : module.id === 'assistant'
              ? options.assistant?.prompts
              : undefined);
      if (!manager) continue;
      app.use(
        module.apiPath,
        (req, res, next) => {
          requirePermission(options.auth!.actor(req), 'business:edit');
          next();
        },
        promptSettingsRouter(manager, options.auth.csrf),
      );
    }
  }
  if (options.auth) {
    const deletion = new PermanentDeletionService(store);
    app.post('/api/admin/permanent-deletions/:action', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== options.auth!.csrf)
        throw new ImportError('页面凭证已过期，请刷新。', 403);
      const actor = options.auth!.requireSuperMode(req),
        binding = options.auth!.sessionBinding(req);
      if (req.params.action === 'preview') res.json(deletion.preview(req.body, actor, binding));
      else if (req.params.action === 'execute') {
        const { password, ...input } = z
          .strictObject({
            previewId: z.string().uuid(),
            acknowledged: z.literal(true),
            confirmation: z.literal('永久删除').optional(),
            password: z.string().min(1).max(128).optional(),
          })
          .parse(req.body);
        if (!isLocalAdministrator(actor)) options.auth!.verifyPassword(req, password);
        res.json(deletion.execute(input, options.auth!.requireSuperMode(req), binding));
      } else throw new ImportError('操作不存在。', 404);
    });
  }
  if (options.imports && options.auth && options.enableReviewedImports) {
    const execution = new ImportExecutionService(
      store,
      options.imports,
      options.importArchiveDirectory ||
        fileURLToPath(new URL('../data/import-archive/', import.meta.url)),
    );
    options.assistant?.connectImports(options.imports, execution);
    for (const action of ['preview', 'execute', 'undo-import'] as const)
      app.post('/api/ai/imports/:id/' + action, async (req, res, next) => {
        try {
          if (req.headers['x-erp-ai-token'] !== options.imports!.csrfToken)
            throw new ImportError('页面安全凭证无效，请刷新。', 403);
          const id = String(req.params.id),
            actor = options.auth!.actor(req);
          res.json(
            action === 'preview'
              ? await execution.preview(id, req.body, actor)
              : action === 'execute'
                ? await execution.execute(id, req.body, actor, () => options.auth!.actor(req))
                : (z.strictObject({ acknowledged: z.literal(true) }).parse(req.body),
                  execution.undo(id, actor)),
          );
        } catch (error) {
          next(error);
        }
      });
  }
  for (const entity of ['customers', 'products', 'orders'] as const) {
    app.post('/api/' + entity + '/batch', (req, res, next) => {
      try {
        if (!options.auth || req.headers['x-erp-auth-token'] !== options.auth.csrf)
          throw new ImportError('请登录管理账号并刷新页面。', 403);
        res.json(changeLifecycle(store, entity, req.body, options.auth.actor(req)));
      } catch (error) {
        next(error);
      }
    });
  }
  if (options.imports)
    app.use(
      '/api/ai/prompts',
      promptSettingsRouter(options.imports.promptPresets, options.imports.csrfToken),
    );
  if (options.imports)
    app.get('/api/ai/imports/:id/matches', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(matchDraft(store, options.imports!.get(String(req.params.id))));
    });
  if (options.imports)
    app.get('/api/ai/imports/:id/standard-order', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(standardOrderDraft(store, options.imports!.get(String(req.params.id))));
    });
  app.use('/api/ai/settings', aiSettingsRouter(options.aiSettings || new AiSettingsManager()));
  if (options.imports)
    app.use(
      '/api/ai/imports',
      importRouter(options.imports, (req) => options.auth?.actor(req) || null, options.receiptAi),
    );
  for (const entity of ['customers', 'products'] as const) {
    app.get(`/api/${entity}`, (req, res) => {
      const q = z
        .string()
        .max(200)
        .parse(req.query.q || '')
        .toLowerCase();
      const scoped = store[entity](includeArchived(req))
        .filter((x) => req.query.archived !== '1' || store.archived(entity, x.id))
        .map((row) => ({ ...row, archived: store.archived(entity, row.id) }));
      if (req.query.withMetrics === '1') {
        const matched = scoped.filter((row) =>
          entity === 'products'
            ? matchesProduct(row, q)
            : [
                row.name,
                (row as any).contact,
                (row as any).phone,
                (row as any).address,
                (row as any).notes,
              ]
                .join(' ')
                .toLowerCase()
                .includes(q),
        );
        const incomplete = z.enum(['1', '0']).optional().parse(req.query.incomplete);
        return res.json({
          rows:
            entity === 'products' && incomplete === '1'
              ? matched.filter(productIncomplete)
              : matched,
          totalRecords: scoped.length,
          metrics: entity === 'products' ? productMetrics(matched) : null,
        });
      }
      res.json(
        scoped.filter(({ archived, ...x }) => Object.values(x).join(' ').toLowerCase().includes(q)),
      );
    });
    for (const method of ['post', 'put'] as const)
      app[method](`/api/${entity}${method === 'put' ? '/:id' : ''}`, (req, res) => {
        const command =
          method === 'put'
            ? {
                entity,
                action: 'update' as const,
                id: (req.params as Record<string, string>).id,
                input: req.body,
              }
            : { entity, action: 'create' as const, input: req.body };
        res.status(method === 'put' ? 200 : 201).json(manualWrite(command, req));
      });
  }
  app.get('/api/orders', (req, res) => {
    const scoped = store
      .orders(includeArchived(req))
      .filter((o) => req.query.archived !== '1' || store.archived('orders', o.id))
      .map((row) => ({ ...row, archived: store.archived('orders', row.id) }));
    const rows = filters(req, scoped);
    res.json(
      req.query.withMetrics === '1'
        ? { rows, totalRecords: scoped.length, metrics: orderMetrics(rows) }
        : rows,
    );
  });
  app.get('/api/orders/:id', (req, res) => {
    const item = store.order(
      z.coerce.number().int().positive().parse(req.params.id),
      isSuperMode(options.auth?.actor(req)),
    );
    if (!item) return res.status(404).json({ message: '订单不存在' });
    res.json(item);
  });
  for (const method of ['post', 'put'] as const)
    app[method](`/api/orders${method === 'put' ? '/:id' : ''}`, (req, res) => {
      const command =
        method === 'put'
          ? {
              entity: 'orders' as const,
              action: 'update' as const,
              id: (req.params as Record<string, string>).id,
              input: req.body,
            }
          : { entity: 'orders' as const, action: 'create' as const, input: req.body };
      res.status(method === 'put' ? 200 : 201).json(manualWrite(command, req));
    });
  app.get('/api/dashboard', (req, res) => {
    const range = z
      .object({ start: dateSchema.optional(), end: dateSchema.optional() })
      .parse(req.query);
    res.json(buildDashboard(store, filters(req, store.orders()), range));
  });
  app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({ message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') });
    if (error instanceof ConflictError) return res.status(409).json({ message: error.message });
    if (error instanceof BusinessAccessError)
      return res.status(403).json({ message: error.message });
    if (error instanceof NotFoundError) return res.status(404).json({ message: error.message });
    if (error instanceof InputError) return res.status(400).json({ message: error.message });
    if (error instanceof ImportError)
      return res.status(error.status).json({ message: error.message, code: error.code });
    if (error instanceof SyntaxError) return res.status(400).json({ message: 'JSON 格式错误' });
    if ((error as { type?: string })?.type === 'entity.too.large')
      return res.status(413).json({ message: '提交内容过大' });
    console.error(error);
    res.status(500).json({ message: '保存失败，请检查服务日志后重试' });
  });
  return app;
}
