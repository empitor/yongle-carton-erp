import type { z } from 'zod';
import type { AiBalance, AiSettingsView } from './ai-settings.js';
import type { aiKeyDeleteSchema, aiKeySchema, aiPreferencesSchema, aiRevisionSchema } from './ai-settings-input.js';

/*
 * AI 设置的接口表（服务端 server/ai/settings-router.ts，挂在 /api/ai/settings 下）。表的写法见 shared/core/api-table.ts。
 * 写入要带这一页自己的页面凭证（请求头 X-ERP-AI-Token，凭证在读设置的回答 csrfToken 里）；回答里从来没有密钥。
 */
type Revision = z.input<typeof aiRevisionSchema>;

export type AiSettingsApi = {
  'GET /ai/settings': { response: AiSettingsView };
  /** 保存并测试：密钥对才存；余额不足照样存、不带 balance */
  'POST /ai/settings/key': { body: z.input<typeof aiKeySchema>; response: AiSettingsView & { balance?: AiBalance } };
  /** 只保存不测试 */
  'POST /ai/settings/key/save': { body: z.input<typeof aiKeySchema>; response: AiSettingsView };
  'POST /ai/settings/key/delete': { body: z.input<typeof aiKeyDeleteSchema>; response: AiSettingsView };
  /** 用已存的密钥重新测试（查余额） */
  'POST /ai/settings/test': { body: Revision; response: AiSettingsView & { balance: AiBalance } };
  /** 查余额（免费，不改配置）：服务端不看正文 */
  'POST /ai/settings/balance': { body: Record<string, never>; response: AiBalance };
  'POST /ai/settings/preferences': { body: z.input<typeof aiPreferencesSchema>; response: AiSettingsView };
};
