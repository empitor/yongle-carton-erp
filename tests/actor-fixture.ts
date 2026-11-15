// 测试里造账号：Actor.source 必填（server/core/actor.ts），和登录会话一样记成从页面来；
// 要测助手、数据管理入口的，拿到后用 server/core/audit.ts 的 viaEntry 换。
import type { Actor } from '../server/core/actor.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';

export const pageActor = <T extends Omit<Actor, 'source'>>(fields: T): T & Pick<Actor, 'source'> => ({
  source: AUDIT_SOURCE.page,
  ...fields,
});
