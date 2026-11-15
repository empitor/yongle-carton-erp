// 长期记忆前后端共用的：上限、记忆面板提交的内容的规则、面板看到的样子（服务端 server/assistant/memory-store.ts、memory-router.ts）。
import { z } from 'zod';

/** 一条最多多少字、一个账号最多几条；放进上下文的最多几条、合计多少字。满了不自动挤掉旧的，提示用户到记忆面板整理。 */
export const memoryLimits = { chars: 200, count: 100, contextItems: 30, contextChars: 3000 } as const;
/** assistant：助手在对话里记的；manual：用户在记忆面板里自己加的（和建表的 CHECK 一致） */
export const memorySources = ['assistant', 'manual'] as const;

/** 面板上加一条、改一条 */
export const memoryContentBody = z.strictObject({
  content: z
    .string()
    .trim()
    .min(1, '请写上要记住的内容。')
    .max(memoryLimits.chars, `一条记忆最多 ${memoryLimits.chars} 个字。`),
});
/** 开关自动记忆 */
export const memoryAutoSaveBody = z.strictObject({ autoSave: z.boolean() });

export type MemoryItem = {
  id: number;
  content: string;
  source: (typeof memorySources)[number];
  createdAt: string;
  updatedAt: string;
};
/** 记忆面板一次要的全部：记忆（新的在前）、自动记忆开没开、上限 */
export type MemoryView = { memories: MemoryItem[]; autoSave: boolean; limits: { count: number; chars: number } };
