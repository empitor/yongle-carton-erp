import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Request } from 'express';
import type { z } from 'zod';
import { DAY_MS, HOUR_MS, MINUTE_MS, loginSchema, passwordHint, setupSchema } from '../../shared/core/index.js';
import { accountPermissions, accountRows, levelGrant } from './account-db.js';
import type { AuthRoute, AuthRoutesHost } from './auth-router.js';
import { proxyIngress } from './deployment.js';
import { disconnected, ServerBusyError, type HashLane } from './hash-queue.js';
import { hashMatches } from './password-hash.js';
import { refuse, type RouteReply } from './route.js';
import { sessionCookie } from './session-cookie.js';
import { one } from './sql.js';
import { LOG_ONCE_MS, retryMinutes } from './throttle.js';

/*
 * 登录和建首个管理员（/api/auth/login、/api/auth/setup，正文规则在 shared/core/account-input.ts）：
 * 限频 → 排队核对密码 → 建会话，各一个小函数。路由的其余部分在 auth-router.ts。
 * 被拒时只回 { message }（refuse，不带 code），和登录页认的一样。
 */

/** 会话几小时有效；会话令牌的随机字节数 */
const SESSION_HOURS = 8,
  SESSION_TOKEN_BYTES = 32;
const SESSION_LIFETIME = SESSION_HOURS * HOUR_MS;
/**
 * 登录限频：同一网段同一账号名、同一网段、同一账号名跨网段（只算从域名来的）各几次，
 * 前两条按 5 分钟窗口算，跨网段的按 15 分钟
 */
const LOGIN_LIMITS = { perAccount: 5, perNetwork: 30, perName: 20 },
  WINDOW_MINUTES = { login: 5, name: 15 };
const LOGIN_WINDOW = WINDOW_MINUTES.login * MINUTE_MS,
  NAME_WINDOW = WINDOW_MINUTES.name * MINUTE_MS;
/** 登录类的记录（成功、失败、被限流，没进模式改账号被拦）留多久：公网上会有人反复试，不让账号库越记越大 */
const LOGIN_EVENT_DAYS = 90;
type Limit = [key: string, limit: number, windowMs: number];
/** 账号库 users 的一行 */
type UserRow = z.output<typeof accountRows.user>;

/** 记一条登录记录（不记口令），顺手清掉过期的（诊断里的登录记录读这些，server/system/login-records.ts） */
function loginEvent(auth: AuthRoutesHost, userId: string | null, action: string) {
  auth.event(userId, action);
  auth.db
    .prepare("DELETE FROM auth_events WHERE (action LIKE 'login%' OR action='super-mode-denied') AND at<?")
    .run(new Date(auth.now() - LOGIN_EVENT_DAYS * DAY_MS).toISOString());
}

/**
 * 这次登录要看的几条限频：办公室共用一个公网出口，按“网段 + 账号”限流，一个人输错不影响同事；同一网段另设总上限，
 * 防止换账号名撞密码；从域名进来的，同一账号名跨网段再设总上限，防止换地址猜一个人的密码（维护通道不算，管理员被人锁住时
 * 还能从服务器登录）。账号名存不存在都一样计，不暴露谁有账号。
 */
function loginLimits(client: string, name: string, fromDomain: boolean): Limit[] {
  return [
    ['login:' + client + ':' + name, LOGIN_LIMITS.perAccount, LOGIN_WINDOW],
    ['login-ip:' + client, LOGIN_LIMITS.perNetwork, LOGIN_WINDOW],
    ...(fromDomain ? [['login-name:' + name, LOGIN_LIMITS.perName, NAME_WINDOW] as Limit] : []),
  ];
}

/** 被限流时还要等多少毫秒（0 是没被拦）；被拦的同一账号名 5 分钟只记一次，免得有人换地址刷接口把记录写满 */
function throttled(auth: AuthRoutesHost, limits: Limit[], name: string) {
  const wait = Math.max(...limits.map(([key, limit]) => auth.failures.retryAfter(key, limit)));
  if (wait && !auth.submissions.hit('logged:login:' + name, 1, LOG_ONCE_MS)) {
    const known = one(auth.db, accountRows.userIdRow, 'SELECT id FROM users WHERE name=?', name);
    loginEvent(auth, known ? known.id : null, 'login-throttled');
  }
  return wait;
}

/**
 * 排队核对密码，对上了返回账号行，对不上返回 null（已记登录失败）。先按输错记下再算：同时发来的一批请求不能趁算的时候
 * 一起越过上限；密码对了、或者排队没排上，再退回。算的时候账号可能改了密码、被停用：按编号重新读一次，哈希变了就当
 * 密码错（不然用旧密码的这次登录能留下会话）。
 */
async function verifyLogin(auth: AuthRoutesHost, name: string, password: string, limits: Limit[], lane: HashLane) {
  // 输错计数表满了：拦新来的（不丢旧的计数），说服务器正忙，不算输错
  if (limits.some(([key]) => auth.failures.full(key))) throw new ServerBusyError();
  const found = one(auth.db, accountRows.user, 'SELECT * FROM users WHERE name=?', name);
  for (const [key, , windowMs] of limits) auth.failures.failed(key, windowMs);
  let hash: Buffer;
  try {
    hash = await auth.verifyHash(password, found?.salt || 'invalid-account-salt', lane);
  } catch (error) {
    for (const [key] of limits) auth.failures.forgive(key);
    throw error;
  }
  const user = found && one(auth.db, accountRows.user, 'SELECT * FROM users WHERE id=?', found.id);
  const same = !!user && !!found && user.salt === found.salt && user.password_hash === found.password_hash;
  if (!user || !same || !hashMatches(hash, user.password_hash, user.id)) {
    // 没有这个账号时不记输入的名字（有人会把密码误输进用户名框）
    loginEvent(auth, found ? found.id : null, found ? 'login-failed' : 'login-failed-unknown');
    return null;
  }
  for (const [key] of limits) auth.failures.forgive(key);
  return user;
}

/** 建会话、写 Cookie，返回给页面的账号 */
function openSession(auth: AuthRoutesHost, req: Request, reply: RouteReply, user: UserRow) {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex'),
    actor = {
      id: user.id,
      name: user.name,
      permissions: accountPermissions(user.role, user.permissions),
      role: user.role,
      ...(user.must_change_password ? { mustChangePassword: true } : {}),
    };
  const key = createHash('sha256').update(token).digest('hex');
  const expires = auth.now() + SESSION_LIFETIME;
  if (auth.options.deployment) {
    auth.pruneSessions();
    auth.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires) VALUES(?,?,?)').run(key, actor.id, expires);
  }
  auth.sessions.set(key, { userId: actor.id, expires });
  const cookie = sessionCookie(req, auth.options.deployment);
  reply.cookie(cookie.name, token, { ...cookie.options, maxAge: SESSION_LIFETIME });
  loginEvent(auth, actor.id, 'login');
  return actor;
}

/** 首个账号就是管理员级别 */
function createFirstAdmin(auth: AuthRoutesHost, name: string, password: string) {
  const { salt, hash } = auth.hashPassword(password),
    grant = levelGrant.admin;
  auth.db
    .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), name, salt, hash, JSON.stringify(grant.permissions), grant.role);
}

/** 登录、建首个管理员的一次请求：是不是建首个管理员、正文、请求、写会话 Cookie 用的 reply */
type SignIn = { setup: boolean; body: unknown; req: Request; reply: RouteReply };

async function signIn(auth: AuthRoutesHost, { setup, body, req, reply }: SignIn) {
  if (req.headers['x-erp-auth-token'] !== auth.csrf) return refuse(403, '登录页面已过期，请刷新。');
  const parsed = (setup ? setupSchema : loginSchema).safeParse(body);
  if (!parsed.success) return refuse(400, setup ? '请输入用户名，密码' + passwordHint + '。' : '请输入用户名和密码。');
  const v = parsed.data;
  const fromDomain = proxyIngress(req, auth.options.deployment);
  if (setup && fromDomain) return refuse(403, '请在服务器本机建立首个管理员账号。');
  if (setup && auth.configured()) return refuse(409, '管理员已经建立，请登录。');
  const client = auth.clientAddress(req),
    limits = loginLimits(client, v.name, fromDomain);
  const wait = throttled(auth, limits, v.name);
  if (wait) return refuse(429, '尝试次数过多，请' + retryMinutes(wait) + '分钟后重试。');
  if (setup) createFirstAdmin(auth, v.name, v.password);
  // 从域名来的走普通道（同一网段同时在道里的有上限），本机入口（维护通道）走优先道，没登录的人刷再多也挤不掉
  const signal = disconnected(req);
  const user = await verifyLogin(auth, v.name, v.password, limits, fromDomain ? { network: client, signal } : { priority: true, signal });
  if (!user) return refuse(401, '用户名或密码错误。');
  if (user.disabled_at !== null) {
    loginEvent(auth, String(user.id), 'login-disabled');
    return refuse(403, '该账号已停用，请联系管理员。');
  }
  if (user.must_change_password && Number(user.temp_password_expires) <= auth.now()) {
    loginEvent(auth, String(user.id), 'login-expired');
    return refuse(401, '临时密码已过期，请重新申请。');
  }
  auth.failures.cleared(limits[0][0]);
  // 能用原密码登录，说明之前的“忘记密码”申请已经不需要了。
  if (!user.must_change_password)
    auth.db.prepare("DELETE FROM account_requests WHERE kind='reset' AND name=?").run(user.name);
  return { actor: openSession(auth, req, reply, user) };
}

export function loginRoutes(on: AuthRoute, auth: AuthRoutesHost) {
  on('POST /auth/setup', ({ body, req, reply }) => signIn(auth, { setup: true, body, req, reply }));
  on('POST /auth/login', ({ body, req, reply }) => signIn(auth, { setup: false, body, req, reply }));
}
