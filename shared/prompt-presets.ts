import { z } from 'zod';

export const promptEntrySchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  content: z.string().max(16000),
});
export const promptPresetSchema = z
  .strictObject({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    entries: z.array(promptEntrySchema).max(40),
  })
  .refine((p) => new Set(p.entries.map((e) => e.id)).size === p.entries.length, '条目编号重复')
  .refine(
    (p) => p.entries.reduce((n, e) => n + e.content.length, 0) <= 24000,
    '单份预设内容合计不能超过24000字',
  );
export const promptStateSchema = z
  .strictObject({
    revision: z.number().int().nonnegative(),
    activeId: z.string().uuid(),
    presets: z.array(promptPresetSchema).min(1).max(50),
  })
  .refine((s) => s.presets.some((p) => p.id === s.activeId), '当前预设不存在')
  .refine((s) => new Set(s.presets.map((p) => p.id)).size === s.presets.length, '预设编号重复');
export type PromptEntry = z.infer<typeof promptEntrySchema>;
export type PromptPreset = z.infer<typeof promptPresetSchema>;
export type PromptState = z.infer<typeof promptStateSchema>;
export type PromptPresetUsage = { id: string; name: string; revision: number; hash: string };
export type PromptSettingsView = PromptState & { csrfToken: string };
