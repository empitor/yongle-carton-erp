import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ImportError } from './import/errors.js';
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
};
const account = z.strictObject({
  name: z.string().trim().min(1).max(60),
  password: z.string().min(12).max(128),
});
type Session = { actor: Actor; expires: number; superUntil?: number; developer?: boolean };
const newPassword = z.string().min(12, '密码至少12位').max(128);
export const accountLevels = ['admin', 'staff', 'viewer'] as const;
/** 账号级别映射到现有的角色和权限：只读账号没有写权限，各业务服务的校验自然拒绝。 */
const levelGrant: Record<(typeof accountLevels)[number], { role: string; permissions: string[] }> = {
  admin: { role: 'super_admin', permissions: ['business:edit', 'import:execute', 'import:restore'] },
  staff: { role: 'admin', permissions: ['business:edit', 'import:execute'] },
  viewer: { role: 'admin', permissions: [] },
};
function accountLevel(role: string, permissions: string[]) {
  return role === 'super_admin' ? 'admin' : permissions.includes('business:edit') ? 'staff' : 'viewer';
}
export class AuthManager {
  private db: DatabaseSync;
  readonly csrf = randomBytes(32).toString('hex');
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    file: string,
    private now: () => number = Date.now,
    private options: { localDevelopment?: boolean; localAdministration?: boolean } = {},
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
  }
  private migrateAccounts() {
    if (
      !this.db
        .prepare('PRAGMA table_info(users)')
        .all()
        .some((c) => c.name === 'disabled_at')
    )
      this.db.exec('ALTER TABLE users ADD COLUMN disabled_at TEXT');
  }
  /** 改密或停用后让该账号的其他会话立即失效。 */
  private revokeSessions(userId: string, except?: string) {
    for (const [key, session] of this.sessions)
      if (session.actor.id === userId && key !== except) this.sessions.delete(key);
  }
  private hashPassword(password: string) {
    const salt = randomBytes(24).toString('hex');
    return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
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
    return this.db
      .prepare("SELECT id FROM users WHERE role='super_admin' AND disabled_at IS NULL")
      .all()
      .filter((u) => u.id !== excluding).length;
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
  /** 命令行找回入口：写入临时密码并让旧会话失效。 */
  resetPassword(name: string, password: string) {
    const user = this.db.prepare('SELECT id FROM users WHERE name=?').get(name);
    if (!user) throw new ImportError('账号不存在。', 404);
    const { salt, hash } = this.hashPassword(password);
    this.db
      .prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?')
      .run(salt, hash, user.id);
    this.revokeSessions(String(user.id));
    this.event(String(user.id), 'password-reset-cli');
  }
  private event(id: string, action: string) {
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
  actor(req: Request): Actor | null {
    const key = this.sessionBinding(req);
    if (!key) return null;
    const s = this.sessions.get(key);
    if (!s || s.expires < this.now()) {
      this.sessions.delete(key);
      return null;
    }
    const row = this.db
      .prepare('SELECT name,permissions,role,disabled_at FROM users WHERE id=?')
      .get(s.actor.id);
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
          id: s.actor.id,
          name: String(user.name),
          permissions: JSON.parse(String(user.permissions)),
          role: user.role as 'admin' | 'super_admin',
          superAdminMode:
            owner || dev || (user.role === 'super_admin' && (s.superUntil || 0) > this.now()),
          superAdminUntil:
            owner || dev
              ? s.expires
              : user.role === 'super_admin' && (s.superUntil || 0) > this.now()
                ? s.superUntil
                : undefined,
        }
      : null;
    return owner && result
      ? localAdministratorActor(result)
      : dev && result
        ? developerActor(result)
        : result;
  }
  private localRequest(req: Request) {
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
    const attemptKey = 'step:' + actor.id + ':' + req.ip;
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
    router.get('/state', (req, res) =>
      res.json({
        configured: this.configured(),
        actor: this.actor(req),
        csrf: this.csrf,
        developerAvailable: this.developerAvailable(req),
      }),
    );
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
      const parsed = account.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: '请输入用户名和12–128位密码。' });
      const v = parsed.data,
        setup = req.path === '/setup';
      if (setup && this.configured())
        return res.status(409).json({ message: '管理员已经建立，请登录。' });
      const throttle = this.attempts.get(req.ip || 'local');
      if (throttle && throttle.until > Date.now() && throttle.count >= 5)
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
        const prev = throttle && throttle.until > Date.now() ? throttle.count : 0;
        this.attempts.set(req.ip || 'local', { count: prev + 1, until: Date.now() + 300000 });
        return res.status(401).json({ message: '用户名或密码错误。' });
      }
      if (user.disabled_at !== null)
        return res.status(403).json({ message: '该账号已停用，请联系管理员。' });
      this.attempts.delete(req.ip || 'local');
      const token = randomBytes(32).toString('hex'),
        actor = {
          id: String(user.id),
          name: String(user.name),
          permissions: JSON.parse(String(user.permissions)),
          role: user.role as 'admin' | 'super_admin',
        };
      this.sessions.set(createHash('sha256').update(token).digest('hex'), {
        actor,
        expires: Date.now() + 8 * 3600000,
      });
      res.cookie('erp_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 8 * 3600000,
      });
      return res.json({ actor });
    });
    router.post('/logout', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf) return res.sendStatus(403);
      const token = req.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('erp_session='))
        ?.slice(12);
      if (token) this.sessions.delete(createHash('sha256').update(token).digest('hex'));
      res.clearCookie('erp_session', { path: '/' }).json({ ok: true });
    });
    router.post('/password', (req, res) => {
      if (req.headers['x-erp-auth-token'] !== this.csrf)
        throw new ImportError('页面凭证已过期，请刷新。', 403);
      const input = z
        .strictObject({ current: z.string().min(1).max(128), password: newPassword })
        .parse(req.body);
      const actor = this.verifyPassword(req, input.current),
        { salt, hash } = this.hashPassword(input.password);
      this.db
        .prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?')
        .run(salt, hash, actor.id);
      this.revokeSessions(actor.id, this.sessionBinding(req));
      this.event(actor.id, 'password-changed');
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
        this.db
          .prepare('UPDATE users SET disabled_at=? WHERE id=?')
          .run(input.disabled ? new Date(this.now()).toISOString() : null, id);
        if (input.disabled) this.revokeSessions(id);
      }
      this.event(actor.id, 'account-updated:' + id);
      res.json({ users: this.listAccounts() });
    });
    router.post('/users/:id/password', (req, res) => {
      const actor = this.requireAccountAdmin(req),
        id = z.string().uuid().parse(req.params.id),
        input = z.strictObject({ password: newPassword }).parse(req.body);
      if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(id))
        throw new ImportError('账号不存在。', 404);
      const { salt, hash } = this.hashPassword(input.password);
      this.db
        .prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?')
        .run(salt, hash, id);
      this.revokeSessions(id, this.sessionBinding(req));
      this.event(actor.id, 'password-reset:' + id);
      res.json({ ok: true });
    });
    return router;
  }
  close() {
    this.sessions.clear();
    this.db.close();
  }
}
