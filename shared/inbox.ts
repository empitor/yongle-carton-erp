export const inboxChannels = ['manual', 'wecom_bot', 'wecom_kf', 'wecom_archive'] as const;
export const inboxStatuses = ['pending', 'converted', 'ignored'] as const;
export const inboxKinds = ['text', 'image', 'file', 'voice', 'video', 'other'] as const;
export const convertedKinds = ['order', 'arrival', 'mark'] as const;
export type InboxChannel = (typeof inboxChannels)[number];
export type InboxStatus = (typeof inboxStatuses)[number];
export type InboxKind = (typeof inboxKinds)[number];
export type ConvertedKind = (typeof convertedKinds)[number];
export type WecomBotState = 'off' | 'connecting' | 'connected' | 'retrying' | 'auth_failed' | 'kicked';
export type WecomBotStatus = {
  state: WecomBotState;
  lastError: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  received: number;
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
