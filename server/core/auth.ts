import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { authRouter } from './auth-router.js';
import { accountRouter } from './account-router.js';
import { accountRequestRouter } from './account-request-router.js';
import { LOG_ONCE_MS, retryMinutes, Throttle } from './throttle.js';
import { AppError } from './errors.js';
import { openVersionedSqlite } from './versioned-sqlite.js';
import { accountDatabase, accountLevel, accountPermissions, accountRows, permissionList } from './account-db.js';
import { count, exists, many, one } from './sql.js';
import { clientNetwork, forwardedClient, hasProxyHeaders, proxyIngress, type Deployment } from './deployment.js';
import { localAdministratorActor } from './local-administrator.js';
import { sessionCookie } from './session-cookie.js';
import { canEnterSuperMode, isSuperMode, requireSuperModeFor } from './permissions.js';
import { HASH_BYTES, hashMatches } from './password-hash.js';
import { disconnected, HashQueue, ServerBusyError, type HashLane } from './hash-queue.js';
import type { Actor } from './actor.js';
import { AUDIT_SOURCE, DAY_MS, HOUR_MS, PASSWORD_MAX_LENGTH } from '../../shared/core/index.js';
// 测试里常从这里引 Actor（类型在 actor.ts）
export type { Actor } from './actor.js';
type Session = { userId: string; expires: number; superUntil?: number };
export type AuthOptions = {
  localAdministration?: boolean;
  deployment?: Deployment;
  /** 输错计数表最多记多少条，满了拦新来的（默认 FAILURE_LIMIT） */
  failureLimit?: number;
  /** 核对密码的那道闸（默认按 hash-queue.ts 的上限排队算 scrypt） */
  hashes?: HashQueue;
};
/** 输错计数表的上限：一条约 200 字节，20 万条约 40MB；满了不丢旧的，新来的登录先拦（见 throttle.ts） */
const FAILURE_LIMIT = 200_000;
/** 页面凭证不对时的说法（全站一句） */
export const CSRF_EXPIRED = '页面凭证已过期，请刷新页面。';
const { sessionRow, credentialRow, userIdRow, accountListRow, sessionUserRow, requestIdRow, requestListRow } = accountRows;
/** 临时密码几小时内有效 */
const TEMPORARY_PASSWORD_HOURS = 24;
const TEMPORARY_PASSWORD_LIFETIME = TEMPORARY_PASSWORD_HOURS * HOUR_MS;
/** 申请账号、忘记密码的申请留几天，过期自动清掉 */
const ACCOUNT_REQUEST_DAYS = 14;
const ACCOUNT_REQUEST_LIFETIME = ACCOUNT_REQUEST_DAYS * DAY_MS;
/** 页面凭证、密码盐的随机字节数 */
const CSRF_BYTES = 32;
const SALT_BYTES = 24;
/** 验本人密码：一个会话最多连错几次，错了以后锁多久（毫秒） */
const STEP_UP_ATTEMPTS = 5;
const STEP_UP_LOCK_MS = 300_000;
/** 去掉容易读错的 0、O、1、l、i，管理员要口头或发消息告诉对方。约 79 位随机。 */
function temporaryPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join(''),
  );
  return groups.join('-');
}
export class AuthManager {
  readonly db: DatabaseSync;
  readonly csrf = randomBytes(CSRF_BYTES).toString('hex');
  readonly sessions = new Map<string, Session>();
  private cleanup?: NodeJS.Timeout;
  /** 输错密码的计数（登录、验证本人密码），只清过期的 */
  readonly failures: Throttle;
  /** 每次提交都算的计数（申请账号、忘记密码、被拦时只记一次），满了从最早的丢；和上面分开，见 throttle.ts */
  readonly submissions: Throttle;
  private readonly hashes: HashQueue;
  constructor(
    file: string,
    readonly now: () => number = Date.now,
    readonly options: AuthOptions = {},
  ) {
    this.failures = new Throttle(now, options.failureLimit ?? FAILURE_LIMIT);
    this.hashes = options.hashes ?? new HashQueue();
    this.submissions = new Throttle(now);
    this.db = openVersionedSqlite(file, accountDatabase);
    if (options.deployment) {
      // 登录会话只有部署模式存进库（auth_sessions），本机模式只在内存里
      this.pruneSessions();
      this.cleanup = setInterval(() => {
        try { this.pruneSessions(); } catch { console.warn('未能清理过期登录会话，将在下次检查时重试。'); }
      }, HOUR_MS);
      this.cleanup.unref();
    }
  }
  /** 改密或停用后让该账号的其他会话立即失效。 */
  revokeSessions(userId: string, except?: string) {
    for (const [key, session] of this.sessions)
      if (session.userId === userId && key !== except) this.sessions.delete(key);
    // 本机找回密码脚本也须让部署进程中的旧令牌失效（表一直在，本机模式里是空的）。
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?').run(userId, except ?? '');
  }
  pruneSessions() {
    const now = this.now();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires<=?').run(now);
    for (const [key, session] of this.sessions)
      if (session.expires <= now) this.sessions.delete(key);
  }
  private session(key: string): Session | undefined {
    const session = this.sessions.get(key);
    if (!this.options.deployment) return session;
    // 每次核验持久记录，以识别另一个进程撤销的令牌。
    const row = one(this.db, sessionRow, 'SELECT user_id,expires FROM auth_sessions WHERE token_hash=?', key);
    if (!row || row.expires <= this.now()) {
      this.sessions.delete(key);
      if (row) this.pruneSessions();
      return;
    }
    if (session) return session;
    const restored = { userId: row.user_id, expires: row.expires };
    this.sessions.set(key, restored);
    return restored;
  }
  /** 访客地址，限频和申请记录用：从域名进来的按网段（clientNetwork），本机入口就是本机地址 */
  clientAddress(req: Request) {
    if (!proxyIngress(req, this.options.deployment)) return req.ip || 'local';
    const client = forwardedClient(req);
    return client ? clientNetwork(client) : 'proxy';
  }
  hashPassword(password: string) {
    const salt = randomBytes(SALT_BYTES).toString('hex');
    return { salt, hash: scryptSync(password, salt, HASH_BYTES).toString('hex') };
  }
  changeCredentials(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  requireAccountAdmin(req: Request) {
    if (req.headers['x-erp-auth-token'] !== this.csrf)
      throw new AppError('页面凭证已过期，请刷新。', 403);
    // 改账号要先进超级管理员模式（本机管理员一直算在模式里）：偷到登录状态的人没有密码就建不了管理员账号。
    // 超级管理员账号没进模式被拦的，在登录记录里记一笔：同一个会话 5 分钟只记一次（清理和登录记录一起，auth-router.ts）
    const actor = this.actor(req);
    if (actor && canEnterSuperMode(actor) && !isSuperMode(actor) && !this.submissions.hit('logged:super-mode-denied:' + this.sessionBinding(req), 1, LOG_ONCE_MS))
      this.event(actor.id, 'super-mode-denied');
    return requireSuperModeFor(actor, '管理账号');
  }
  /** 核对密码时算哈希：登录、验本人密码都过同一道闸，按 lane 走优先道或普通道（hash-queue.ts） */
  verifyHash(password: string, salt: string, lane: HashLane) {
    return this.hashes.run(password, salt, lane);
  }
  activeAdmins(excluding?: string) {
    return count(
      this.db,
      "SELECT COUNT(*) FROM users WHERE role='super_admin' AND disabled_at IS NULL AND (? IS NULL OR id<>?)",
      excluding ?? null,
      excluding ?? null,
    );
  }
  listAccounts() {
    return many(this.db, accountListRow, 'SELECT id,name,role,permissions,disabled_at FROM users ORDER BY name').map((u) => ({
      id: u.id,
      name: u.name,
      level: accountLevel(u.role, permissionList(u.permissions)),
      disabled: u.disabled_at !== null,
    }));
  }
  /** 换成临时密码：24 小时内有效，登录后必须先改，旧会话全部失效。明文只返回给调用方这一次。 */
  issueTemporaryPassword(userId: string, name: string, actorId: string, action: string) {
    const password = temporaryPassword(),
      { salt, hash } = this.hashPassword(password);
    this.changeCredentials(() => {
      this.db
        .prepare('UPDATE users SET salt=?,password_hash=?,must_change_password=1,temp_password_expires=? WHERE id=?')
        .run(salt, hash, this.now() + TEMPORARY_PASSWORD_LIFETIME, userId);
      this.revokeSessions(userId);
      this.db.prepare("DELETE FROM account_requests WHERE kind='reset' AND name=?").run(name);
      this.event(actorId, action);
    });
    return password;
  }
  /** 命令行找回入口：管理员自己忘记密码时在服务器本机运行。 */
  resetPassword(name: string) {
    const user = one(this.db, userIdRow, 'SELECT id FROM users WHERE name=?', name);
    if (!user) throw new AppError('账号不存在。', 404);
    return this.issueTemporaryPassword(user.id, name, user.id, 'password-reset-cli');
  }
  pruneRequests() {
    const before = this.now() - ACCOUNT_REQUEST_LIFETIME;
    const expired = many(this.db, requestIdRow, 'SELECT id FROM account_requests WHERE created_at<=?', before);
    if (!expired.length) return;
    this.db.prepare('DELETE FROM account_requests WHERE created_at<=?').run(before);
    for (const row of expired) this.event(null, 'account-request-expired:' + row.id);
  }
  listRequests() {
    this.pruneRequests();
    return many(
      this.db,
      requestListRow,
      `SELECT r.id,r.kind,r.name,r.note,r.client,r.created_at,u.id AS user_id
       FROM account_requests r LEFT JOIN users u ON u.name=r.name ORDER BY r.created_at,r.id`,
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      note: r.note,
      client: r.client,
      createdAt: new Date(r.created_at).toISOString(),
      nameTaken: r.kind === 'register' && r.user_id !== null,
    }));
  }
  pendingRequests() {
    this.pruneRequests();
    return count(this.db, 'SELECT COUNT(*) FROM account_requests');
  }
  event(id: string | null, action: string) {
    this.db
      .prepare('INSERT INTO auth_events(at,actor_id,action) VALUES(?,?,?)')
      .run(new Date(this.now()).toISOString(), id, action);
  }
  sessionBinding(req: IncomingMessage) {
    const prefix = sessionCookie(req, this.options.deployment).name + '=';
    const token = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(prefix))
      ?.slice(prefix.length);
    return token && /^[a-f0-9]{64}$/.test(token)
      ? createHash('sha256').update(token).digest('hex')
      : '';
  }
  configured() {
    return exists(this.db, 'SELECT id FROM users LIMIT 1');
  }
  /** 业务接口看到的账号。还没改掉临时密码的会话一律当未登录。只看请求头和连接，express 之前的原始请求也能用。 */
  actor(req: IncomingMessage): Actor | null {
    const actor = this.sessionActor(req);
    return actor?.mustChangePassword ? null : actor;
  }
  /** 这个请求登录的账号；没登录（或中途退出了）报 401“请先登录管理账号。” */
  signedIn(req: IncomingMessage): Actor {
    const actor = this.actor(req);
    if (!actor) throw new AppError('请先登录管理账号。', 401);
    return actor;
  }
  sessionActor(req: IncomingMessage): Actor | null {
    const key = this.sessionBinding(req);
    if (!key) return null;
    const s = this.session(key);
    if (!s || s.expires < this.now()) {
      this.sessions.delete(key);
      return null;
    }
    const row = one(
      this.db,
      sessionUserRow,
      'SELECT name,permissions,role,disabled_at,must_change_password FROM users WHERE id=?',
      s.userId,
    );
    const user = row && row.disabled_at === null ? row : undefined;
    const owner =
      !!user &&
      user.role === 'super_admin' &&
      this.options.localAdministration === true &&
      this.localRequest(req);
    const result: Actor | null = user
      ? {
          // 登录会话就是页面这个入口；助手、数据管理的入口拿到后换成自己的（audit.ts 的 viaEntry）
          source: AUDIT_SOURCE.page,
          id: s.userId,
          name: user.name,
          permissions: accountPermissions(user.role, user.permissions),
          role: user.role,
          superAdminMode:
            owner || (user.role === 'super_admin' && (s.superUntil || 0) > this.now()),
          superAdminUntil: owner
            ? s.expires
            : user.role === 'super_admin' && (s.superUntil || 0) > this.now()
              ? s.superUntil
              : undefined,
          ...(user.must_change_password ? { mustChangePassword: true } : {}),
        }
      : null;
    return owner && result ? localAdministratorActor(result) : result;
  }
  private localRequest(req: IncomingMessage) {
    if (this.options.deployment && (proxyIngress(req, this.options.deployment) || hasProxyHeaders(req))) return false;
    const remote = req.socket.remoteAddress || '';
    const host = (req.headers.host || '').toLowerCase();
    return (
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) &&
      /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) &&
      !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(
        (k) => req.headers[k],
      )
    );
  }
  /**
   * 页面凭证（请求头 X-ERP-Auth-Token）对不对：全站只在这里判断、只有这一句说法。
   * 装配层对所有写接口统一检查（server/http-guards.ts）；读接口也要凭证的路由自己调它。
   */
  requireCsrf(req: Request) {
    if (req.headers['x-erp-auth-token'] !== this.csrf) throw new AppError(CSRF_EXPIRED, 403);
  }
  verifyPassword(req: Request, password: unknown) {
    return this.checkPassword(req, this.signedIn(req), password);
  }
  /**
   * 验本人密码（进超级管理员模式、改密码、删除确认）。按会话计、不看地址：偷到登录状态的人换地址也只有这一个会话的
   * 5 次，又锁不住本人别的会话（本人还能改密码把他踢掉）。算哈希和登录排同一道闸（verifyHash）。
   */
  async checkPassword(req: Request, actor: Actor, password: unknown) {
    const attemptKey = 'step:' + this.sessionBinding(req),
      wait = this.failures.retryAfter(attemptKey, STEP_UP_ATTEMPTS);
    if (wait) {
      // 被限流 5 分钟只记一次
      if (!this.submissions.hit('logged:' + attemptKey, 1, LOG_ONCE_MS)) this.event(actor.id, 'step-up-throttled');
      throw new AppError('密码验证次数过多，请' + retryMinutes(wait) + '分钟后重试。', 429);
    }
    if (this.failures.full(attemptKey)) throw new ServerBusyError();
    if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX_LENGTH)
      throw new AppError('请输入当前账号密码。');
    const user = one(this.db, credentialRow, 'SELECT salt,password_hash FROM users WHERE id=?', actor.id);
    // 会话里的账号在库里没有了（被删了）：和会话失效一样，请重新登录
    if (!user) throw new AppError('请先登录管理账号。', 401, 'authentication');
    // 先按输错记下再算（同时发来的不能一起越过 5 次），对了、或者服务器正忙没算成，再退回
    this.failures.failed(attemptKey, STEP_UP_LOCK_MS);
    let hash: Buffer;
    try {
      hash = await this.verifyHash(password, user.salt, { priority: true, signal: disconnected(req) });
    } catch (error) {
      this.failures.forgive(attemptKey);
      throw error;
    }
    // 算的时候会话可能被撤了、账号停用了、密码被改了：会话按现在的样子重读，账号行按编号重读，对不上都算没通过，后面的事不办
    const current = this.sessionActor(req);
    if (current?.id !== actor.id) {
      this.failures.forgive(attemptKey);
      throw new AppError('请先登录管理账号。', 401, 'authentication');
    }
    const now = one(this.db, credentialRow, 'SELECT salt,password_hash FROM users WHERE id=?', actor.id);
    if (!now || now.salt !== user.salt || now.password_hash !== user.password_hash || !hashMatches(hash, now.password_hash, actor.id)) {
      this.event(actor.id, 'step-up-failed');
      throw new AppError('当前账号密码不正确。', 401);
    }
    this.failures.cleared(attemptKey);
    return current;
  }
  /** 账号的接口（/api/auth），见 auth-router.ts */
  router() {
    return authRouter(this).use(accountRequestRouter(this)).use(accountRouter(this));
  }
  close() {
    clearInterval(this.cleanup);
    this.sessions.clear();
    this.db.close();
  }
}
