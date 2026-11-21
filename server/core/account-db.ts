import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  accountRequestKinds,
  financePermissions,
  permissionNames,
  userRoles,
  type AccountLevel,
  type Permission,
  type UserRole,
} from '../../shared/core/index.js';
import { defaultDbPath } from './db.js';
import { rows } from './schema/rows.js';
import { exists, parseStoredJson } from './sql.js';
import { registerVersionedSqlite, type VersionedSqliteSpec } from './versioned-sqlite-spec.js';

/**
 * 账号库（security/users.sqlite）：表结构、默认位置，以及账号级别和权限的对应关系（级别、角色的取值在 shared/core/accounts.ts）。
 * 读写账号、会话、登录都在 auth.ts 的 AuthManager。
 */

/** 账号库 users 的一行：角色按取值校验 */
const userRow = rows.users.extend({ role: z.enum(userRoles) });
/** 读账号库用到的几种行（auth.ts、login-route.ts、账号接口） */
export const accountRows = {
  user: userRow,
  sessionRow: rows.auth_sessions.pick({ user_id: true, expires: true }),
  credentialRow: userRow.pick({ salt: true, password_hash: true }),
  userIdRow: userRow.pick({ id: true }),
  userNameRow: userRow.pick({ name: true }),
  userStateRow: userRow.pick({ id: true, disabled_at: true }),
  request: rows.account_requests,
  accountListRow: userRow.pick({ id: true, name: true, role: true, permissions: true, disabled_at: true }),
  sessionUserRow: userRow.pick({ name: true, permissions: true, role: true, disabled_at: true, must_change_password: true }),
  requestIdRow: rows.account_requests.pick({ id: true }),
  /** 申请和找回密码的列表：种类只有这两种（建表有同样的 CHECK）；LEFT JOIN 出来的账号编号没有同名账号时是空 */
  requestListRow: rows.account_requests
    .pick({ id: true, name: true, note: true, client: true, created_at: true })
    .extend({ kind: z.enum(accountRequestKinds), user_id: userRow.shape.id.nullable() }),
};
/** 账号级别映射到现有的角色和权限：只读账号没有写权限，各业务服务的校验自然拒绝。 */
export const levelGrant: Record<AccountLevel, { role: UserRole; permissions: Permission[] }> = {
  admin: { role: 'super_admin', permissions: ['business:edit', 'import:execute', 'import:restore'] },
  staff: { role: 'admin', permissions: ['business:edit', 'import:execute'] },
  viewer: { role: 'admin', permissions: [] },
  finance: { role: 'admin', permissions: ['business:edit', 'finance:view', 'finance:edit', 'finance:approve', 'finance:close'] },
  cashier: { role: 'admin', permissions: ['finance:view', 'finance:cash'] },
};
/** 从库里存的角色和权限认回账号级别 */
export function accountLevel(role: string, permissions: readonly Permission[]): AccountLevel {
  if (role !== 'super_admin' && permissions.includes('finance:close')) return 'finance';
  if (role !== 'super_admin' && permissions.includes('finance:cash')) return 'cashier';
  return role === 'super_admin' ? 'admin' : permissions.includes('business:edit') ? 'staff' : 'viewer';
}
const storedPermissions = z.array(z.enum(permissionNames));
/** 库里存的权限（JSON 文字的字符串数组）：只认权限名单里的，名单外的按库里数据不对报出来 */
export const permissionList = (encoded: string) => parseStoredJson(storedPermissions, encoded, 'users.permissions');
/** 库里存的权限（JSON 文字）转成账号实际有的权限：超级管理员另外带上全部财务权限 */
export function accountPermissions(role: string, encoded: string): Permission[] {
  const permissions = permissionList(encoded);
  return role === 'super_admin' ? [...new Set([...permissions, ...financePermissions])] : permissions;
}

/**
 * 删掉登录会话（会话是能冒用的凭证）：完整备份的账号库副本、升级前备份、补丁回滚时换下来留存的账号库都不带它，
 * 恢复或换回以后所有人重新登录。副本可能是别的版本，没有这张表就不做。
 */
export function clearSessions(db: DatabaseSync) {
  if (exists(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='auth_sessions'"))
    db.exec('PRAGMA secure_delete=ON; DELETE FROM auth_sessions;');
}

/**
 * 账号库的结构，基线是 0.9.0 的第 1 版。0.8.4 留下的（没记版本）打开时删掉重建，程序回到“首次使用、建立管理员”；
 * 以后改结构在 steps 加一步，账号留着（规矩见 server/core/versioned-sqlite-spec.ts 开头）。
 * auth_sessions 是部署模式的登录会话（本机模式不用，表照样建）。
 */
export const accountDatabase: VersionedSqliteSpec = {
  label: '账号库',
  baseline: 1,
  steps: [],
  scrubBackup: clearSessions,
  create(db) {
    // account_requests：申请账号和忘记密码。处理后立即删除，结果记在 auth_events。
    db.exec(`CREATE TABLE users(
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        permissions TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','super_admin')),
        disabled_at TEXT,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        temp_password_expires INTEGER);
      CREATE TABLE auth_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL);
      CREATE TABLE account_requests(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('register','reset')),
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        salt TEXT,
        password_hash TEXT,
        client TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX account_requests_reset ON account_requests(name) WHERE kind='reset';
      CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX auth_sessions_expires ON auth_sessions(expires);`);
  },
};
/** 账号库的默认位置：业务库所在目录下的 security/users.sqlite（server/index.ts、server/maintenance.ts 装配时都用它） */
export const defaultAccountPath = () => join(dirname(defaultDbPath), 'security', 'users.sqlite');
// 默认位置登记进配置库登记表：恢复备份的维护命令行不打开账号库，靠这一条认出备份里的 security/users.sqlite 是账号库、支持到第几版
registerVersionedSqlite(accountDatabase, defaultAccountPath);
