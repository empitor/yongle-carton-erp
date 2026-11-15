import { z } from 'zod';

/** AI 设置接口收的正文（服务端 server/ai/settings-manager.ts 用同一份校验，接口表 ai-settings-api.ts 照它写） */

/** 识别同时跑几份：1 到 6，默认 3 */
export const CONCURRENCY = { min: 1, max: 6, initial: 3 } as const;
export const concurrencySchema = z.number().int().min(CONCURRENCY.min).max(CONCURRENCY.max);
const API_KEY_MAX_CHARS = 4096;
/** 每次改设置都带打开页面时的版本号，别的页面先改过就拒绝 */
export const aiRevisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
export const aiKeySchema = aiRevisionSchema.extend({
  apiKey: z.string().trim().min(1).max(API_KEY_MAX_CHARS),
});
export const aiKeyDeleteSchema = aiRevisionSchema.extend({ confirmed: z.literal(true) });
export const aiPreferencesSchema = aiRevisionSchema.extend({ recognitionConcurrency: concurrencySchema });
