import type { z } from 'zod';
import type {
  accountApplySchema,
  accountCreateSchema,
  accountUpdateSchema,
  loginSchema,
  passwordChangeSchema,
  passwordForgotSchema,
  requestApproveSchema,
  setupSchema,
  superModeEnterSchema,
} from './account-input.js';
import type { AccountLevel, AccountRequestKind, UserRole } from './accounts.js';
import type { Empty } from './api-table.js';
import type { AuditSource } from './audit-sources.js';

/*
 * 登录和账号的接口表（/api/auth，服务端 server/core 的 auth-router.ts、login-route.ts、account-request-router.ts、
 * account-router.ts）。表的写法见 api-table.ts；正文照服务端的 zod 规则（account-input.ts）的输入写。
 * 没登录也能调的：GET /auth/state、POST /auth/setup、/auth/login、/auth/apply、/auth/forgot（要登录页拿到的页面凭证）。
 * 登录、建首个管理员、申请、忘记密码、退出被拒时只回 { message }（不带 code），退出的页面凭证不对只回 403 状态码。
 */

/** 页面看到的登录账号：服务端的 Actor（server/core/actor.ts）原样发出，本机管理员的标记是符号属性，不进 JSON */
type SessionActor = {
  source: AuditSource;
  id: string;
  name: string;
  permissions: string[];
  role?: UserRole;
  superAdminUntil?: number;
  superAdminMode?: boolean;
  localAdministrator?: boolean;
  /** 用临时密码登录、还没改：只有 /auth/state 能看到这个账号，别的接口一律当没登录 */
  mustChangePassword?: boolean;
};
/** 登录、建首个管理员成功时回的账号 */
type SignedIn = { actor: Pick<SessionActor, 'id' | 'name' | 'permissions' | 'mustChangePassword'> & { role: UserRole } };
type AuthStateView = {
  configured: boolean;
  actor: SessionActor | null;
  /** 登录着才有 */
  level?: AccountLevel;
  /** 超级管理员账号（改完临时密码的）才有：待处理的申请账号和忘记密码 */
  pendingRequests?: number;
  csrf: string;
  /** 部署模式才有：从域名（代理）进来的 proxyAccess 是 true */
  deploymentMode?: boolean;
  proxyAccess?: boolean;
};

/** 账号列表的一行（不含密码） */
export type AccountView = { id: string; name: string; level: AccountLevel; disabled: boolean };
/** 待处理的申请：nameTaken 是申请账号的名字已经有人用了 */
export type AccountRequestView = {
  id: string;
  kind: AccountRequestKind;
  name: string;
  note: string;
  client: string;
  createdAt: string;
  nameTaken: boolean;
};
type Users = { users: AccountView[] };
type Requests = { requests: AccountRequestView[] };
type Done = { ok: true };

export type AccountApi = {
  'GET /auth/state': { response: AuthStateView };
  'POST /auth/setup': { body: z.input<typeof setupSchema>; response: SignedIn };
  'POST /auth/login': { body: z.input<typeof loginSchema>; response: SignedIn };
  /** 服务端不看正文，页面发 {} */
  'POST /auth/logout': { body: Empty; response: Done };
  'POST /auth/password': { body: z.input<typeof passwordChangeSchema>; response: Done };
  /** action 是 enter（带本人密码）或 exit（空正文）；回进出以后的账号 */
  'POST /auth/super-admin/:action': {
    body: z.input<typeof superModeEnterSchema> | Empty;
    response: { actor: SessionActor | null };
  };
  /** 申请账号、忘记密码：不管名字有没有，成功都回 202 和同一句 */
  'POST /auth/apply': { body: z.input<typeof accountApplySchema>; response: Done };
  'POST /auth/forgot': { body: z.input<typeof passwordForgotSchema>; response: Done };
  'GET /auth/users': { response: Users };
  /** 建号成功回 201 */
  'POST /auth/users': { body: z.input<typeof accountCreateSchema>; response: Users };
  'PUT /auth/users/:id': { body: z.input<typeof accountUpdateSchema>; response: Users };
  /** 发临时密码：明文只这一次 */
  'POST /auth/users/:id/password': { body: Empty; response: Requests & { temporaryPassword: string } };
  'GET /auth/requests': { response: Requests };
  /** 批准忘记密码的申请时多回临时密码 */
  'POST /auth/requests/:id/approve': {
    body: z.input<typeof requestApproveSchema>;
    response: Requests & Users & { temporaryPassword?: string };
  };
  'POST /auth/requests/:id/reject': { body: Empty; response: Requests };
};
