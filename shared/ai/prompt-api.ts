import type { z } from 'zod';
import type { PromptModuleDefinition, PromptModuleId } from './prompt-modules.js';
import type { PromptAction, PromptSettingsView, promptSaveSchema, promptTargetSchema } from './prompt-presets.js';

/*
 * 提示词的接口表（服务端 server/ai/prompt-router.ts）：列模块；每个提示词模块挂在自己的地址下（prompt-modules.ts 的 apiPath，
 * /api/ai/prompt-modules/模块），地址一样、只差模块。表的写法见 shared/core/api-table.ts。
 * 写入要带页面凭证（请求头 X-ERP-AI-Token，和登录的页面凭证是同一个值）。
 */
type Bodies = { [A in PromptAction]: z.input<A extends 'save' ? typeof promptSaveSchema : typeof promptTargetSchema> };

export type PromptApi = {
  /** 列出提示词模块：服务器上存在哪个文件（storageFile）不给页面 */
  'GET /ai/prompt-modules': { response: Omit<PromptModuleDefinition, 'storageFile'>[] };
} & {
  [M in PromptModuleId as `GET /ai/prompt-modules/${M}`]: { response: PromptSettingsView };
} & {
  [A in PromptAction as `POST /ai/prompt-modules/${PromptModuleId}/${A}`]: { body: Bodies[A]; response: PromptSettingsView };
};
