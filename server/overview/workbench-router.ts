import { Router } from 'express';
import { z } from 'zod';
import { autoBackupFailure, notFound, route, type RequestAuth, type Store } from '../core/index.js';
import { today } from '../../shared/core/index.js';
import type { WorkbenchApi } from '../../shared/business/index.js';
import { listFields } from '../orders/index.js';
import { orderDashboard } from './dashboard.js';
import { relatedBusiness } from './related-business.js';
import { recordContext, requireRecordReader } from './record-context.js';
import { buildToday } from './workbench.js';

const recordId = (raw: string) => z.coerce.number().int().positive().parse(raw);

/*
 * 今日、经营概况、订单和采购单的关联记录、任一记录的关联记录与修改历史（挂在 /api 下，接口表 shared/business/overview/workbench-api.ts）。
 * 只取参数、判断权限、调服务。
 */
export function workbenchRouter(store: Store, auth: RequestAuth | undefined) {
  const router = Router(),
    on = route<WorkbenchApi>(router);
  on('GET /business/:entity/:id/related', ({ param, req }) => {
    requireRecordReader(auth?.actor(req));
    const entity = z.enum(['orders', 'purchases']).parse(param('entity'));
    return relatedBusiness(store, entity, recordId(param('id'))) ?? notFound('业务记录不存在。');
  });
  // 记录详情“更多”里的“关联记录与修改历史”：和助手查修改历史同一个函数、同一个权限判断
  on('GET /business/:module/:id/context', ({ param, req }) =>
    recordContext(store, param('module'), recordId(param('id')), auth?.actor(req)),
  );
  on('GET /business/today', ({ req }) => {
    const actor = auth?.actor(req),
      failure = autoBackupFailure();
    return {
      ...buildToday(store, today()),
      // 只读账号处理不了备份问题，不打扰；错误原文只在服务端日志。
      backupFailedAt: failure && actor?.permissions.includes('business:edit') ? failure.at : null,
    };
  });
  on('GET /dashboard', ({ query }) => orderDashboard(store, listFields(query)));
  return router;
}
