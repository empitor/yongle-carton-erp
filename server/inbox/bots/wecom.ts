/**
 * 企业微信智能机器人长连接的协议：订阅帧认证、ping 心跳、消息回调拆条、媒体下载后解密、流式回复。
 * 官方文档：https://developer.work.weixin.qq.com/document/path/101463
 */
import { createDecipheriv, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { INBOX_MAX_FILE } from '../../../shared/import/index.js';
import { NoRetry, downloadMedia } from './media.js';
import { BotFailure, jsonText, looseText, type BotLink, type BotMessage, type BotPart, type BotProtocol, type ProtocolDeps } from './protocol.js';

const WECOM_BOT_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_MS = 30_000;
/** AES-256 的密钥字节数、CBC 的分组字节数（IV 取密钥前这么多字节） */
const AES_KEY_BYTES = 32;
const AES_BLOCK_BYTES = 16;
/** 企业微信的 PKCS#7 按 32 字节补齐：密文最多比原文多这么多 */
const PAD_BLOCK_BYTES = 32;
/** 订阅被拒时的错误码：Bot ID 或 Secret 不对 */
const BAD_CREDENTIALS = 853000;

/** AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 按 32 字节补齐（Node 默认按 16，要手动去）。 */
export function decryptWecomMedia(data: Uint8Array, aesKey: string) {
  const key = Buffer.from(aesKey, 'base64');
  if (key.length !== AES_KEY_BYTES) throw new BotFailure('解密密钥长度不对');
  if (!data.length || data.length % AES_BLOCK_BYTES) throw new BotFailure('密文长度不对');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, AES_BLOCK_BYTES));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > PAD_BLOCK_BYTES || pad > plain.length) throw new BotFailure('解密结果不对');
  for (let i = plain.length - pad; i < plain.length; i++)
    if (plain[i] !== pad) throw new BotFailure('解密结果不对');
  return plain.subarray(0, plain.length - pad);
}

/** 下载要的地址和解密密钥；消息里写了文件但认不出这两栏的，下载时报“没有下载信息” */
type WecomMedia = { url: string; aeskey: string };
type WecomReply = { link: BotLink<WecomMedia, WecomReply>; reqId: string };
type WecomLink = BotLink<WecomMedia, WecomReply>;
type WecomPart = BotPart<WecomMedia>;

/*
 * 企业微信发来的内容（外来数据）的结构。各栏缺了或类型不对按没写算（looseText），和以前一样不丢整条消息。
 */
const mediaFields = z.object({ url: looseText, aeskey: looseText }).catch({ url: '', aeskey: '' });
/** 没写就是没有文件（存成一条空文字，和以前一样）；写了就当文件 */
const mediaField = z.unknown().optional().transform((v) => (v ? mediaFields.parse(v) : undefined));
const spoken = z.object({ content: looseText }).catch({ content: '' });
const itemShape = {
  msgtype: looseText,
  text: spoken,
  voice: spoken,
  image: mediaField,
  file: mediaField,
  video: mediaField,
};
const emptyItem = { msgtype: '', text: { content: '' }, voice: { content: '' }, image: undefined, file: undefined, video: undefined };
const wecomItem = z.object(itemShape).catch(emptyItem);
const wecomBody = z.object({
  ...itemShape,
  msgid: looseText,
  mixed: z.object({ msg_item: z.array(wecomItem).catch([]) }).catch({ msg_item: [] }),
  from: z.object({ userid: looseText }).catch({ userid: '' }),
  chattype: looseText,
  chatid: looseText,
});
type WecomBody = z.infer<typeof wecomBody>;
const wecomFrame = z.object({
  cmd: looseText,
  headers: z.object({ req_id: looseText }).catch({ req_id: '' }),
  errcode: z.unknown().optional(),
  body: z.unknown().optional(),
});
type WecomFrame = z.infer<typeof wecomFrame>;
const kickedEvent = z.object({ event: z.object({ eventtype: z.literal('disconnected_event') }) });

function itemPart(item: z.infer<typeof wecomItem>, externalId: string): WecomPart {
  switch (item.msgtype) {
    case 'text':
      return { externalId, kind: 'text', text: item.text.content };
    case 'voice':
      return { externalId, kind: 'voice', text: item.voice.content };
    case 'image':
      return { externalId, kind: 'image', media: item.image };
    case 'file':
      return { externalId, kind: 'file', media: item.file };
    case 'video':
      return { externalId, kind: 'video', media: item.video };
    default:
      return { externalId, kind: 'other', text: '收到一条暂不支持的消息（类型：' + (item.msgtype || '未知') + '）' };
  }
}

function bodyParts(body: WecomBody): WecomPart[] {
  if (!body.msgid) return [];
  if (body.msgtype === 'mixed') return body.mixed.msg_item.map((item, i) => itemPart(item, body.msgid + '#' + i));
  return [itemPart(body, body.msgid)];
}

/** 图文混排拆成多条，每个文件都能单独转单。 */
export function wecomMessageParts(raw: unknown): WecomPart[] {
  const body = wecomBody.safeParse(raw);
  return body.success ? bodyParts(body.data) : [];
}

function message(frame: WecomFrame, body: WecomBody, link: WecomLink): BotMessage<WecomMedia, WecomReply> {
  const sender = body.from.userid;
  return {
    parts: bodyParts(body),
    senderId: sender,
    senderName: sender,
    conversation: body.chattype === 'group' ? '群聊 ' + body.chatid : '',
    // 官方文档里消息回调没有发送时间（create_time 只在事件回调里有），记收到的时间
    receivedAt: new Date().toISOString(),
    replyTo: { link, reqId: frame.headers.req_id },
  };
}

const send = (link: WecomLink, frame: unknown) => link.send(JSON.stringify(frame));

/** 订阅的回应：0 是接通；别的不反复重试（订阅有频率保护）。对方的 errmsg 多是英文，不给人看，只留错误码 */
function onSubscribed(frame: WecomFrame, link: WecomLink) {
  if (frame.errcode === 0) link.authOk();
  else
    link.authFailed(
      frame.errcode === BAD_CREDENTIALS
        ? 'Bot ID 或 Secret 不对（853000）。请到企业微信后台核对，并确认 API 模式是长连接。'
        : '企业微信拒绝连接（' + String(frame.errcode) + '）：请检查 Bot ID 和 Secret，并确认 API 模式是长连接。',
    );
}

/** 对方推来的命令：消息回调交给连接；被别处的连接顶掉就停下 */
function onCommand(frame: WecomFrame, link: WecomLink) {
  if (frame.cmd === 'aibot_msg_callback') {
    // 以前 body 不是对象时按空的拆，拆不出消息，等于不收
    const body = wecomBody.safeParse(frame.body ?? {});
    if (body.success) link.received(message(frame, body.data, link));
  } else if (frame.cmd === 'aibot_event_callback' && kickedEvent.safeParse(frame.body).success)
    // 同一机器人只能有一条连接；不自动重连，否则两边会一直互相踢。
    link.kicked('这个机器人在别处建立了新连接，本机已断开。确认后可重新连接。');
}

export type WecomOptions = ProtocolDeps & {
  /** 测试用：本机模拟服务端的地址。 */
  url?: string;
};

export function wecomProtocol(options: WecomOptions = {}): BotProtocol<WecomMedia, WecomReply> {
  let subscribeId = '';
  return {
    channel: 'wecom_bot',
    name: '企业微信',
    connectUrl: () => options.url || WECOM_BOT_URL,
    onOpen(link, credentials) {
      subscribeId = 'aibot_subscribe_' + randomUUID();
      send(link, {
        cmd: 'aibot_subscribe',
        headers: { req_id: subscribeId },
        body: { bot_id: credentials.appId, secret: credentials.secret },
      });
    },
    heartbeatMs: () => HEARTBEAT_MS,
    ping(link) {
      send(link, { cmd: 'ping', headers: { req_id: 'ping_' + randomUUID() } });
    },
    onFrame(data, link) {
      const parsed = wecomFrame.safeParse(jsonText(data.toString('utf8')));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.cmd) onCommand(frame, link);
      else if (frame.headers.req_id === subscribeId && subscribeId) {
        subscribeId = '';
        onSubscribed(frame, link);
      } else if (frame.headers.req_id.startsWith('ping_')) link.pong();
    },
    async fetch({ url, aeskey }) {
      if (!url || !aeskey) throw new NoRetry('消息里没有下载信息');
      const file = await downloadMedia(url, options, { limit: INBOX_MAX_FILE + PAD_BLOCK_BYTES });
      return { bytes: decryptWecomMedia(file.data, aeskey), name: file.name };
    },
    reply({ link, reqId }, content) {
      if (!reqId) return;
      send(link, {
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content } },
      });
    },
  };
}
