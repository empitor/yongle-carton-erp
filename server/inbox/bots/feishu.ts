/**
 * 飞书企业自建应用机器人的长连接：用 App ID、App Secret 换连接地址，protobuf 帧（feishu-frame.ts），
 * 收到“接收消息”事件先回包（官方要求 3 秒内）再慢慢处理；文件用租户访问令牌下载，回复走开放接口。
 * 长连接：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * 协议细节照官方 Node SDK 的 ws-client（@larksuiteoapi/node-sdk 1.76.0）。
 */
import { z } from 'zod';
import { NoRetry, downloadMedia } from './media.js';
import { DEFAULT_PING_MS, FEISHU_API, endpointOf, tenantTokens } from './feishu-auth.js';
import { postJson } from './http.js';
import {
  FRAME_CONTROL,
  FRAME_DATA,
  FragmentCache,
  decodeFrame,
  encodeFrame,
  headerOf,
  type FeishuFrame,
} from './feishu-frame.js';
import { jsonText, looseList, looseText, type BotLink, type BotPart, type BotProtocol, type ProtocolDeps } from './protocol.js';

const RECEIVE_EVENT = 'im.message.receive_v1';

type FeishuMedia = { messageId: string; key: string; type: 'image' | 'file'; name?: string };
type FeishuReply = { messageId: string };
type FeishuPart = BotPart<FeishuMedia>;
type FeishuLink = BotLink<FeishuMedia, FeishuReply>;

/*
 * 飞书发来的内容（外来数据）的结构。各栏缺了或类型不对按没写算（looseText、looseList），和以前一样不丢整条消息。
 */
const mention = z.object({ key: looseText, name: looseText });
const postElement = z.object({
  tag: looseText,
  image_key: looseText,
  file_key: looseText,
  user_name: looseText,
  text: z.string().optional().catch(undefined),
});
const postContent = z.object({ title: looseText, content: looseList(looseList(postElement)) }).catch({ title: '', content: [] });
/** 一条消息的 content（JSON 文字解析出来的）：文字、图片、文件的几栏 */
const messageContent = z
  .object({
    text: looseText,
    image_key: looseText,
    file_key: looseText,
    file_name: z.string().optional().catch(undefined),
  })
  .catch({ text: '', image_key: '', file_key: '', file_name: undefined });
const feishuMessage = z.object({
  message_id: looseText,
  message_type: looseText,
  content: looseText,
  mentions: looseList(mention),
  create_time: looseText,
  chat_type: looseText,
  chat_id: looseText,
});
type FeishuMessage = z.infer<typeof feishuMessage>;
/** 接收消息事件：别的事件、机器人（或别的机器人）自己发的、没有消息的都认不过，不收（防止互相回复） */
const receiveEvent = z.object({
  header: z.object({ event_type: z.literal(RECEIVE_EVENT) }),
  event: z.object({
    sender: z.object({
      sender_type: z.literal('user'),
      sender_id: z.object({ open_id: looseText }).catch({ open_id: '' }),
    }),
    message: feishuMessage,
  }),
});

const unsupported = (externalId: string, type: string): FeishuPart => ({
  externalId,
  kind: 'other',
  text: '收到一条暂不支持的消息（类型：' + (type || '未知') + '）',
});

/** 文字里的 @_user_1 换成被 @ 的人名。 */
function withMentions(text: string, mentions: FeishuMessage['mentions']) {
  let out = text;
  for (const m of mentions) if (m.key) out = out.split(m.key).join('@' + m.name);
  return out.trim();
}

/** 富文本的一行：文字和 @ 拼成一句，图片、视频各算一个文件 */
function postLine(id: string, row: z.infer<typeof postElement>[], files: Omit<FeishuPart, 'externalId'>[]) {
  let line = '';
  for (const el of row) {
    if (el.tag === 'img' && el.image_key)
      files.push({ kind: 'image', media: { messageId: id, key: el.image_key, type: 'image' } });
    else if (el.tag === 'media' && el.file_key)
      files.push({ kind: 'video', media: { messageId: id, key: el.file_key, type: 'file' } });
    else if (el.tag === 'at') line += '@' + el.user_name;
    else if (el.text !== undefined) line += el.text;
  }
  return line;
}

/** 富文本拆成一条文字和若干图片、视频，每个文件都能单独转单。 */
function postParts(id: string, raw: unknown): FeishuPart[] {
  const content = postContent.parse(raw);
  const lines: string[] = content.title ? [content.title] : [];
  const files: Omit<FeishuPart, 'externalId'>[] = [];
  for (const row of content.content) {
    const line = postLine(id, row, files);
    if (line.trim()) lines.push(line);
  }
  const all = [...(lines.length ? [{ kind: 'text' as const, text: lines.join('\n') }] : []), ...files];
  return all.map((part, i) => ({ ...part, externalId: id + '#' + i }));
}

function messageParts(message: FeishuMessage): FeishuPart[] {
  const id = message.message_id,
    type = message.message_type;
  if (!id) return [];
  const raw = jsonText(message.content || '{}');
  const content = messageContent.parse(raw);
  const file = (kind: FeishuPart['kind'], key: string, fileType: FeishuMedia['type']): FeishuPart => ({
    externalId: id,
    kind,
    media: { messageId: id, key, type: fileType, name: content.file_name },
  });
  switch (type) {
    case 'text':
      return [{ externalId: id, kind: 'text', text: withMentions(content.text, message.mentions) }];
    case 'image':
      return [file('image', content.image_key, 'image')];
    case 'file':
      return [file('file', content.file_key, 'file')];
    case 'audio':
      return [file('voice', content.file_key, 'file')];
    case 'media':
      return [file('video', content.file_key, 'file')];
    case 'post':
      return postParts(id, raw);
    case 'merge_forward':
      return [{ externalId: id, kind: 'other', text: '收到合并转发的消息，飞书不给机器人看里面的内容，请逐条转发。' }];
    default:
      return [unsupported(id, type)];
  }
}

/** 飞书消息（事件里的 message）拆成几条；不是消息的拆不出来 */
export function feishuMessageParts(raw: unknown): FeishuPart[] {
  const message = feishuMessage.safeParse(raw);
  return message.success ? messageParts(message.data) : [];
}

const send = (link: FeishuLink, frame: FeishuFrame) => link.send(encodeFrame(frame));

/** 收到一段事件（可能是几片中的一片）：收齐了先回包，是用户发来的消息就交给连接 */
function onEvent(frame: FeishuFrame, link: FeishuLink, fragments: FragmentCache) {
  const merged = fragments.merge(
    headerOf(frame, 'message_id') || '',
    Number(headerOf(frame, 'sum') || 1),
    Number(headerOf(frame, 'seq') || 0),
    frame.payload ?? new Uint8Array(),
  );
  if (!merged) return;
  // 先回包：飞书要求 3 秒内处理完，下载慢的放到后面按顺序做
  send(link, {
    ...frame,
    headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
    payload: new TextEncoder().encode(JSON.stringify({ code: 200 })),
  });
  const event = receiveEvent.safeParse(JSON.parse(Buffer.from(merged).toString('utf8')));
  if (!event.success) return;
  const { sender, message } = event.data.event;
  const senderId = sender.sender_id.open_id;
  const created = Number(message.create_time);
  link.received({
    parts: messageParts(message),
    senderId,
    senderName: senderId,
    conversation: message.chat_type === 'group' ? '群聊 ' + message.chat_id : '',
    receivedAt: new Date(Number.isFinite(created) && created > 0 ? created : Date.now()).toISOString(),
    replyTo: { messageId: message.message_id },
  });
}

export function feishuProtocol(deps: ProtocolDeps = {}): BotProtocol<FeishuMedia, FeishuReply> {
  let serviceId = 0,
    pingMs = DEFAULT_PING_MS;
  const fragments = new FragmentCache();
  const tokens = tenantTokens(deps);
  return {
    channel: 'feishu_bot',
    name: '飞书',
    async connectUrl(credentials) {
      const endpoint = await endpointOf(credentials, deps);
      serviceId = endpoint.serviceId;
      pingMs = endpoint.pingMs;
      return endpoint.url;
    },
    // 换地址时已经认过凭据，连上就算接通
    onOpen: (link) => link.authOk(),
    heartbeatMs: () => pingMs,
    ping(link) {
      send(link, { SeqID: 0n, LogID: 0n, service: serviceId, method: FRAME_CONTROL, headers: [{ key: 'type', value: 'ping' }] });
    },
    onFrame(data, link) {
      const frame = decodeFrame(data),
        type = headerOf(frame, 'type');
      if (frame.method === FRAME_CONTROL) {
        if (type === 'pong') link.pong();
      } else if (frame.method === FRAME_DATA && type === 'event') onEvent(frame, link, fragments);
    },
    async fetch(media, credentials) {
      if (!media.messageId || !media.key) throw new NoRetry('消息里没有下载信息');
      const token = await tokens.get(credentials);
      const url =
        FEISHU_API + '/open-apis/im/v1/messages/' + encodeURIComponent(media.messageId) +
        '/resources/' + encodeURIComponent(media.key) + '?type=' + media.type;
      const file = await downloadMedia(url, deps, { headers: { Authorization: 'Bearer ' + token } });
      return { bytes: file.data, name: media.name || file.name };
    },
    async reply(replyTo, text, credentials) {
      const token = await tokens.get(credentials);
      await postJson(
        FEISHU_API + '/open-apis/im/v1/messages/' + encodeURIComponent(replyTo.messageId) + '/reply',
        { msg_type: 'text', content: JSON.stringify({ text }) },
        deps,
        { Authorization: 'Bearer ' + token },
      );
    },
  };
}
