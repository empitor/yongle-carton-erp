import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireSuperAdminAccount, requireSuperModeFor, route, type Actor } from '../core/index.js';
import { ZodError } from 'zod';
import type { AiSettingsApi } from '../../shared/ai/index.js';
import { aiPageGuard } from './page-guard.js';
import type { AiSettingsManager } from './settings-manager.js';
import { AiConnectionError } from './errors.js';

/** 挂在 /api/ai/settings 下（app.ts） */
const MOUNT = '/ai/settings';
/** 办设置时出的错：打上记号交给本路由器末尾的 settingsError；关卡、认人出的错不带记号，照旧交全站的出错回答 */
class SettingsFailure extends Error {
  constructor(readonly original: unknown) {
    super('AI 设置操作出错', { cause: original });
  }
}
const settled = async <T>(job: () => T | Promise<T>): Promise<T> => {
  try {
    return await job();
  } catch (error) {
    throw new SettingsFailure(error);
  }
};

/**
 * AI 设置的接口（/api/ai/settings，接口表 shared/ai/ai-settings-api.ts）。actorOf 是开了登录时认登录账号的办法：
 * 模型配置关系到密钥和对外发送，改密钥和识别设置要先进超级管理员模式；查余额、重新测试不改配置，超级管理员账号就行；
 * 读取只有设置页用，也只给超级管理员账号（聊天和识别要的“能不能用、用哪个模型”在 GET /api/assistant 的 ai 里）；
 * 没开登录（测试）时不查。
 */
const checksOnly = new Set(['/balance', '/test']);
export function aiSettingsRouter(manager: AiSettingsManager, actorOf?: (req: Request) => Actor | null | undefined) {
  const router = Router();
  const on = route<AiSettingsApi>(router, MOUNT);
  if (actorOf)
    router.use((req, _res, next) => {
      // 拒绝的说法和类别跟全站一致（server/core/permissions.ts），拒绝时抛错交全站的出错回答
      const who = actorOf(req);
      if (req.method === 'GET') requireSuperAdminAccount(who, '查看 AI 设置');
      else if (checksOnly.has(req.path)) requireSuperAdminAccount(who, '修改 AI 设置');
      else requireSuperModeFor(who, '修改 AI 设置');
      next();
    });
  router.use(aiPageGuard(manager.csrfToken, 'AI 设置'));
  on('GET /ai/settings', () => manager.view());
  on('POST /ai/settings/key', ({ body }) => settled(() => manager.saveAndTestKey(body)));
  on('POST /ai/settings/key/save', ({ body }) => settled(() => manager.saveKey(body)));
  on('POST /ai/settings/key/delete', ({ body }) => settled(() => manager.removeKey(body)));
  on('POST /ai/settings/test', ({ body }) => settled(() => manager.testKey(body)));
  on('POST /ai/settings/balance', () => settled(() => manager.balance()));
  on('POST /ai/settings/preferences', ({ body }) => settled(() => manager.preferences(body)));
  router.use(settingsError);
  return router;
}
function settingsError(failure: unknown, _req: Request, res: Response, next: NextFunction) {
  if (!(failure instanceof SettingsFailure)) return next(failure);
  const error = failure.original;
  // 不透传 SDK/上游正文、堆栈或输入值，防止供应商回显 API Key。回答和全站一样是 { message, code }。
  if (error instanceof AiConnectionError)
    return res.status(error.status).json({ message: error.message, code: error.code });
  // 填写不合格交给全站的出错回答，按界面叫法说哪一栏不对（server/http-errors.ts，不带输入值）
  if (error instanceof ZodError) return next(error);
  return res
    .status(500)
    .json({ message: 'AI 设置操作失败，请刷新后重试；密钥不会写入运行日志。', code: 'upstream' });
}
