import type { z } from 'zod';
import type { pagingSchema } from '../core/index.js';
import type {
  BotState,
  BotView,
  InboxChannel,
  InboxItem,
  InboxStatus,
  botSettingsSchema,
  inboxConvertSchema,
  inboxFilterSchema,
  inboxStatusSchema,
  inboxTextSchema,
} from './inbox.js';

/*
 * 收件箱的接口表（服务端 server/inbox/router.ts，挂在 /api/inbox 下）。表的写法见 shared/core/api-table.ts。
 * 下载原件（回文件）和上传文件（收原始字节）不是 JSON 来回，照旧由 express 直接注册。
 */
/** 列表：这一页的收件、筛出几条、各状态几条（页签数字），带了页码才有 page、pageSize */
export type InboxList = {
  rows: InboxItem[];
  filteredRecords: number;
  page?: number;
  pageSize?: number;
  totalRecords: number;
  counts: Record<InboxStatus, number>;
};
/** 收件箱的一个来源：手动添加和三家机器人（填好凭据、启用了才算配好） */
export type InboxChannelOption = { id: InboxChannel; label: string; configured: boolean; state?: BotState };

export type InboxApi = {
  'GET /inbox': { query?: z.input<typeof inboxFilterSchema> & z.input<typeof pagingSchema>; response: InboxList };
  'GET /inbox/channels': { response: InboxChannelOption[] };
  'GET /inbox/bots': { response: BotView[] };
  'POST /inbox/bots/:channel': { body: z.input<typeof botSettingsSchema>; response: BotView[] };
  'POST /inbox': { body: z.input<typeof inboxTextSchema>; response: InboxItem };
  'GET /inbox/:id': { response: InboxItem };
  'POST /inbox/:id/convert': {
    body: z.input<typeof inboxConvertSchema>;
    response: { workspaceId: string; item: InboxItem; reused: boolean };
  };
  'POST /inbox/:id/status': { body: z.input<typeof inboxStatusSchema>; response: InboxItem };
};
