import { Router } from 'express';
import { AppError, route, type AuthManager, type Store } from '../core/index.js';
import { recordEntities, type LifecycleApi } from '../../shared/business/index.js';
import { changeLifecycle } from './lifecycle.js';

/**
 * 六类档案（客户、产品、订单、供应商、采购单、库存品）的批量归档、恢复（挂在 /api 下，接口表 shared/business/lifecycle-api.ts）：
 * POST /api/<档案>/batch，共用一套规则（lifecycle.ts）。只取参数、调服务；页面凭证由装配层对写接口统一检查。
 * 单据的批量归档恢复在单据流转（/api/flow/batch）。
 */
export function lifecycleRouter(store: Store, auth?: AuthManager) {
  const router = Router();
  const on = route<LifecycleApi>(router);
  for (const entity of recordEntities)
    on(`POST /${entity}/batch`, ({ body, req }) => {
      if (!auth) throw new AppError('请登录管理账号并刷新页面。', 403);
      return changeLifecycle(store, entity, body, auth.actor(req));
    });
  return router;
}
