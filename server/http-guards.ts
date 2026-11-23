import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { financeOnlyAccount, financeOnlyApiAllowed } from '../shared/core/index.js';
import type { AuthManager } from './accounts/index.js';
import { forwardedClient, hasProxyHeaders, proxyIngress, recordFailedRequests, type Deployment, type ProblemLog } from './core/index.js';
import { DEFAULT_PORT } from './local-service.js';

/*
 * 请求进到各模块路由之前的关卡（原来写在 server/app.ts）：安全响应头、只许本机或登记的代理域名、
 * 来源和请求格式、出纳只看财务、要登录、写接口要页面凭证。
 */

/** 收原文件（不是 JSON）的上传入口：别的写接口一律只收 JSON */
const rawUploadPaths = [
  '/api/ai/imports/upload',
  '/api/assistant/transcribe',
  '/api/finance/bank/upload',
  '/api/finance/attachments/upload',
  '/api/finance/payroll/upload',
];
const rawUploadPattern = /^\/api\/assistant\/threads\/[0-9a-f-]{36}\/attachments$/;
/** 自己读请求体的上传（收件箱、唛头），不走 JSON 解析 */
const streamedUpload = (path: string) => path === '/api/inbox/upload' || /^\/api\/products\/[1-9]\d*\/marks\/upload$/.test(path);
/** 统一成小写单斜杠：路由不分大小写、也认连续斜杠，判断前先统一，免得换个写法绕过 */
const normalized = (path: string) => path.toLowerCase().replace(/\/{2,}/g, '/');
/** 只读的请求方法：不查来源、格式和页面凭证 */
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** 主机名不许时回给页面的话；许可时为空 */
function hostRefusal(req: Request, host: string, deployment: Deployment | undefined, viaProxy: boolean) {
  if (deployment && viaProxy)
    return !deployment.hosts.has(host.toLowerCase()) || !forwardedClient(req) ? '代理域名或访客地址不允许' : undefined;
  const local = deployment
    ? /^(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host) && !hasProxyHeaders(req)
    : ['localhost', '127.0.0.1'].includes(host.split(':')[0]);
  return local ? undefined : '仅允许本机访问';
}

/** 写请求带的来源不是本页时为真 */
function foreignOrigin(origin: string, host: string, deployment: Deployment | undefined, viaProxy: boolean) {
  if (deployment && viaProxy) return !deployment.origins.has(origin);
  // 走到这里的非代理请求 Host 已确认是本机回环；来源和 Host 一致就是本页发出的，
  // 这样 SSH 隧道映射到任意本机端口（如 13001）也能维护。
  const port = process.env.PORT || DEFAULT_PORT;
  const allowed = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    `http://${host.toLowerCase()}`,
  ];
  return !allowed.includes(origin);
}

/** 写请求只收 JSON；原文件上传入口收二进制，自己读请求体的上传另算 */
function acceptedBody(req: Request) {
  const rawUpload =
    req.method === 'POST' &&
    (rawUploadPaths.includes(req.path) || rawUploadPattern.test(req.path)) &&
    req.is('application/octet-stream');
  return req.is('application/json') || rawUpload || streamedUpload(req.path);
}

/** 只许本机或登记的代理域名（从代理进来的加 HSTS），写请求再查来源和格式 */
const ingressGuard = (deployment: Deployment | undefined) => (req: Request, res: Response, next: NextFunction) => {
  const viaProxy = proxyIngress(req, deployment);
  const host = req.headers.host || '';
  const refused = hostRefusal(req, host, deployment, viaProxy);
  if (refused) return res.status(403).json({ message: refused });
  if (deployment && viaProxy) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (!READ_METHODS.includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && foreignOrigin(origin, host, deployment, viaProxy))
      return res.status(403).json({ message: '请求来源不允许' });
    if (!acceptedBody(req))
      return res.status(415).json({ message: '请使用 JSON 请求；文件仅允许从导入上传入口提交。' });
  }
  next();
};

/** 启用账号体系后：除健康检查与登录接口外的全部 API 都要有效会话（写入权限仍由各业务服务校验），写接口都要页面凭证 */
function installSessionGuards(app: Express, auth: AuthManager) {
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/auth' || req.path.startsWith('/auth/')) return next();
    if (!auth.actor(req)) return res.status(401).json({ message: '请先登录账号。', code: 'authentication' });
    next();
  });
  // 写接口都要页面凭证，全站在这里查一次（说法见 AuthManager.requireCsrf）。
  // 不查的：登录接口（登录页自己的凭证和说法）、AI 接入和识别导入的接口（/api/ai/，用 AI 页面自己的凭证）。
  app.use('/api', (req, _res, next) => {
    const path = normalized(req.path);
    if (READ_METHODS.includes(req.method) || path === '/auth' || path.startsWith('/auth/') || path.startsWith('/ai/'))
      return next();
    auth.requireCsrf(req);
    next();
  });
}

export function installRequestGuards(
  app: Express,
  options: { auth?: AuthManager; deployment?: Deployment; problems?: ProblemLog },
) {
  app.disable('x-powered-by');
  // 最先装：后面各道关卡、各模块路由回的失败都记进最近出错（server/core/diagnostics/request-recorder.ts）
  const problems = options.problems;
  if (problems)
    app.use(
      recordFailedRequests(problems, {
        actorOf: (req) => options.auth?.actor(req) ?? null,
        clientOf: (req) => options.auth?.clientAddress(req) ?? req.ip ?? '',
      }),
    );
  app.use(
    helmet({
      // 图片多放行 blob:：Word 排版预览把文件里的公司标志转成 blob 地址显示，其余沿用 helmet 默认
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null, imgSrc: ["'self'", 'data:', 'blob:'] } },
      strictTransportSecurity: false,
    }),
  );
  app.use(ingressGuard(options.deployment));
  app.use((req, res, next) => (streamedUpload(req.path) ? next() : express.json({ limit: '128kb' })(req, res, next)));
  // 出纳这类纯财务账号只看财务：订单、客户文件、收件箱等业务接口一律拒绝（读也不行）。
  app.use((req, res, next) => {
    // 助手的一键清空只能在服务器本机做（拒绝代理入口），这里记下请求从哪个入口进来。
    res.locals.proxyIngress = proxyIngress(req, options.deployment);
    if (
      options.auth &&
      normalized(req.path).startsWith('/api') &&
      !financeOnlyApiAllowed(req.path) &&
      financeOnlyAccount(options.auth.actor(req))
    )
      return res.status(403).json({ message: '出纳账号只能查看财务数据。' });
    next();
  });
  if (options.auth) installSessionGuards(app, options.auth);
}
