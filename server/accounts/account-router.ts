import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  accountCreateSchema,
  accountUpdateSchema,
  emptyBodySchema,
  requestApproveSchema,
  type AccountLevel,
} from '../../shared/core/index.js';
import { accountRows, levelGrant } from './account-db.js';
import { AppError, exists, one } from '../core/index.js';
import { authRoute, type AuthRoute, type AuthRoutesHost } from './auth-router.js';

/*
 * 管理员管理账号的接口（/api/auth 下，接口表 shared/core/account-api.ts）：账号列表、建号、改级别和停用、发临时密码，
 * 处理申请账号和忘记密码。由 auth.ts 的 AuthManager 挂在登录接口（auth-router.ts）后面。
 */

const accountId = z.uuid();
type AccountRequest = NonNullable<ReturnType<typeof readRequest>>;

/** 看账号列表、申请列表：登录了、是管理员就行（不用进超级管理员模式） */
function requireAccountViewer(auth: AuthRoutesHost, req: Request) {
  const actor = auth.actor(req);
  if (!actor) throw new AppError('请先登录账号。', 401, 'authentication');
  if (actor.role !== 'super_admin') throw new AppError('仅管理员可管理账号。', 403, 'permission');
}

export function accountRouter(auth: AuthRoutesHost) {
  const router = Router();
  const on = authRoute(router);
  userRoutes(on, auth);
  requestRoutes(on, auth);
  return router;
}

/** 账号：列表、建号、改级别和停用、发临时密码 */
function userRoutes(on: AuthRoute, auth: AuthRoutesHost) {
  on('GET /auth/users', ({ req }) => {
    requireAccountViewer(auth, req);
    return { users: auth.listAccounts() };
  });
  on('POST /auth/users', ({ body, req }) => {
    const actor = auth.requireAccountAdmin(req),
      input = accountCreateSchema.parse(body);
    if (exists(auth.db, 'SELECT 1 FROM users WHERE name=?', input.name))
      throw new AppError('用户名已存在。', 409);
    const { salt, hash } = auth.hashPassword(input.password),
      grant = levelGrant[input.level],
      id = randomUUID();
    auth.db
      .prepare(
        'INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)',
      )
      .run(id, input.name, salt, hash, JSON.stringify(grant.permissions), grant.role);
    auth.event(actor.id, 'account-created:' + id);
    return { users: auth.listAccounts() };
  }, { status: 201 });
  on('PUT /auth/users/:id', ({ param, body, req }) => {
    const actor = auth.requireAccountAdmin(req),
      id = accountId.parse(param('id')),
      input = accountUpdateSchema.parse(body);
    if (!exists(auth.db, 'SELECT 1 FROM users WHERE id=?', id))
      throw new AppError('账号不存在。', 404);
    const demotes = input.level !== undefined && input.level !== 'admin';
    if ((demotes || input.disabled) && auth.activeAdmins(id) === 0)
      throw new AppError('至少需要保留一个可用的管理员账号。', 409);
    if (input.level) {
      const grant = levelGrant[input.level];
      auth.db
        .prepare('UPDATE users SET role=?,permissions=? WHERE id=?')
        .run(grant.role, JSON.stringify(grant.permissions), id);
    }
    if (input.disabled !== undefined) {
      auth.changeCredentials(() => {
        auth.db.prepare('UPDATE users SET disabled_at=? WHERE id=?')
          .run(input.disabled ? new Date(auth.now()).toISOString() : null, id);
        if (input.disabled) auth.revokeSessions(id);
      });
    }
    auth.event(actor.id, 'account-updated:' + id);
    return { users: auth.listAccounts() };
  });
  on('POST /auth/users/:id/password', ({ param, body, req }) => {
    const actor = auth.requireAccountAdmin(req),
      id = accountId.parse(param('id'));
    emptyBodySchema.parse(body);
    const user = one(auth.db, accountRows.userNameRow, 'SELECT name FROM users WHERE id=?', id);
    if (!user) throw new AppError('账号不存在。', 404);
    if (id === actor.id) throw new AppError('自己的密码请在右上角菜单修改。', 409);
    const temporary = auth.issueTemporaryPassword(id, user.name, actor.id, 'password-reset:' + id);
    return { temporaryPassword: temporary, requests: auth.listRequests() };
  });
}

const readRequest = (auth: AuthRoutesHost, id: string) =>
  one(auth.db, accountRows.request, 'SELECT * FROM account_requests WHERE id=?', id);

/** 申请：列表、批准（申请账号建号，忘记密码发临时密码）、拒绝 */
function requestRoutes(on: AuthRoute, auth: AuthRoutesHost) {
  on('GET /auth/requests', ({ req }) => {
    requireAccountViewer(auth, req);
    return { requests: auth.listRequests() };
  });
  on('POST /auth/requests/:id/approve', ({ param, body, req }) => {
    const actor = auth.requireAccountAdmin(req),
      id = accountId.parse(param('id'));
    const input = requestApproveSchema.parse(body);
    const request = readRequest(auth, id);
    if (!request) throw new AppError('这条申请已经处理过了。', 404);
    if (request.kind === 'register') {
      approveRegister(auth, actor.id, request, input);
      return { requests: auth.listRequests(), users: auth.listAccounts() };
    }
    const temporary = approveReset(auth, actor.id, request);
    return {
      temporaryPassword: temporary,
      requests: auth.listRequests(),
      users: auth.listAccounts(),
    };
  });
  on('POST /auth/requests/:id/reject', ({ param, body, req }) => {
    const actor = auth.requireAccountAdmin(req),
      id = accountId.parse(param('id'));
    emptyBodySchema.parse(body);
    const removed = auth.db.prepare('DELETE FROM account_requests WHERE id=?').run(id);
    if (!removed.changes) throw new AppError('这条申请已经处理过了。', 404);
    auth.event(actor.id, 'account-request-rejected:' + id);
    return { requests: auth.listRequests() };
  });
}

/** 批准申请账号：按选的级别建号（可改名），用申请人自己设的密码，申请删掉 */
function approveRegister(
  auth: AuthRoutesHost,
  actorId: string,
  request: AccountRequest,
  input: { name?: string; level?: AccountLevel },
) {
  if (!input.level) throw new AppError('请选择账号级别。');
  const name = input.name ?? request.name;
  if (exists(auth.db, 'SELECT 1 FROM users WHERE name=?', name))
    throw new AppError('用户名已存在，请改一个。', 409);
  const grant = levelGrant[input.level],
    userId = randomUUID();
  auth.changeCredentials(() => {
    auth.db
      .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
      .run(userId, name, request.salt, request.password_hash, JSON.stringify(grant.permissions), grant.role);
    auth.db.prepare('DELETE FROM account_requests WHERE id=?').run(request.id);
    auth.event(actorId, 'account-request-approved:' + request.id + ':' + userId);
  });
}

/** 批准忘记密码：给还在用的账号发临时密码；账号没了或停用了，申请删掉并说明 */
function approveReset(auth: AuthRoutesHost, actorId: string, request: AccountRequest) {
  const user = one(auth.db, accountRows.userStateRow, 'SELECT id,disabled_at FROM users WHERE name=?', request.name);
  if (!user || user.disabled_at !== null) {
    auth.db.prepare('DELETE FROM account_requests WHERE id=?').run(request.id);
    throw new AppError('这个账号已不存在或已停用，申请已移除。', 409);
  }
  if (user.id === actorId)
    throw new AppError('自己的密码请在右上角菜单修改。这条申请如果不是你提交的，请拒绝。', 409);
  return auth.issueTemporaryPassword(user.id, request.name, actorId, 'password-reset:' + user.id);
}
