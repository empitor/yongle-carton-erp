import { Router } from 'express';
import { z } from 'zod';
import { isLocalAdministrator, route, type AuthManager, type Store } from '../core/index.js';
import type { DeletionApi } from '../../shared/business/index.js';
import { DatabaseMaintenanceService } from './database-maintenance.js';

/** 删除提交：删除内容另加本人密码（不在本机删已核对的单据时要） */
const withPassword = z.looseObject({ password: z.unknown().optional() });

/**
 * 业务界面的删除（挂在 /api/deletions 下，接口表 shared/business/deletion-api.ts）：先看影响清单，再按同一范围删除；
 * 删除前自动留恢复快照，写审计。谁能删由 DatabaseMaintenanceService 判断（超级管理员模式可删档案和已确认的单据，
 * 有编辑权限可删还没核对的单据），不走只限本机的维护入口，部署在服务器上从域名访问也能用；不在本机时除了还没核对的单据都要再输本人密码。
 */
export function deletionRouter(store: Store, auth: AuthManager) {
  const router = Router();
  const on = route<DeletionApi>(router, '/deletions');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // 页面凭证由装配层对所有写接口统一检查（server/http-guards.ts，AuthManager.requireCsrf）
    next();
  });
  on('POST /deletions/preview', ({ body, req }) => new DatabaseMaintenanceService(store).preview(body, auth.actor(req)));
  on('POST /deletions/execute', async ({ body, req }) => {
    // 本人密码单独拿出来交给验密码，其余是删除内容（进删除服务再按结构校验）
    const { password, ...input } = withPassword.parse(body ?? {}),
      service = new DatabaseMaintenanceService(store),
      actor = auth.actor(req),
      binding = auth.sessionBinding(req);
    // 同一请求已经删过（比如网络断了重试）：先原样返回上次结果。删完后单据已经不在了，
    // 再按现在的库判断权限会把同一个人的重试误判成没权限；按这个账号的请求号查，仍要求同一会话。
    const replayed = service.replay(input, actor, binding);
    if (replayed) return replayed;
    const access = service.deletionAccess(actor, input);
    // 以前定的“从域名进来不能删”是为了公网安全：已确认的单据在服务器上能删，但要再输一次本人密码
    if (!isLocalAdministrator(actor) && !access.draftsOnly) await auth.verifyPassword(req, password);
    // 验密码要排队算哈希：空当里账号可能被降级、退出了模式，按现在的身份删（权限由删除服务再判一次）
    return service.delete(input, auth.actor(req), binding);
  });
  return router;
}
