import type { AuditSource, Permission, UserRole } from '../../../shared/core/index.js';

/**
 * 登录后的账号（谁在操作）。基础里各文件共用的类型，放在最底下，只被引用、不引用别的文件。
 * 账号库和登录在 server/accounts/auth.ts、account-db.ts；本机最高管理员的标记在 local-administrator.ts；角色的取值在 shared/core/accounts.ts。
 */
export type Actor = {
  /**
   * 这次操作从哪个入口来，审计照它记来源（audit.ts）。必填：登录会话生成账号时写页面（auth.ts），
   * 助手、数据管理的入口用 audit.ts 的 viaEntry 换成自己的，服务只把账号往下传。
   */
  source: AuditSource;
  id: string;
  name: string;
  /** 只收权限名单里的名字（shared/core/accounts.ts），写错编译不过 */
  permissions: Permission[];
  role?: UserRole;
  superAdminUntil?: number;
  superAdminMode?: boolean;
  localAdministrator?: boolean;
  /** 用临时密码登录、还没改密码。只有 /auth/state 能看到，其他接口一律当未登录。 */
  mustChangePassword?: boolean;
};
