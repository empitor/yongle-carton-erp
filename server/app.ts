import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { pageProblemRouter, proxyIngress, requirePermission, requireSuperModeFor, type Deployment, type ProblemLog, type Store } from './core/index.js';
import { userManualRouter } from './system/index.js';
import { operationsRouter } from './operations/index.js';
import { recordsRouter, workbenchRouter } from './business/index.js';
import { installRequestGuards } from './http-guards.js';
import { apiErrorHandler } from './http-errors.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AiSettingsManager } from './ai/index.js';
import { aiSettingsRouter } from './ai/index.js';
import { importRouter } from './import/index.js';
import type { ImportManager } from './import/index.js';
import { AuthManager } from './core/index.js';
import { promptModuleListRouter, promptSettingsRouter } from './ai/index.js';
import type { PromptPresetManager } from './ai/index.js';
import { promptModules, type PromptModuleId } from '../shared/ai/index.js';
import type { ImportExecutionService } from './import/index.js';
import { marksRouter } from './business/index.js';
import { inboxRouter, type BotManager } from './inbox/index.js';
import { stockFlowRouter } from './flow/index.js';
import { flowRouter } from './flow/index.js';
import { financeRouter } from './finance/index.js';
import { documentsRouter } from './documents/index.js';
import type { ReceiptAi } from './import/index.js';
import { receiptSourceRouter } from './import/index.js';
import type { AssistantManager } from './assistant/index.js';
import { assistantRouter } from './assistant/index.js';
import { dataManagementRouter } from './admin/index.js';
import { deletionRouter } from './business/index.js';
import { APP_VERSION } from '../shared/core/index.js';
import { SERVICE_APP_NAME } from './local-service.js';

type AppOptions = {
  aiSettings?: AiSettingsManager;
  imports?: ImportManager;
  /** 识别结果确认后写进业务库（正式导入的预览、执行）：给了才挂这两条地址，助手用的是同一个 */
  execution?: ImportExecutionService;
  auth?: AuthManager;
  deployment?: Deployment;
  receiptAi?: ReceiptAi;
  bots?: BotManager;
  assistant?: AssistantManager;
  /** 三个提示词模块各自的管理器：挂提示词设置页的地址，和交给助手、识别导入的是同一张表 */
  promptModules?: Record<PromptModuleId, PromptPresetManager>;
  /** 出错记录库：请求失败由请求守卫记，页面报错走 /api/diagnostics */
  problems?: ProblemLog;
};

/** 健康检查：从域名进来的只回 ok，版本号、进程号不对外（停服务、启动、打补丁的脚本都走本机端口） */
function healthRoute(app: Express, deployment: Deployment | undefined) {
  app.get('/api/health', (req, res) =>
    res.json(
      proxyIngress(req, deployment)
        ? { ok: true }
        : {
            ok: true,
            app: SERVICE_APP_NAME,
            version: APP_VERSION,
            processId: process.pid,
            mode: deployment ? '服务器部署版' : '本机开发验收版',
            database: 'SQLite',
          },
    ),
  );
}

/** 提示词只有这一套地址：/api/ai/prompt-modules 列模块，每个模块挂在自己的 apiPath 下。 */
function promptRoutes(app: Express, auth: AuthManager, managers: Record<PromptModuleId, PromptPresetManager>) {
  app.use('/api/ai/prompt-modules', promptModuleListRouter((req) => auth.actor(req)));
  for (const module of promptModules) {
    const manager = managers[module.id];
    app.use(
      module.apiPath,
      (req, _res, next) => {
        const actor = auth.actor(req);
        requirePermission(actor, 'business:edit');
        // 提示词全员共用，进所有人助手的系统提示词：改动和 AI 设置一样要先进超级管理员模式；读取照旧
        if (req.method !== 'GET') requireSuperModeFor(actor, '修改提示词');
        next();
      },
      promptSettingsRouter(module.id, manager, auth.csrf),
    );
  }
}

/** 有构建好的页面（dist）就一起发：入口页不缓存，带内容摘要的资源长期缓存，别的地址都回入口页 */
function staticSite(app: Express) {
  const dist = resolve('dist');
  if (!existsSync(dist)) return;
  app.use(express.static(dist, {
    setHeaders(res, file) {
      const relative = file.slice(dist.length + 1).replaceAll('\\', '/');
      if (relative === 'index.html') res.setHeader('Cache-Control', 'no-cache');
      else if (/^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[^/]+$/.test(relative))
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get('/{*path}', (_req, res) =>
    res.sendFile(resolve(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }),
  );
}

export function createApp(store: Store, options: AppOptions = {}) {
  const app = express();
  installRequestGuards(app, options);
  healthRoute(app, options.deployment);
  // 业务汇总：今日、概况、关联记录
  app.use('/api', workbenchRouter(store, options.auth));
  // 新增核对身份仅服务于导入准备，不改变既有业务或AI设置的访问策略。
  if (options.auth) app.use('/api/auth', options.auth.router());
  // 使用手册（docs/使用手册.md），“使用说明”页显示它，助手的 guide.read 读同一份
  app.use('/api/guide', userManualRouter());
  if (options.auth) app.use('/api/deletions', deletionRouter(store, options.auth));
  if (options.auth)
    app.use(
      '/api/management',
      dataManagementRouter(store, options.auth, options.imports),
    );
  if (options.assistant && options.auth) {
    app.use('/api/assistant', assistantRouter(options.assistant, options.auth));
  }
  app.use('/api', marksRouter(store, options.auth));
  app.use('/api/inbox', inboxRouter(store, options.auth, options.imports, options.bots));
  // 采购单、库存品和流水、订货单（含登记到货）回答带单据的内容，归单据流转；供应商在采购库存
  app.use('/api', stockFlowRouter(store, options.auth));
  app.use('/api', operationsRouter(store, options.auth));
  // 送货单原件和 AI 识别属于识别导入，先挂，免得被单据的 /:id 路由接走
  app.use('/api/flow', receiptSourceRouter(options.auth, options.receiptAi));
  app.use('/api/flow', flowRouter(store, options.auth));
  app.use('/api/finance', financeRouter(store, options.auth, options.problems));
  app.use('/api/documents', documentsRouter(store, options.auth));
  if (options.auth && options.promptModules) promptRoutes(app, options.auth, options.promptModules);
  /** 识别要花钱、工作区里是客户文件，写操作都要业务编辑权限；读取放开。 */
  const writeGuard = (req: Request, _res: Response, next: NextFunction) => {
    if (options.auth && req.method !== 'GET')
      requirePermission(options.auth.actor(req), 'business:edit');
    next();
  };
  // 业务汇总：客户、产品、订单的列表、单条、新建、修改，六类档案的批量归档、恢复
  app.use('/api', recordsRouter(store, options.auth));
  const auth = options.auth;
  // AI 设置：改设置要超级管理员账号，权限关卡在 AI 接入的路由里
  app.use(
    '/api/ai/settings',
    aiSettingsRouter(options.aiSettings || new AiSettingsManager(), auth ? (req) => auth.actor(req) : undefined),
  );
  if (options.imports)
    app.use(
      '/api/ai/imports',
      writeGuard,
      importRouter(options.imports, (req) => options.auth?.actor(req) || null, options.receiptAi, { store, execution: options.execution }),
    );
  // 页面上报的报错存进出错记录库，助手和管理员排查时一起查（server/core/diagnostics/）
  if (options.problems)
    app.use('/api/diagnostics', pageProblemRouter(options.problems, (req) => options.auth?.actor(req) ?? null));
  app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }));
  staticSite(app);
  app.use(apiErrorHandler);
  return app;
}
