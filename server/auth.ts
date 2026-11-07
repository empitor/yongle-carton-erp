import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ImportError } from './import/errors.js';
import { financePermissions } from '../shared/finance.js';
import { passwordAllowed, passwordHint } from '../shared/password-policy.js';
import { forwardedClient, hasProxyHeaders, proxyIngress, type Deployment } from './deployment.js';
import {
  developerActor,
  localDevelopmentEnabled,
  localAdministratorActor,
  isLocalAdministrator,
} from './developer-capability.js';
export type Actor = {
  id: string;
  name: string;
  permissions: string[];
  role?: 'admin' | 'super_admin';
  superAdminUntil?: number;
  superAdminMode?: boolean;
  developerMode?: boolean;
  localAdministrator?: boolean;
  /** 用临时密码登录、还没改密码。只有 /auth/state 能看到，其他接口一律当未登录。 */
  mustChangePassword?: boolean;
};
const newPassword = z.string().refine(passwordAllowed, '密码' + passwordHint + '。');
const account = z.strictObject({
  name: z.string().trim().min(1).max(60),
  password: newPassword,
});
/** 登录不校验长度：长度提示放在建号和改密，登录只回答“对”或“错”。 */
const credentials = z.strictObject({
  name: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(128),
});
type Session = { userId: string; expires: number; superUntil?: number; developer?: boolean };
const TEMPORARY_PASSWORD_LIFETIME = 24 * 3600_000;
const ACCOUNT_REQUEST_LIFETIME = 14 * 24 * 3600_000;
const PENDING_ACCOUNT_LIMIT = 50;
/** 去掉容易读错的 0、O、1、l、i，管理员要口头或发消息告诉对方。约 79 位随机。 */
function temporaryPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join(''),
  );
  return groups.join('-');
}
export const accountLevels = ['admin', 'staff', 'viewer', 'finance', 'cashier'] as const;
/** 账号级别映射到现有的角色和权限：只读账号没有写权限，各业务服务的校验自然拒绝。 */
const levelGrant: Record<(typeof accountLevels)[number], { role: string; permissions: string[] }> = {
  admin: { role: 'super_admin', permissions: ['business:edit', 'import:execute', 'import:restore'] },
  staff: { role: 'admin', permissions: ['business:edit', 'import:execute'] },
  viewer: { role: 'admin', permissions: [] },
  finance: { role: 'admin', permissions: ['business:edit', 'finance:view', 'finance:edit', 'finance:approve', 'finance:close'] },
  cashier: { role: 'admin', permissions: ['finance:view', 'finance:cash'] },
};
function accountLevel(role: string, permissions: string[]) {
  if (role !== 'super_admin' && permissions.includes('finance:close')) return 'finance';
  if (role !== 'super_admin' && permissions.includes('finance:cash')) return 'cashier';
  return role === 'super_admin' ? 'admin' : permissions.includes('business:edit') ? 'staff' : 'viewer';
}
function accountPermissions(role: unknown, encoded: unknown): string[] {
  const permissions = JSON.parse(String(encoded)) as string[];
  return role === 'super_admin' ? [...new Set([...permissions, ...financePermissions])] : permissions;
}
export class AuthManager {
  private db: DatabaseSync;
  readonly csrf = randomBytes(32).toString('hex');
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { count: number; until: number }>();
  private cleanup?: NodeJS.Timeout;
  constructor(
    file: string,
    private now: () => number = Date.now,
    private options: { localDevelopment?: boolean; localAdministration?: boolean; deployment?: Deployment } = {},
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,permissions TEXT NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS auth_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL)',
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(users)')
        .all()
        .some((c) => c.name === 'role')
    ) {
      this.db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','super_admin'));",
      );
      try {
        const users = this.db.prepare('SELECT id,permissions FROM users').all();
        // 仅提升唯一的旧管理员，不新建账号，也不改密码、盐或原权限。
        if (
          users.length === 1 &&
          JSON.parse(String(users[0].permissions)).includes('business:edit')
        ) {
          this.db.prepare("UPDATE users SET role='super_admin' WHERE id=?").run(users[0].id);
          this.event(String(users[0].id), 'legacy-owner-promoted');
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    this.migrateAccounts();
    if (options.deployment) {
      this.db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS auth_sessions(
        token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires);`);
      this.pruneSessions();
      this.cleanup = setInterval(() => {
        try { this.pruneSessions(); } catch { console.warn('未能清理过期登录会话，将在下次检查时重试。'); }
      }, 3600_000);
      this.cleanup.unref();
    }
  }
  private migrateAccounts() {
    if (
      !this.db
        .prepare('PRAGMA table_info(users)')
        .all()
        .some((c) => c.name === 'disabled_at')
    )
      this.db.exec('ALTER TABLE users ADD COLUMN disabled_at TEXT');
    if (
      !this.db
        .prepare('PRAGMA table_info(users)')
        .all()
        .some((c) => c.name === 'must_change_password')
    )
      this.db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN temp_password_expires INTEGER;`);
    // 申请账号和忘记密码。处理后立即删除，结果记在 auth_events。
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_requests(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('register','reset')),
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      salt TEXT,
      password_hash TEXT,
      client TEXT NOT NULL,
      created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS account_requests_reset ON account_requests(name) WHERE kind='reset';`);
  }
  /** 改密或停用后让该账号的其他会话立即失效。 */
  private revokeSessions(userId: string, except?: string) {
    for (const [key, session] of this.sessions)
      if (session.userId === userId && key !== except) this.sessions.delete(key);
    // 本机找回密码脚本也须让部署进程中的旧令牌失效。
    if (this.options.deployment || this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='auth_sessions' AND type='table'").get())
      this.db
        .prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?')
        .run(userId, except ?? '');
  }
  private pruneSessions() {
    const now = this.now();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires<=?').run(now);
    for (const [key, session] of this.sessions)
      if (session.expires <= now) this.sessions.delete(key);
  }
  private session(key: string): Session | undefined {
    const session = this.sessions.get(key);
    if (!this.options.deployment) return session;
    // 每次核验持久记录，以识别另一个进程撤销的令牌。
    const row = this.db.prepare('SELECT user_id,expires FROM auth_sessions WHERE token_hash=?').get(key);
    if (!row || Number(row.expires) <= this.now()) {
      this.sessions.delete(key);
      if (row) this.pruneSessions();
      return;
    }
    if (session) return session;
    const restored = { userId: String(row.user_id), expires: Number(row.expires) };
    this.sessions.set(key, restored);
    return restored;
  }
  private clientAddress(req: Request) {
    return proxyIngress(req, this.options.deployment) ? forwardedClient(req) || 'proxy' : req.ip || 'local';
  }
  private hashPassword(password: string) {
    const salt = randomBytes(24).toString('hex');
    return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
  }
  private changeCredentials(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private requireAccountAdmin(req: Request) {
    if (req.headers['x-erp-auth-token'] !== this.csrf)
      throw new ImportError('页面凭证已过期，请刷新。', 403);
    const actor = this.actor(req);
    if (!actor) throw new ImportError('请先登录账号。', 401, 'authentication');
    if (actor.role !== 'super_admin') throw new ImportError('仅管理员可管理账号。', 403, 'permission');
    return actor;
  }
  private activeAdmins(excluding?: string) {
    return Number(this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role='super_admin' AND disabled_at IS NULL AND (? IS NULL OR id<>?)")
      .get(excluding ?? null, excluding ?? null)!.n);
  }
  listAccounts() {
    return this.db
      .prepare('SELECT id,name,role,permissions,disabled_at FROM users ORDER BY name')
      .all()
      .map((u) => ({
        id: String(u.id),
        name: String(u.name),
        level: accountLevel(String(u.role), JSON.parse(String(u.permissions))),
        disabled: u.disabled_at !== null,
      }));
  }
  /** 换成临时密码：24 小时内有效，登录后必须先改，旧会话全部失效。明文只返回给调用方这一次。 */
  private issueTemporaryPassword(userId: string, name: string, actorId: string, action: string) {
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
    const user = this.db.prepare('SELECT id FROM users WHERE name=?').get(name);
    if (!user) throw new ImportError('账号不存在。', 404);
    return this.issueTemporaryPassword(String(user.id), name, String(user.id), 'password-reset-cli');
  }
  private pruneRequests() {
    const before = this.now() - ACCOUNT_REQUEST_LIFETIME;
    const expired = this.db.prepare('SELECT id FROM account_requests WHERE created_at<=?').all(before);
    if (!expired.length) return;
    this.db.prepare('DELETE FROM account_requests WHERE created_at<=?').run(before);
    for (const row of expired) this.event(null, 'account-request-expired:' + row.id);
  }
  private listRequests() {
    this.pruneRequests();
    return this.db
      .prepare(
        `SELECT r.id,r.kind,r.name,r.note,r.client,r.created_at,u.id AS user_id
         FROM account_requests r LEFT JOIN users u ON u.name=r.name ORDER BY r.created_at,r.id`,
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        kind: String(r.kind) as 'register' | 'reset',
        name: String(r.name),
        note: String(r.note),
        client: String(r.client),
        createdAt: new Date(Number(r.created_at)).toISOString(),
        nameTaken: r.kind === 'register' && r.user_id !== null,
      }));
  }
  private pendingRequests() {
    this.pruneRequests();
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM account_requests').get()!.n);
  }
  /** 公开接口的频率限制：成功也计数，防止批量提交。 */
  private throttled(key: string, limit: number, windowMs: number) {
    const now = this.now(),
      item = this.attempts.get(key),
      live = !!item && item.until > now;
    if (live && item.count >= limit) return true;
    this.attempts.set(key, {
      count: (live ? item.count : 0) + 1,
      until: live ? item.until : now + windowMs,
    });
    if (this.attempts.size > 10000) {
      for (const [k, v] of this.attempts) if (v.until <= now) this.attempts.delete(k);
      // 清完还满，说明有人在换地址猛刷；从最早的开始丢，不让内存无限涨。
      for (const k of this.attempts.keys()) {
        if (this.attempts.size <= 10000) break;
        this.attempts.delete(k);
      }
    }
    return false;
  }
  private event(id: string | null, action: string) {
    this.db
      .prepare('INSERT INTO auth_events(at,actor_id,action) VALUES(?,?,?)')
      .run(new Date(this.now()).toISOString(), id, action);
  }
  sessionBinding(req: Request) {
    const token = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('erp_session='))
      ?.slice(12);
    return token && /^[a-f0-9]{64}$/.test(token)
      ? createHash('sha256').update(token).digest('hex')
      : '';
  }
  configured() {
    return !!this.db.prepare('SELECT id FROM users LIMIT 1').get();
  }
  /** 业务接口看到的账号。还没改掉临时密码的会话一律当未登录。 */
  actor(req: Request): Actor | null {
    const actor = this.sessionActor(req);
    return actor?.mustChangePassword ? null : actor;
  }
  private sessionActor(req: Request): Actor | null {
    const key = this.sessionBinding(req);
    if (!key) return null;
    const s = this.session(key);
    if (!s || s.expires < this.now()) {
      this.sessions.delete(key);
      return null;
    }
    const row = this.db
      .prepare('SELECT name,permissions,role,disabled_at,must_change_password FROM users WHERE id=?')
      .get(s.userId);
    const user = row && row.disabled_at === null ? row : undefined;
    const dev =
      !!user && !!s.developer && this.developerAvailable(req) && user.role === 'super_admin';
    const owner =
      !!user &&
      user.role === 'super_admin' &&
      this.options.localAdministration === true &&
      this.localRequest(req);
    const result: Actor | null = user
      ? {
          id: s.userId,
          name: String(user.name),
          permissions: accountPermissions(user.role, user.permissions),
          role: user.role as 'admin' | 'super_admin',
          superAdminMode:
            owner || dev || (user.role === 'super_admin' && (s.superUntil || 0) > this.now()),
          superAdminUntil:
            owner || dev
              ? s.expires
              : user.role === 'super_admin' && (s.superUntil || 0) > this.now()
                ? s.superUntil
                : undefined,
          ...(user.must_change_password ? { mustChangePassword: true } : {}),
        }
      : null;
    return owner && result
      ? localAdministratorActor(result)
      : dev && result
        ? developerActor(result)
        : result;
  }
  private localRequest(req: Request) {
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
  developerAvailable(req: Request) {
    return (
      this.options.localDevelopment === true && localDevelopmentEnabled() && this.localRequest(req)
    );
  }
  requireSuperMode(req: Request) {
    const actor = this.actor(req);
    if (!actor) throw new ImportError('请先登录管理账号。', 401, 'authentication');
    if (actor.role !== 'super_admin')
      throw new ImportError('仅超级管理员可执行此操作。', 403, 'permission');
    if (!actor.superAdminMode)
      throw new ImportError('请先在账号菜单验证密码并进入超级管理员模式。', 403, 'step-up');
    return actor;
  }
  verifyPassword(req: Request, password: unknown) {
    const actor = this.actor(req);
    if (!actor) throw new ImportError('请先登录管理账号。', 401);
    return this.checkPassword(req, actor, password);
  }
  private checkPassword(req: Request, actor: Actor, password: unknown) {
    const attemptKey = 'step:' + actor.id + ':' + this.clientAddress(req);
    const throttle = this.attempts.get(attemptKey);
    if (throttle && throttle.until > this.now() && throttle.count >= 5)
      throw new ImportError('密码验证次数过多，请5分钟后重试。', 429);
    if (typeof password !== 'string' || !password || password.length > 128)
      throw new ImportError('请输入当前账号密码。');
    const user = this.db.prepare('SELECT salt,password_hash FROM users WHERE id=?').get(actor.id)!;
    const actual = scryptSync(password, String(user.salt), 64);
    if (!timingSafeEqual(actual, Buffer.from(String(user.password_hash), 'hex'))) {
      const count = throttle && throttle.until > this.now() ? throttle.count : 0;
      this.attempts.set(attemptKey, { count: count + 1, until: this.now() + 300000 });
      this.event(actor.id, 'step-up-failed');
      throw new ImportError('当前账号密码不正确。', 401);
    }
    this.attempts.delete(attemptKey);
    return actor;
  }
  router() {
    const router = Router();
    router.use((_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    });
    router.get('/state', (req, res) => {
      const actor = this.sessionActor(req);
      res.json({
        configured: this.configured(),
        actor,
        ...(actor ? { level: accountLevel(String(actor.role), actor.permissions) } : {}),
        ...(actor?.role === 'super_admin' && !actor.mustChangePassword
          ? { pendingRequests: this.pendingRequests() }
          : {}),
        csrf: this.csrf,
        developerAvailable: this.developerAvailable(req),
        ...(this.options.deployment ? { deploymentMode: true, proxyAccess: proxyIngress(req, this.options.deployment) } : {}),
      });
    });
    router.post('/developer-mode', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        throw new ImportError('页面凭证失效。', 403);
      const actor = this.actor(req),
        input = z
          .strictObject({ enabled: z.boolean(), password: z.string().max(128).optional() })
          .parse(req.body);
      if (!actor || actor.role !== 'super_admin')
        throw new ImportError('仅超级管理员可开启开发者模式。', 403);
      if (input.enabled && !this.developerAvailable(req))
        throw new ImportError('此环境未开放本地开发者模式。', 403);
      const session = this.sessions.get(this.sessionBinding(req))!;
      if (isLocalAdministrator(actor)) {
        res.json({ actor });
        return;
      }
      if (input.enabled && !actor.superAdminMode) this.verifyPassword(req, input.password);
      session.developer = input.enabled;
      if (!input.enabled) session.superUntil = 0;
      this.event(actor.id, input.enabled ? 'developer-mode-enter' : 'developer-mode-exit');
      res.json({ actor: this.actor(req) });
    });
    router.post('/super-admin/:action', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        throw new ImportError('页面凭证已过期，请刷新。', 403);
      const actor = this.actor(req);
      if (!actor) throw new ImportError('请先登录管理账号。', 401);
      if (actor.role !== 'super_admin') throw new ImportError('当前账号不是超级管理员。', 403);
      const session = this.sessions.get(this.sessionBinding(req))!;
      if (isLocalAdministrator(actor)) {
        res.json({ actor });
        return;
      }
      if (req.params.action === 'enter') {
        const input = z.strictObject({ password: z.string().min(1).max(128) }).parse(req.body);
        this.verifyPassword(req, input.password);
        session.superUntil = this.now() + 15 * 60000;
        this.event(actor.id, 'super-mode-enter');
      } else if (req.params.action === 'exit') {
        z.strictObject({}).parse(req.body);
        session.superUntil = 0;
        this.event(actor.id, 'super-mode-exit');
      } else throw new ImportError('操作不存在。', 404);
      res.json({ actor: this.actor(req) });
    });
    router.post(['/setup', '/login'], (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        return res.status(403).json({ message: '登录页面已过期，请刷新。' });
      const setup = req.path === '/setup';
      const parsed = (setup ? account : credentials).safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ message: setup ? '请输入用户名，密码' + passwordHint + '。' : '请输入用户名和密码。' });
      const v = parsed.data;
      const secure = proxyIngress(req, this.options.deployment);
      if (setup && secure)
        return res.status(403).json({ message: '请在服务器本机建立首个管理员账号。' });
      if (setup && this.configured())
        return res.status(409).json({ message: '管理员已经建立，请登录。' });
      // 办公室共用一个公网 IP，按“IP + 账号”限流，一个人输错不影响同事；
      // 同一 IP 另设总上限，防止换账号名撞密码。
      const client = this.clientAddress(req);
      const accountKey = 'login:' + client + ':' + v.name,
        ipKey = 'login-ip:' + client;
      const over = (key: string, limit: number) => {
        const item = this.attempts.get(key);
        return !!item && item.until > this.now() && item.count >= limit;
      };
      if (over(accountKey, 5) || over(ipKey, 30))
        return res.status(429).json({ message: '尝试次数过多，请5分钟后重试。' });
      if (setup) {
        const salt = randomBytes(24).toString('hex');
        this.db
          .prepare(
            'INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            v.name,
            salt,
            scryptSync(v.password, salt, 64).toString('hex'),
            JSON.stringify(['business:edit', 'import:execute', 'import:restore']),
            'super_admin',
          );
      }
      const user = this.db.prepare('SELECT * FROM users WHERE name=?').get(v.name);
      const salt = String(user?.salt || 'invalid-account-salt'),
        hash = scryptSync(v.password, salt, 64);
      if (!user || !timingSafeEqual(hash, Buffer.from(String(user.password_hash), 'hex'))) {
        for (const key of [accountKey, ipKey]) {
          const item = this.attempts.get(key);
          const prev = item && item.until > this.now() ? item.count : 0;
          this.attempts.set(key, { count: prev + 1, until: this.now() + 300000 });
        }
        // 公网上会有大量陌生地址，过期记录要清掉。
        if (this.attempts.size > 10000)
          for (const [key, item] of this.attempts)
            if (item.until <= this.now()) this.attempts.delete(key);
        return res.status(401).json({ message: '用户名或密码错误。' });
      }
      if (user.disabled_at !== null)
        return res.status(403).json({ message: '该账号已停用，请联系管理员。' });
      if (user.must_change_password && Number(user.temp_password_expires) <= this.now())
        return res.status(401).json({ message: '临时密码已过期，请重新申请。' });
      this.attempts.delete(accountKey);
      // 能用原密码登录，说明之前的“忘记密码”申请已经不需要了。
      if (!user.must_change_password)
        this.db.prepare("DELETE FROM account_requests WHERE kind='reset' AND name=?").run(user.name);
      const token = randomBytes(32).toString('hex'),
        actor = {
          id: String(user.id),
          name: String(user.name),
          permissions: accountPermissions(user.role, user.permissions),
          role: user.role as 'admin' | 'super_admin',
          ...(user.must_change_password ? { mustChangePassword: true } : {}),
        };
      const key = createHash('sha256').update(token).digest('hex');
      const expires = this.now() + 8 * 3600000;
      if (this.options.deployment) {
        this.pruneSessions();
        this.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires) VALUES(?,?,?)').run(key, actor.id, expires);
      }
      this.sessions.set(key, { userId: actor.id, expires });
      res.cookie('erp_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        ...(secure ? { secure } : {}),
        path: '/',
        maxAge: 8 * 3600000,
      });
      return res.json({ actor });
    });
    // 下面两个接口不登录也能用：不管用户名存不存在都回答同样的话，不能借此试出谁有账号。
    router.post('/apply', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        return res.status(403).json({ message: '页面已过期，请刷新。' });
      if (!this.configured()) return res.status(409).json({ message: '系统还没有管理员。' });
      const input = z
        .strictObject({
          name: z.string().trim().min(1).max(60),
          password: newPassword,
          note: z.string().trim().max(200).default(''),
        })
        .safeParse(req.body);
      if (!input.success)
        return res.status(400).json({ message: '请填写用户名，密码' + passwordHint + '，说明不超过200字。' });
      const client = this.clientAddress(req);
      if (this.throttled('apply:' + client, 5, 3600_000))
        return res.status(429).json({ message: '提交太频繁，请稍后再试，或直接联系管理员。' });
      this.pruneRequests();
      const waiting = this.db
        .prepare("SELECT COUNT(*) AS n FROM account_requests WHERE kind='register'")
        .get()!.n;
      // 先判断再算哈希：算哈希很耗 CPU，不能让人靠提交申请拖慢系统。
      if (Number(waiting) >= PENDING_ACCOUNT_LIMIT)
        return res.status(429).json({ message: '待处理的申请太多，请直接联系管理员。' });
      // 同名已在排队就不再收，也不覆盖：否则别人能改掉申请人自己设的密码。回一样的话，不暴露谁申请过。
      if (
        this.db
          .prepare("SELECT 1 FROM account_requests WHERE kind='register' AND name=?")
          .get(input.data.name)
      )
        return res.status(202).json({ ok: true });
      // 同一地址最多占 3 个名额，少量地址占不满全局队列。
      if (
        Number(
          this.db
            .prepare("SELECT COUNT(*) AS n FROM account_requests WHERE kind='register' AND client=?")
            .get(client)!.n,
        ) >= 3
      )
        return res.status(429).json({ message: '提交太频繁，请稍后再试，或直接联系管理员。' });
      const { salt, hash } = this.hashPassword(input.data.password),
        id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO account_requests(id,kind,name,note,salt,password_hash,client,created_at) VALUES(?,'register',?,?,?,?,?,?)",
        )
        .run(id, input.data.name, input.data.note, salt, hash, client, this.now());
      this.event(null, 'account-requested:' + id);
      return res.status(202).json({ ok: true });
    });
    router.post('/forgot', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        return res.status(403).json({ message: '页面已过期，请刷新。' });
      const input = z.strictObject({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
      if (!input.success) return res.status(400).json({ message: '请输入用户名。' });
      const client = this.clientAddress(req);
      if (this.throttled('forgot:' + client, 10, 3600_000))
        return res.status(429).json({ message: '提交太频繁，请稍后再试，或直接联系管理员。' });
      const user = this.db.prepare('SELECT id,disabled_at FROM users WHERE name=?').get(input.data.name);
      // 这里不改密码：别人乱提交也锁不住账号，管理员确认后才换临时密码。
      if (user && user.disabled_at === null) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO account_requests(id,kind,name,client,created_at) VALUES(?,'reset',?,?,?)
             ON CONFLICT(name) WHERE kind='reset' DO UPDATE SET client=excluded.client,created_at=excluded.created_at`,
          )
          .run(id, input.data.name, client, this.now());
        this.event(String(user.id), 'password-reset-requested');
      }
      return res.status(202).json({ ok: true });
    });
    router.post('/logout', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf) return res.sendStatus(403);
      const key = this.sessionBinding(req);
      if (key) {
        this.sessions.delete(key);
        if (this.options.deployment)
          this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(key);
      }
      res.clearCookie('erp_session', proxyIngress(req, this.options.deployment)
        ? { path: '/', secure: true, httpOnly: true, sameSite: 'strict' } : { path: '/' }).json({ ok: true });
    });
    router.post('/password', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        throw new ImportError('页面凭证已过期，请刷新。', 403);
      const input = z
        .strictObject({ current: z.string().min(1).max(128), password: newPassword })
        .parse(req.body);
      // 临时密码登录的会话也要能走到这里，所以不用 actor()。
      const session = this.sessionActor(req);
      if (!session) throw new ImportError('请先登录管理账号。', 401);
      const actor = this.checkPassword(req, session, input.current);
      if (input.current === input.password) throw new ImportError('新密码不能和当前密码相同。');
      const { salt, hash } = this.hashPassword(input.password);
      this.changeCredentials(() => {
        this.db
          .prepare('UPDATE users SET salt=?,password_hash=?,must_change_password=0,temp_password_expires=NULL WHERE id=?')
          .run(salt, hash, actor.id);
        this.db.prepare("DELETE FROM account_requests WHERE kind='reset' AND name=?").run(actor.name);
        this.revokeSessions(actor.id, this.sessionBinding(req));
        this.event(actor.id, 'password-changed');
      });
      res.json({ ok: true });
    });
    router.get('/users', (req, res) => {
      const actor = this.actor(req);
      if (!actor) throw new ImportError('请先登录账号。', 401, 'authentication');
      if (actor.role !== 'super_admin')
        throw new ImportError('仅管理员可管理账号。', 403, 'permission');
      res.json({ users: this.listAccounts() });
    });
    router.post('/users', (req, res) => {
      const actor = this.requireAccountAdmin(req),
        input = z
          .strictObject({
            name: z.string().trim().min(1).max(60),
            password: newPassword,
            level: z.enum(accountLevels),
          })
          .parse(req.body);
      if (this.db.prepare('SELECT 1 FROM users WHERE name=?').get(input.name))
        throw new ImportError('用户名已存在。', 409);
      const { salt, hash } = this.hashPassword(input.password),
        grant = levelGrant[input.level],
        id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)',
        )
        .run(id, input.name, salt, hash, JSON.stringify(grant.permissions), grant.role);
      this.event(actor.id, 'account-created:' + id);
      res.status(201).json({ users: this.listAccounts() });
    });
    router.put('/users/:id', (req, res) => {
      const actor = this.requireAccountAdmin(req),
        id = z.string().uuid().parse(req.params.id),
        input = z
          .strictObject({ level: z.enum(accountLevels).optional(), disabled: z.boolean().optional() })
          .parse(req.body);
      if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(id))
        throw new ImportError('账号不存在。', 404);
      const demotes = input.level !== undefined && input.level !== 'admin';
      if ((demotes || input.disabled) && this.activeAdmins(id) === 0)
        throw new ImportError('至少需要保留一个可用的管理员账号。', 409);
      if (input.level) {
        const grant = levelGrant[input.level];
        this.db
          .prepare('UPDATE users SET role=?,permissions=? WHERE id=?')
          .run(grant.role, JSON.stringify(grant.permissions), id);
      }
      if (input.disabled !== undefined) {
        this.changeCredentials(() => {
          this.db.prepare('UPDATE users SET disabled_at=? WHERE id=?')
            .run(input.disabled ? new Date(this.now()).toISOString() : null, id);
          if (input.disabled) this.revokeSessions(id);
        });
      }
      this.event(actor.id, 'account-updated:' + id);
      res.json({ users: this.listAccounts() });
    });
    router.post('/users/:id/password', (req, res) => {
      const actor = this.requireAccountAdmin(req),
        id = z.string().uuid().parse(req.params.id);
      z.strictObject({}).parse(req.body);
      const user = this.db.prepare('SELECT name FROM users WHERE id=?').get(id);
      if (!user) throw new ImportError('账号不存在。', 404);
      if (id === actor.id) throw new ImportError('自己的密码请在右上角菜单修改。', 409);
      const temporary = this.issueTemporaryPassword(id, String(user.name), actor.id, 'password-reset:' + id);
      res.json({ temporaryPassword: temporary, requests: this.listRequests() });
    });
    router.get('/requests', (req, res) => {
      const actor = this.actor(req);
      if (!actor) throw new ImportError('请先登录账号。', 401, 'authentication');
      if (actor.role !== 'super_admin')
        throw new ImportError('仅管理员可管理账号。', 403, 'permission');
      res.json({ requests: this.listRequests() });
    });
    router.post('/requests/:id/approve', (req, res) => {
      const actor = this.requireAccountAdmin(req),
        id = z.string().uuid().parse(req.params.id);
      const input = z
        .strictObject({
          name: z.string().trim().min(1).max(60).optional(),
          level: z.enum(accountLevels).optional(),
        })
        .parse(req.body);
      const request = this.db.prepare('SELECT * FROM account_requests WHERE id=?').get(id);
      if (!request) throw new ImportError('这条申请已经处理过了。', 404);
      if (request.kind === 'register') {
        if (!input.level) throw new ImportError('请选择账号级别。');
        const name = input.name ?? String(request.name);
        if (this.db.prepare('SELECT 1 FROM users WHERE name=?').get(name))
          throw new ImportError('用户名已存在，请改一个。', 409);
        const grant = levelGrant[input.level],
          userId = randomUUID();
        this.changeCredentials(() => {
          this.db
            .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
            .run(userId, name, request.salt, request.password_hash, JSON.stringify(grant.permissions), grant.role);
          this.db.prepare('DELETE FROM account_requests WHERE id=?').run(id);
          this.event(actor.id, 'account-request-approved:' + id + ':' + userId);
        });
        return res.json({ requests: this.listRequests(), users: this.listAccounts() });
      }
      const user = this.db.prepare('SELECT id,disabled_at FROM users WHERE name=?').get(request.name);
      if (!user || user.disabled_at !== null) {
        this.db.prepare('DELETE FROM account_requests WHERE id=?').run(id);
        throw new ImportError('这个账号已不存在或已停用，申请已移除。', 409);
      }
      if (String(user.id) === actor.id)
        throw new ImportError('自己的密码请在右上角菜单修改。这条申请如果不是你提交的，请拒绝。', 409);
      const temporary = this.issueTemporaryPassword(
        String(user.id),
        String(request.name),
        actor.id,
        'password-reset:' + user.id,
      );
      return res.json({
        temporaryPassword: temporary,
        requests: this.listRequests(),
        users: this.listAccounts(),
      });
    });
    router.post('/requests/:id/reject', (req, res) => {
      const actor = this.requireAccountAdmin(req),
        id = z.string().uuid().parse(req.params.id);
      z.strictObject({}).parse(req.body);
      const removed = this.db.prepare('DELETE FROM account_requests WHERE id=?').run(id);
      if (!removed.changes) throw new ImportError('这条申请已经处理过了。', 404);
      this.event(actor.id, 'account-request-rejected:' + id);
      res.json({ requests: this.listRequests() });
    });
    return router;
  }
  close() {
    clearInterval(this.cleanup);
    this.sessions.clear();
    this.db.close();
  }
}
