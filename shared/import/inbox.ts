import { z } from 'zod';
import { MIB } from '../core/index.js';
/** 机器人来源：设置库、接口、连接状态都用这个名字。 */
export const botChannels = ['wecom_bot', 'feishu_bot', 'dingtalk_bot'] as const;
export const inboxChannels = ['manual', ...botChannels] as const;
export const inboxStatuses = ['pending', 'converted', 'ignored'] as const;
export const inboxKinds = ['text', 'image', 'file', 'voice', 'video', 'other'] as const;
export const convertedKinds = ['order', 'arrival'] as const;
export type BotChannel = (typeof botChannels)[number];
export type InboxChannel = (typeof inboxChannels)[number];
export type InboxStatus = (typeof inboxStatuses)[number];
export type InboxKind = (typeof inboxKinds)[number];
export type ConvertedKind = (typeof convertedKinds)[number];
/** 收件箱来源的叫法：服务端的来源列表、页面、助手共用。 */
export const inboxChannelLabels: Record<InboxChannel, string> = {
  manual: '手动添加',
  wecom_bot: '企业微信机器人',
  feishu_bot: '飞书机器人',
  dingtalk_bot: '钉钉机器人',
};
/** 各家后台上凭据的原名，设置页照着写，用户才对得上。 */
export const botCredentialLabels: Record<BotChannel, { appId: string; secret: string }> = {
  wecom_bot: { appId: 'Bot ID', secret: 'Secret' },
  feishu_bot: { appId: 'App ID', secret: 'App Secret' },
  dingtalk_bot: { appId: 'Client ID', secret: 'Client Secret' },
};
const INBOX_MAX_FILE_MB = 20;
/** 收件箱一个文件最多多少字节：手动上传、机器人收文件、入库都按它。 */
export const INBOX_MAX_FILE = INBOX_MAX_FILE_MB * MIB;
/** 上限给人看的写法（20MB），提示和注意事项都引它。 */
export const INBOX_MAX_FILE_TEXT = INBOX_MAX_FILE_MB + 'MB';
/** 机器人长连接的状态：kicked 只有企业微信会有（同一机器人只能连一处，新连接会顶掉旧的）。 */
export type BotState = 'off' | 'connecting' | 'connected' | 'retrying' | 'auth_failed' | 'kicked';
export const botStateLabels: Record<BotState, string> = {
  off: '未启用',
  connecting: '连接中',
  connected: '已连接',
  retrying: '连接断开，正在重试',
  auth_failed: '连接被拒绝',
  kicked: '已被其他连接顶替',
};
export type BotStatus = {
  state: BotState;
  lastError: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  received: number;
};
/** 设置页看到的一家机器人：不含 Secret。 */
export type BotView = {
  channel: BotChannel;
  label: string;
  appId: string;
  hasSecret: boolean;
  enabled: boolean;
  status: BotStatus;
};
/** 收件箱的一条（接口、助手看到的样子；不含文件内容） */
export type InboxItem = {
  id: number;
  channel: InboxChannel;
  externalId: string;
  senderId: string;
  senderName: string;
  conversation: string;
  kind: InboxKind;
  text: string;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  fileSha256: string | null;
  status: InboxStatus;
  convertedKind: ConvertedKind | null;
  convertedRef: string | null;
  handledBy: string | null;
  handledAt: string | null;
  version: number;
  receivedAt: string;
  createdAt: string;
};
export type InboxIncoming = {
  channel: InboxChannel;
  externalId: string;
  senderId?: string;
  senderName?: string;
  conversation?: string;
  kind: InboxKind;
  text?: string;
  file?: { name: string; mime: string; bytes: Uint8Array };
  receivedAt: string;
};

/*
 * 收件箱接口收的正文和查询参数（服务端 server/inbox 按它们校验，接口表 inbox-api.ts 照它们的输入写类型）。
 */
/** 列表筛选：处理状态、来源、关键词 */
export const inboxFilterSchema = z.object({
  status: z.enum(inboxStatuses).optional(),
  channel: z.enum(inboxChannels).optional(),
  q: z.string().optional(),
});
/** 手动添加一段文字 */
export const inboxTextSchema = z.object({ text: z.string().min(1) });
/** 改处理状态（转入 AI 导入时带上转成了什么） */
export const inboxStatusSchema = z.object({
  status: z.enum(inboxStatuses),
  convertedKind: z.enum(convertedKinds).optional(),
  convertedRef: z.string().optional(),
  expectedVersion: z.number().int().positive(),
});
/** 转入 AI 导入，按哪种识别 */
export const inboxConvertSchema = z.strictObject({
  kind: z.enum(convertedKinds),
  expectedVersion: z.number().int().positive(),
});
/** 应用编号、Secret 最多多少字（各家后台给的都远短于这个数） */
const APP_ID_MAX = 128;
const SECRET_MAX = 512;
/** 保存一家机器人的设置 */
export const botSettingsSchema = z.strictObject({
  appId: z.string().trim().max(APP_ID_MAX),
  // 留空表示沿用已保存的 Secret。
  secret: z.string().trim().max(SECRET_MAX).optional(),
  enabled: z.boolean(),
});
