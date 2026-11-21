// 一次聊天请求的输入：用户这句话、选的附件、页面快照和当前选中的记录；
// 或者是人在确认卡片上点了确认、拒绝之后的“接着办”（带 card，没有用户的话）。
import { z } from 'zod';
import { pageSnapshotSchema } from '../../../shared/assistant/index.js';
import { DEEPSEEK_THINKING_LEVELS } from '../../../shared/ai/index.js';
import { attachmentLimits } from '../../../shared/core/index.js';
import { dataManagementModules } from '../../../shared/business/index.js';

export const CARD_DECISIONS = ['confirmed', 'rejected'] as const;
/** 用户一句话最多多少字（输入框 src/assistant/AssistantComposer.tsx 也是这么多） */
const TEXT_CHARS = 6000;
/** 当前页面的地址最多多少字 */
const PAGE_CHARS = 500;

/** 每次请求现建一份结构（和拆分前一样），默认值（比如空附件列表）不在请求之间共用。 */
export function parseChatInput(raw: unknown) {
  return z
    .strictObject({
      requestId: z.uuid(),
      pageClientId: z.uuid().optional(),
      pageSnapshot: pageSnapshotSchema.optional(),
      /** 思考档位；带了就记成这个账号的默认 */
      thinking: z.enum(DEEPSEEK_THINKING_LEVELS).optional(),
      text: z.string().trim().max(TEXT_CHARS),
      attachmentIds: z.array(z.uuid()).max(attachmentLimits.messageCount).default([]),
      usePreviousAttachments: z.boolean().default(true),
      /** 人刚在这张卡片上点了确认或拒绝：把结果交给模型接着办剩下的步骤 */
      card: z.strictObject({ id: z.uuid(), decision: z.enum(CARD_DECISIONS) }).optional(),
      /** 页面上正在看的那条记录：module 是全站记录种类（stock_items、arrival……），由服务器换成助手模块 */
      context: z
        .object({
          page: z.string().max(PAGE_CHARS),
          module: z.enum(dataManagementModules).optional(),
          id: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .parse(raw);
}
export type ChatInput = ReturnType<typeof parseChatInput>;
