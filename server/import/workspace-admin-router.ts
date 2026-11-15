import { Router, type Request } from 'express';
import { AppError, requireLocalAdministrator, route, type Actor } from '../core/index.js';
import { diagnosticsQuerySchema, type ImportsApi } from '../../shared/import/index.js';
import type { ImportManager } from './manager.js';

export type Operator = (req: Request) => Actor | null | undefined;

/**
 * AI 导入的归档、永久删除和错误档案（/api/ai/imports/ 下，接口表 shared/import/imports-api.ts）。
 * 软删除只有归档：有业务编辑权限就能归档、恢复；永久删除只给本机管理员；错误档案要业务编辑权限。
 * 一条错误档案带 ?download=1 时要加下载头，route() 设不了响应头，照旧用 express 注册。
 */
export function workspaceAdminRouter(manager: ImportManager, operator: Operator) {
  const router = Router(),
    on = route<ImportsApi>(router, '/ai/imports');
  // 归档、恢复：和单据、档案的 POST /api/<…>/batch 同一个写法
  on('POST /ai/imports/batch', ({ body, req }) => manager.changeArchive(body, operator(req)));
  on('POST /ai/imports/delete-many', ({ body, req }) => manager.deleteMany(body, requireLocalAdministrator(operator(req))));
  const diagnosticActor = (req: Request) => {
    if (!operator(req)?.permissions.includes('business:edit'))
      throw new AppError('请登录有业务管理权限的账号查看错误档案。', 403);
  };
  on('GET /ai/imports/diagnostics', ({ query, req }) => {
    diagnosticActor(req);
    const q = diagnosticsQuerySchema.parse(query);
    return manager.failures(q.workspaceId, q.offset);
  });
  router.get('/diagnostics/:failureId', (req, res) => {
    diagnosticActor(req);
    const record = manager.failure(String(req.params.failureId));
    if (req.query.download === '1') res.set('Content-Disposition', 'attachment; filename="ai-failure-' + record.id + '.json"');
    res.json(record);
  });
  return router;
}
