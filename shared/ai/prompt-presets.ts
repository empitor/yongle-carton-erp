import { z } from 'zod';

/** 提示词预设的上限：名称字数、单条字数、单份合计字数、单份条数、预设份数 */
const PROMPT_LIMITS = {
  nameChars: 80,
  entryChars: 16000,
  presetChars: 24000,
  entries: 40,
  presets: 50,
} as const;
const promptName = z.string().trim().min(1).max(PROMPT_LIMITS.nameChars);

export const promptEntrySchema = z.strictObject({
  id: z.uuid(),
  name: promptName,
  enabled: z.boolean(),
  content: z.string().max(PROMPT_LIMITS.entryChars),
});
export const promptPresetSchema = z
  .strictObject({
    id: z.uuid(),
    name: promptName,
    entries: z.array(promptEntrySchema).max(PROMPT_LIMITS.entries),
  })
  .refine((p) => new Set(p.entries.map((e) => e.id)).size === p.entries.length, '条目编号重复')
  .refine(
    (p) => p.entries.reduce((n, e) => n + e.content.length, 0) <= PROMPT_LIMITS.presetChars,
    '单份预设内容合计不能超过' + PROMPT_LIMITS.presetChars + '字',
  );
export const promptStateSchema = z
  .strictObject({
    revision: z.number().int().nonnegative(),
    activeId: z.uuid(),
    presets: z.array(promptPresetSchema).min(1).max(PROMPT_LIMITS.presets),
    // 哪些预设是从默认建出来、还没改过：预设编号 → 当时默认内容的指纹（server/ai/prompt-defaults.ts）
    defaults: z.record(z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  })
  .refine((s) => s.presets.some((p) => p.id === s.activeId), '当前预设不存在')
  .refine((s) => new Set(s.presets.map((p) => p.id)).size === s.presets.length, '预设编号重复');
/** 改提示词预设的几种动作（地址 /api/ai/prompt-modules/模块/动作） */
export const promptActions = ['save', 'copy', 'activate', 'delete', 'restore'] as const;
export type PromptAction = (typeof promptActions)[number];
/** 每次改动都带打开页面时的版本号：先只认这一项，版本对了再按动作核对整份正文 */
export const promptRevisionSchema = z.object({ expectedRevision: z.number().int().nonnegative() });
/** 保存一份预设（没有就加上），activate 为真时顺手启用 */
export const promptSaveSchema = promptRevisionSchema
  .extend({ preset: promptPresetSchema, activate: z.boolean().default(false) })
  .strict();
/** 复制、启用、删除、恢复默认：按编号点一份预设；删除和恢复要 confirmed */
export const promptTargetSchema = promptRevisionSchema
  .extend({ id: z.uuid(), confirmed: z.boolean().optional() })
  .strict();
export type PromptPreset = z.infer<typeof promptPresetSchema>;
export type PromptState = z.infer<typeof promptStateSchema>;
export type PromptPresetUsage = { id: string; name: string; revision: number; hash: string };
export type PromptSettingsView = PromptState & { csrfToken: string };
