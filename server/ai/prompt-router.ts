import { Router, type Request } from 'express';
import { requirePermission, route, type Actor } from '../core/index.js';
import { promptActions, promptModules, type PromptApi, type PromptModuleId } from '../../shared/ai/index.js';
import type { PromptPresetManager } from './prompt-presets.js';
import { aiPageGuard } from './page-guard.js';

/** 提示词的地址都在这下面（列模块就是它本身） */
const MOUNT = '/ai/prompt-modules';

/**
 * 列出提示词模块（接口表 shared/ai/prompt-api.ts）：app.ts 把它挂在 /api/ai/prompt-modules 下。
 * 要业务编辑权限；不经页面关卡（和各模块的地址不同，没有跨站拒绝和 no-store），只读模块身份和展示信息。
 */
export function promptModuleListRouter(actorOf: (req: Request) => Actor | null) {
  const router = Router();
  route<PromptApi>(router, MOUNT)('GET /ai/prompt-modules', ({ req }) => {
    requirePermission(actorOf(req), 'business:edit');
    return promptModules.map((module) => ({
      id: module.id,
      name: module.name,
      description: module.description,
      purpose: module.purpose,
      apiPath: module.apiPath,
      status: module.status,
      documents: module.documents,
      usage: module.usage,
    }));
  });
  return router;
}

/**
 * 一个提示词模块的地址（接口表 shared/ai/prompt-api.ts）：app.ts 把它挂在 /api/ai/prompt-modules/模块 下，
 * 登录和超级管理员模式在挂的地方查，这里查跨站和页面凭证。读当前预设；五种改法改完回改后的整份。
 */
export function promptSettingsRouter(module: PromptModuleId, manager: PromptPresetManager, csrfToken: string) {
  const router = Router();
  const base = `${MOUNT}/${module}` as const;
  const on = route<PromptApi>(router, base);
  router.use(aiPageGuard(csrfToken, '提示词设置'));
  const view = () => ({ ...manager.view(), csrfToken });
  on(`GET ${base}`, view);
  for (const action of promptActions)
    on(`POST ${base}/${action}`, ({ body }) => {
      manager.change(action, body);
      return view();
    });
  return router;
}
