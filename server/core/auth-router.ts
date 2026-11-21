import type { DatabaseSync } from 'node:sqlite';
import { Router, type Request } from 'express';
import {
  MINUTE_MS,
  emptyBodySchema,
  passwordChangeSchema,
  superModeEnterSchema,
  type AccountApi,
  type AccountRequestView,
  type AccountView,
} from '../../shared/core/index.js';
import type { Actor } from './actor.js';
import { accountLevel } from './account-db.js';
import type { Deployment } from './deployment.js';
import { proxyIngress } from './deployment.js';
import { AppError } from './errors.js';
import { isLocalAdministrator } from './local-administrator.js';
import { canEnterSuperMode } from './permissions.js';
import type { Throttle } from './throttle.js';
import type { HashLane } from './hash-queue.js';
import { sessionCookie } from './session-cookie.js';
import { loginRoutes } from './login-route.js';
import { done, refuse, route } from './route.js';

/*
 * 登录相关的接口（/api/auth，接口表 shared/core/account-api.ts）：登录状态、退出、改密码、进出超级管理员模式；登录和首个管理员在 login-route.ts。
 * 申请账号和忘记密码在 account-request-router.ts，管理员管理账号和处理申请在 account-router.ts。只管请求和回答，账号、会话、密码的读写在 auth.ts 的 AuthManager（以参数传进来）。
 */

/** 路由要用的 AuthManager 能力（AuthManager 按这个形状把自己传进来；这里和 account-router.ts 都不引用 auth.ts） */
export type AuthRoutesHost = {
  readonly csrf: string;
  readonly db: DatabaseSync;
  readonly sessions: Map<string, { userId: string; expires: number; superUntil?: number }>;
  readonly failures: Throttle;
  readonly submissions: Throttle;
  readonly options: { localAdministration?: boolean; deployment?: Deployment };
  now(): number;
  configured(): boolean;
  sessionActor(req: Request): Actor | null;
  actor(req: Request): Actor | null;
  signedIn(req: Request): Actor;
  sessionBinding(req: Request): string;
  verifyPassword(req: Request, password: unknown): Promise<Actor>;
  checkPassword(req: Request, actor: Actor, password: unknown): Promise<Actor>;
  verifyHash(password: string, salt: string, lane: HashLane): Promise<Buffer>;
  clientAddress(req: Request): string;
  hashPassword(password: string): { salt: string; hash: string };
  changeCredentials(action: () => void): void;
  revokeSessions(userId: string, except?: string): void;
  pruneSessions(): void;
  pruneRequests(): void;
  pendingRequests(): number;
  listAccounts(): AccountView[];
  listRequests(): AccountRequestView[];
  requireAccountAdmin(req: Request): Actor;
  activeAdmins(excluding?: string): number;
  issueTemporaryPassword(userId: string, name: string, actorId: string, action: string): string;
  event(id: string | null, action: string): void;
};

/** 登录和账号的几个路由文件注册用的：挂在 /api/auth 下，键写完整地址 */
export const authRoute = (router: Router) => route<AccountApi>(router, '/auth');
export type AuthRoute = ReturnType<typeof authRoute>;

export function authRouter(auth: AuthRoutesHost) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const on = authRoute(router);
  on('GET /auth/state', ({ req }) => {
    const actor = auth.sessionActor(req),
      { deployment } = auth.options,
      proxied = proxyIngress(req, deployment);
    return {
      configured: auth.configured(),
      actor,
      ...(actor ? { level: accountLevel(String(actor.role), actor.permissions) } : {}),
      ...(actor?.role === 'super_admin' && !actor.mustChangePassword ? { pendingRequests: auth.pendingRequests() } : {}),
      csrf: auth.csrf,
      ...(deployment ? { deploymentMode: true, proxyAccess: proxied } : {}),
      // 备案号跟着域名走：只给从域名进来的页面，本机入口不给
      ...(proxied && deployment?.filing ? { filing: deployment.filing } : {}),
    };
  });
  superModeRoute(on, auth);
  loginRoutes(on, auth);
  // 页面凭证不对只回 403 状态码（正文是 express 的 Forbidden 文字），页面换新凭证重发
  on('POST /auth/logout', ({ req, reply }) => {
    if (req.headers['x-erp-auth-token'] !== auth.csrf) return refuse(403);
    const key = auth.sessionBinding(req);
    if (key) {
      auth.sessions.delete(key);
      if (auth.options.deployment) auth.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(key);
    }
    const cookie = sessionCookie(req, auth.options.deployment);
    reply.clearCookie(cookie.name, cookie.options);
    return done;
  });
  passwordRoute(on, auth);
  return router;
}

/** 超级管理员模式一次多久 */
const SUPER_MODE_MINUTES = 15;

/** 进出超级管理员模式：只有超级管理员账号能进，验本人密码，15 分钟；本机管理员一直算在模式里 */
function superModeRoute(on: AuthRoute, auth: AuthRoutesHost) {
  on('POST /auth/super-admin/:action', async ({ param, body, req }) => {
    if (req.headers['x-erp-auth-token'] !== auth.csrf) throw new AppError('页面凭证已过期，请刷新。', 403);
    const actor = auth.signedIn(req);
    // 能不能进超级管理员模式只看 permissions.ts 的 canEnterSuperMode（各处拒绝也按它分类）
    if (!canEnterSuperMode(actor))
      throw new AppError('当前账号不是超级管理员账号，进不了超级管理员模式。', 403, 'permission');
    if (isLocalAdministrator(actor)) return { actor };
    // 账号是从这个会话认出来的，会话一定在；不在就按没登录说
    const session = auth.sessions.get(auth.sessionBinding(req));
    if (!session) throw new AppError('请先登录管理账号。', 401);
    const action = param('action');
    if (action === 'enter') {
      const input = superModeEnterSchema.parse(body);
      await auth.verifyPassword(req, input.password);
      session.superUntil = auth.now() + SUPER_MODE_MINUTES * MINUTE_MS;
      auth.event(actor.id, 'super-mode-enter');
    } else if (action === 'exit') {
      emptyBodySchema.parse(body);
      session.superUntil = 0;
      auth.event(actor.id, 'super-mode-exit');
    } else throw new AppError('操作不存在。', 404);
    return { actor: auth.actor(req) };
  });
}

/** 改自己的密码：先验当前密码；改完别的设备全部下线，这台留着 */
function passwordRoute(on: AuthRoute, auth: AuthRoutesHost) {
  on('POST /auth/password', async ({ body, req }) => {
    if (req.headers['x-erp-auth-token'] !== auth.csrf) throw new AppError('页面凭证已过期，请刷新。', 403);
    const input = passwordChangeSchema.parse(body);
    // 临时密码登录的会话也要能走到这里，所以不用 actor()。
    const session = auth.sessionActor(req);
    if (!session) throw new AppError('请先登录管理账号。', 401);
    const actor = await auth.checkPassword(req, session, input.current);
    if (input.current === input.password) throw new AppError('新密码不能和当前密码相同。');
    const { salt, hash } = auth.hashPassword(input.password);
    auth.changeCredentials(() => {
      auth.db
        .prepare('UPDATE users SET salt=?,password_hash=?,must_change_password=0,temp_password_expires=NULL WHERE id=?')
        .run(salt, hash, actor.id);
      auth.db.prepare("DELETE FROM account_requests WHERE kind='reset' AND name=?").run(actor.name);
      auth.revokeSessions(actor.id, auth.sessionBinding(req));
      auth.event(actor.id, 'password-changed');
    });
    return done;
  });
}
