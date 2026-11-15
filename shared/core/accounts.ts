/**
 * 账号申请的种类：申请账号（register）、忘记密码（reset）。账号库 account_requests.kind 只收这两种（建表有同样的 CHECK），
 * 服务端读申请列表、前端账号页认种类都用这一份。
 */
export const accountRequestKinds = ['register', 'reset'] as const;
export type AccountRequestKind = (typeof accountRequestKinds)[number];

/** 账号的角色（账号库 users.role，建表有同样的 CHECK） */
export const userRoles = ['admin', 'super_admin'] as const;
export type UserRole = (typeof userRoles)[number];

/** 账号级别：建号、改级别时选的，库里存成角色和权限（server/core/account-db.ts 的 levelGrant 对应、accountLevel 认回） */
export const accountLevels = ['admin', 'staff', 'viewer', 'finance', 'cashier'] as const;
export type AccountLevel = (typeof accountLevels)[number];
/** 级别的叫法：账号页、右上角、助手查账号（accounts.list）都用这一份 */
export const accountLevelNames: Record<AccountLevel, string> = {
  admin: '管理员',
  staff: '业务人员',
  viewer: '只读',
  finance: '财务',
  cashier: '出纳',
};
