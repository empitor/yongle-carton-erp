import { Router, type Request } from 'express';
import type { AuthManager } from '../core/index.js';
import type { ReceiptAi } from './receipt-ai.js';
import { AppError, requirePermission, route } from '../core/index.js';
import type { ImportsApi } from '../../shared/import/index.js';

/**
 * 读一份到货原件的识别记录（GET /api/flow/sources/:sourceId，接口表 shared/import/imports-api.ts），AI 导入页的到货类型用它。
 * 单独的“上传送货单再识别”那一套去掉了，识别只走 AI 导入的到货类型（/api/ai/imports/:id/arrival/recognize）。
 * 看原件文件（/sources/:id/file）在单据流转的路由里：原件表归单据流转。
 */
export function receiptSourceRouter(auth?: AuthManager, receiptAi?: ReceiptAi) {
  const router = Router();
  const actor = (req: Request) => {
    if (!auth) throw new AppError('此业务需要登录身份验证。', 403);
    return requirePermission(auth.actor(req), 'business:edit');
  };
  // 识别记录会被重新识别改掉：不让浏览器缓存（route() 不设响应头，先在这一条上设好）
  router.get('/sources/:sourceId', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  route<ImportsApi>(router, '/flow')('GET /flow/sources/:sourceId', ({ param, req }) => {
    actor(req);
    if (!receiptAi) throw new AppError('到货识别未配置。', 503);
    return receiptAi.source(param('sourceId'));
  });
  return router;
}
