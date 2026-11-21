// 测试里造账号：Actor.source 必填（server/core/actor.ts），和登录会话一样记成从页面来；
// 要测助手、数据管理入口的，拿到后用 server/core/audit.ts 的 viaEntry 换。
// 只造身份，不引任何业务模块和助手：借一个账号的测试不用为此加载别的东西。
import type { Actor } from '../server/core/actor.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import type { Permission } from '../shared/core/accounts.js';

/** 一套权限：只收权限名单里的名字（shared/core/accounts.ts），写错编译不过；放进 { ...actor, permissions: grant(...) } */
export const grant = (...names: Permission[]) => names;

export const pageActor = <T extends Omit<Actor, 'source'>>(fields: T): T & Pick<Actor, 'source'> => ({
  source: AUDIT_SOURCE.page,
  ...fields,
});

/** 一个能改业务的虚构管理员（助手测试默认用它说话、点确认） */
export const actor = pageActor({
  id: 'fictional-assistant-user',
  name: '虚构AI验收',
  permissions: ['business:edit'],
  role: 'admin' as const,
});
/** 同一个人进了超级管理员模式（两分钟内有效，每次调用按当时的时间算） */
export const superActor = () => ({
  ...actor,
  role: 'super_admin' as const,
  superAdminMode: true,
  superAdminUntil: Date.now() + 120000,
});
