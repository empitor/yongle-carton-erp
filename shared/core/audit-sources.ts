/**
 * 审计来源：一次写入从哪个入口进来，只有这四种。入口把它标在操作的账号上（server/core/http/actor.ts 的 source），
 * 服务照账号记审计，自己不写来源；同一个服务被页面、助手、数据管理共用时，记下来的来源分得清是哪边来的。
 * 建表里 business_audit.source 的枚举和这里一致（tests/schema-constraints.test.ts 守着）。
 */
export const AUDIT_SOURCE = {
  /** 页面：登录后在程序页面上做的（没标入口的账号就是页面） */
  page: 'page',
  /** 助手：对话里点确认卡片、助手直接执行的 */
  assistant: 'assistant',
  /** 数据管理：本机管理员在数据管理窗口里做的 */
  dataManagement: 'data-management',
  /** 系统：没有人操作、程序自己做的 */
  system: 'system',
} as const;
export type AuditSource = (typeof AUDIT_SOURCE)[keyof typeof AUDIT_SOURCE];
export const auditSources = Object.values(AUDIT_SOURCE);
/** 界面和助手看到的叫法 */
export const auditSourceNames: Record<AuditSource, string> = {
  page: '页面',
  assistant: '助手',
  'data-management': '数据管理',
  system: '系统',
};
