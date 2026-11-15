import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthManager, Store } from '../core/index.js';
import { AppError, requirePermission, route } from '../core/index.js';
import type { FlowApi } from '../../shared/business/index.js';
import { registerArrival } from './register-arrival.js';

/**
 * 登记到货的接口，挂在 /api 下（地址在订货单下面，接口表 shared/business/flow-api.ts）。
 * 到货更正在单据流转的 /api/flow/:id/correction-preview、/correct。
 */
export function receivingRouter(store: Store, auth?: AuthManager) {
  const router = Router();
  const on = route<FlowApi>(router);
  const actor = (req: Request) => {
    if (!auth) throw new AppError('此业务需要登录身份验证。', 403);
    // 页面凭证由装配层对所有写接口统一检查（server/http-guards.ts，AuthManager.requireCsrf）
    return requirePermission(auth.actor(req), 'business:edit');
  };
  const batchId = (raw: string) => z.coerce.number().int().positive().parse(raw);
  on('POST /order-batches/:id/receive', ({ param, body, req }) => registerArrival(store, { batchId: batchId(param('id')) }, body, actor(req)));
  return router;
}
