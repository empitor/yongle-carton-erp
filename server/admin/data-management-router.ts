import { Router, type Request } from 'express';
import type { Store } from '../core/index.js';
import type { AuthManager } from '../core/index.js';
import type { ImportManager } from '../import/index.js';
import { AppError, requireLocalAdministrator, route, viaEntry } from '../core/index.js';
import { AUDIT_SOURCE } from '../../shared/core/index.js';
import {
  managementRecordsQuerySchema,
  pageWorkspaceActionSchema,
  resetPreviewQuerySchema,
  type DataManagementApi,
} from '../../shared/admin/index.js';
import { DataManagementService } from './data-management-service.js';
import { manageWorkspaces } from './workspace-management.js';
import { BusinessReset } from './business-reset.js';

/** 数据管理挂在 /api 下的位置（装配 server/app.ts 挂在 /api/management） */
const MANAGEMENT_MOUNT = '/management';

/*
 * 数据管理的接口（只给本机管理员，接口表 shared/admin/data-management-api.ts）：列表、执行命令、初始化和它的预览、
 * 识别文件的列表和复制、打开。只取参数、认人、调服务；页面凭证由装配层对写接口统一检查。
 */
export function dataManagementRouter(store: Store, auth: AuthManager, imports?: ImportManager) {
  const router = Router(),
    on = route<DataManagementApi>(router, MANAGEMENT_MOUNT),
    service = new DataManagementService(store);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    requireLocalAdministrator(auth.actor(req));
    // 页面凭证由装配层对所有写接口统一检查（server/http-guards.ts，AuthManager.requireCsrf）
    next();
  });
  // 中间件已核过本机管理员，这里取出账号（同一个判断）
  const admin = (req: Request) => requireLocalAdministrator(auth.actor(req));
  // 初始化、识别文件的复制和打开只有数据管理窗口用，审计记成数据管理；/execute 也被别的页面借用，由服务按命令里的标记分
  const dataManager = (req: Request) => viaEntry(admin(req), AUDIT_SOURCE.dataManagement);
  const workspaces = () => imports ?? workspacesMissing();

  on('GET /management/records', ({ query, req }) =>
    service.list(managementRecordsQuerySchema.parse(query).module, auth.actor(req)),
  );
  on('GET /management/reset-preview', ({ query, req }) => {
    const q = resetPreviewQuerySchema.parse(query);
    return new BusinessReset(store).preview(q.scope, admin(req), { clearClosedFinance: q.clearClosedFinance === '1' });
  });
  on('POST /management/reset', ({ body, req }) => new BusinessReset(store, imports).execute(body, dataManager(req)));
  on('POST /management/execute', ({ body, req }) => service.execute(body, auth.actor(req), auth.sessionBinding(req)));
  on('GET /management/workspaces', () => workspaces().workspaceLists());
  on('POST /management/workspaces', ({ body, req }) => {
    // 本机管理员已在上面的中间件里核过
    const actor = dataManager(req),
      manager = workspaces();
    // 页面上的归档、恢复、删除走 AI 导入的地址（/api/ai/imports/batch、delete-many），这里只留复制和打开
    pageWorkspaceActionSchema.parse(body);
    return manageWorkspaces(store, manager, body, actor, auth.sessionBinding(req));
  });
  return router;
}

/** 装配没传识别导入（ImportManager）时，识别文件的两个地址回 503 */
function workspacesMissing(): never {
  throw new AppError('工作区未配置。', 503);
}
