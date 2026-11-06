import type { InboxIncoming, WecomBotState } from '../../shared/inbox.js';
export interface InboxChannel {
  id: string;
  label: string;
  configured(): boolean;
  pull(): Promise<InboxIncoming[]>;
}
export const wecomKfChannel: InboxChannel = {
  id: 'wecom_kf',
  label: '企业微信客服',
  configured: () => Boolean(process.env.WECOM_CORP_ID && process.env.WECOM_KF_SECRET),
  async pull() {
    throw new Error('企业微信客服通道尚未连接');
  },
};
type WecomMessage = {
  msgid: string;
  external_userid?: string;
  send_time: number;
  msgtype: string;
  text?: { content?: string };
  image?: { media_id?: string };
  voice?: { media_id?: string };
  video?: { media_id?: string };
  file?: { media_id?: string };
};
export function parseWecomKfMessage(msg: WecomMessage): InboxIncoming {
  const kind = ['text', 'image', 'voice', 'video', 'file'].includes(msg.msgtype)
    ? (msg.msgtype as InboxIncoming['kind'])
    : 'other';
  const media =
    kind === 'image' || kind === 'voice' || kind === 'video' || kind === 'file'
      ? msg[kind]?.media_id
      : undefined;
  return {
    channel: 'wecom_kf',
    externalId: msg.msgid,
    senderId: msg.external_userid,
    kind,
    text: kind === 'text' ? (msg.text?.content ?? '') : media ? `media:${media}` : '',
    receivedAt: new Date(msg.send_time * 1000).toISOString(),
  };
}
export function listInboxChannels(bot?: { configured: boolean; state: WecomBotState }) {
  return [
    { id: 'manual', label: '手动添加', configured: true },
    { id: 'wecom_bot', label: '企业微信机器人', configured: !!bot?.configured, state: bot?.state ?? 'off' },
    { id: wecomKfChannel.id, label: wecomKfChannel.label, configured: wecomKfChannel.configured() },
    { id: 'wecom_archive', label: '企业微信会话存档', configured: false },
  ];
}
