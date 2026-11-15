/**
 * 钉钉企业内部应用机器人的 Stream 模式：用 Client ID、Client Secret 换 endpoint 和一次性 ticket 再连，
 * JSON 帧；机器人消息先回包再处理，系统 ping 原样带回 opaque，disconnect 后重新换 ticket 连；
 * 文件用下载码换临时地址再下载，回复走消息里带的会话地址。
 * 协议：https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/
 */
import { z } from 'zod';
import { NoRetry, downloadMedia } from './media.js';
import { TOKEN_DEFAULT_SECONDS, TokenCache, postJson } from './http.js';
import {
  BotAuthError,
  BotFailure,
  ID_TAIL,
  looseList,
  looseText,
  type BotCredentials,
  type BotLink,
  type BotPart,
  type BotProtocol,
  type ProtocolDeps,
} from './protocol.js';

const DINGTALK_API = 'https://api.dingtalk.com';
const BOT_TOPIC = '/v1.0/im/bot/messages/get';
/** 官方没写心跳间隔；按官方 Python SDK 的 keepalive，每 60 秒发一次 WebSocket ping。 */
const HEARTBEAT_MS = 60_000;
/** 换 ticket 时只有这几个状态码明确是凭据或配置的错；429、5xx 和别的都按暂时连不上退避重试。 */
const rejectedStatus = (status: number) => status === 400 || status === 401 || status === 403;

type DingtalkMedia = { downloadCode: string; robotCode?: string; name?: string };
type DingtalkReply = { webhook: string; expiresAt: unknown };
type DingtalkPart = BotPart<DingtalkMedia>;
type DingtalkLink = BotLink<DingtalkMedia, DingtalkReply>;

/*
 * 钉钉发来的内容（外来数据）的结构。各栏缺了或类型不对按没写算（looseText、looseList），和以前一样不丢整条消息。
 */
const richItem = z.object({ text: z.string().optional().catch(undefined), downloadCode: looseText });
const messageContent = z
  .object({
    downloadCode: looseText,
    fileName: z.string().optional().catch(undefined),
    videoType: looseText,
    recognition: looseText,
    richText: looseList(richItem),
  })
  .catch({ downloadCode: '', fileName: undefined, videoType: '', recognition: '', richText: [] });
const dingtalkMessage = z.object({
  msgId: looseText,
  msgtype: looseText,
  content: messageContent,
  text: z.object({ content: looseText }).catch({ content: '' }),
  robotCode: z.string().optional().catch(undefined),
  senderStaffId: looseText,
  senderId: looseText,
  senderNick: looseText,
  conversationType: looseText,
  conversationTitle: looseText,
  conversationId: looseText,
  createAt: z.unknown().optional(),
  sessionWebhook: looseText,
  sessionWebhookExpiredTime: z.unknown().optional(),
});
type DingtalkMessage = z.infer<typeof dingtalkMessage>;
/** Stream 的一帧：headers 和 data 回包时原样带回，所以不细认 */
const streamFrame = z.object({
  type: looseText,
  headers: z.record(z.string(), z.unknown()).catch({}),
  data: z.unknown().optional(),
});
const tokenReply = z.object({ accessToken: z.string().min(1), expireIn: z.unknown().optional() });
const connectionReply = z.object({ endpoint: looseText, ticket: looseText }).catch({ endpoint: '', ticket: '' });
const downloadReply = z.object({ downloadUrl: z.string().min(1) });

/** 富文本：文字拼成一条，每张图各一条 */
function richTextParts(id: string, message: DingtalkMessage, media: (code: string) => DingtalkMedia): DingtalkPart[] {
  const items = message.content.richText;
  const text = items.map((i) => i.text ?? '').join('').trim();
  const parts: Omit<DingtalkPart, 'externalId'>[] = [
    ...(text ? [{ kind: 'text' as const, text }] : []),
    ...items.filter((i) => i.downloadCode).map((i) => ({ kind: 'image' as const, media: media(i.downloadCode) })),
  ];
  return parts.map((part, i) => ({ ...part, externalId: id + '#' + i }));
}

function messageParts(message: DingtalkMessage): DingtalkPart[] {
  const id = message.msgId,
    type = message.msgtype,
    content = message.content;
  if (!id) return [];
  const media = (code: string, name?: string): DingtalkMedia => ({ downloadCode: code, robotCode: message.robotCode, name });
  switch (type) {
    case 'text':
      return [{ externalId: id, kind: 'text', text: message.text.content.trim() }];
    case 'picture':
      return [{ externalId: id, kind: 'image', media: media(content.downloadCode) }];
    case 'file':
      return [{ externalId: id, kind: 'file', media: media(content.downloadCode, content.fileName) }];
    case 'video': {
      const name = '视频-' + id.slice(-ID_TAIL) + (content.videoType ? '.' + content.videoType : '');
      return [{ externalId: id, kind: 'video', media: media(content.downloadCode, name) }];
    }
    case 'audio':
      // 钉钉给了转写文字，就存文字
      return [{ externalId: id, kind: 'voice', text: content.recognition }];
    case 'richText':
      return richTextParts(id, message, media);
    default:
      return [{ externalId: id, kind: 'other', text: '收到一条暂不支持的消息（类型：' + (type || '未知') + '）' }];
  }
}

/** 钉钉的一条机器人消息拆成几条；不是消息的拆不出来 */
export function dingtalkMessageParts(raw: unknown): DingtalkPart[] {
  const message = dingtalkMessage.safeParse(raw);
  return message.success ? messageParts(message.data) : [];
}

/** 回复只发到钉钉自己的 https 地址，过期了就不发。 */
function replyTarget(webhook: string, expiresAt: unknown) {
  if (!URL.canParse(webhook)) return null;
  const target = new URL(webhook);
  const own = target.hostname === 'dingtalk.com' || target.hostname.endsWith('.dingtalk.com');
  if (target.protocol !== 'https:' || !own) return null;
  if (Number(expiresAt) && Date.now() > Number(expiresAt)) return null;
  return target.toString();
}

const send = (link: DingtalkLink, frame: unknown) => link.send(JSON.stringify(frame));

/** 机器人消息：先回包，再交给连接 */
function onCallback(frame: z.infer<typeof streamFrame>, link: DingtalkLink) {
  send(link, {
    code: 200,
    headers: { contentType: 'application/json', messageId: frame.headers.messageId },
    message: 'OK',
    data: JSON.stringify({ response: null }),
  });
  const parsed = dingtalkMessage.safeParse(JSON.parse(looseText.parse(frame.data) || '{}'));
  if (!parsed.success) return;
  const message = parsed.data;
  const senderId = message.senderStaffId || message.senderId;
  const created = Number(message.createAt);
  link.received({
    parts: messageParts(message),
    senderId,
    senderName: message.senderNick || senderId,
    conversation: message.conversationType === '2' ? '群聊 ' + (message.conversationTitle || message.conversationId) : '',
    receivedAt: new Date(Number.isFinite(created) && created > 0 ? created : Date.now()).toISOString(),
    replyTo: { webhook: message.sessionWebhook, expiresAt: message.sessionWebhookExpiredTime },
  });
}

function onFrame(data: Buffer, link: DingtalkLink) {
  const parsed = streamFrame.safeParse(JSON.parse(data.toString('utf8')));
  if (!parsed.success) return;
  const frame = parsed.data,
    topic = frame.headers.topic;
  if (frame.type === 'SYSTEM') {
    if (topic === 'ping') {
      send(link, { code: 200, headers: frame.headers, message: 'OK', data: frame.data });
      link.pong();
    } else if (topic === 'disconnect') {
      send(link, { code: 200, headers: frame.headers, message: 'OK', data: frame.data });
      link.reconnect('钉钉要求重新连接，正在重连');
    }
    return;
  }
  if (frame.type === 'CALLBACK' && topic === BOT_TOPIC) onCallback(frame, link);
}

/** 用凭据换 endpoint 和 ticket；被拒抛 BotAuthError，别的都按暂时连不上 */
async function openConnection(credentials: BotCredentials, deps: ProtocolDeps) {
  const { status, data } = await postJson(
    DINGTALK_API + '/v1.0/gateway/connections/open',
    {
      clientId: credentials.appId,
      clientSecret: credentials.secret,
      subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
    },
    deps,
  );
  // 对方的 code 是英文（InvalidAuthentication 之类），不给人看，只留 HTTP 状态码
  if (rejectedStatus(status)) throw new BotAuthError('钉钉拒绝连接（错误码 ' + status + '）：请检查 Client ID 和 Client Secret。');
  const { endpoint, ticket } = connectionReply.parse(data);
  if (status !== 200 || !ticket || !endpoint.startsWith('wss://')) throw new BotFailure('钉钉暂时连不上（错误码 ' + status + '），正在重试');
  return endpoint + '?ticket=' + encodeURIComponent(ticket);
}

function accessTokens(deps: ProtocolDeps) {
  return new TokenCache(async (credentials) => {
    const { status, data } = await postJson(DINGTALK_API + '/v1.0/oauth2/accessToken', {
      appKey: credentials.appId,
      appSecret: credentials.secret,
    }, deps);
    const reply = tokenReply.safeParse(data);
    if (status !== 200 || !reply.success) throw new BotFailure('钉钉没有给访问令牌（错误码 ' + status + '）');
    return { token: reply.data.accessToken, expiresInSeconds: Number(reply.data.expireIn) || TOKEN_DEFAULT_SECONDS };
  });
}

export function dingtalkProtocol(deps: ProtocolDeps = {}): BotProtocol<DingtalkMedia, DingtalkReply> {
  const tokens = accessTokens(deps);
  return {
    channel: 'dingtalk_bot',
    name: '钉钉',
    connectUrl: (credentials) => openConnection(credentials, deps),
    // 换 ticket 时已经认过凭据，连上就算接通
    onOpen: (link) => link.authOk(),
    heartbeatMs: () => HEARTBEAT_MS,
    ping: (link) => link.wsPing(),
    onFrame,
    async fetch(media, credentials) {
      if (!media.downloadCode) throw new NoRetry('消息里没有下载信息');
      const token = await tokens.get(credentials);
      const { status, data } = await postJson(
        DINGTALK_API + '/v1.0/robot/messageFiles/download',
        { downloadCode: media.downloadCode, robotCode: media.robotCode || credentials.appId },
        deps,
        { 'x-acs-dingtalk-access-token': token },
      );
      const reply = downloadReply.safeParse(data);
      if (status !== 200 || !reply.success) throw new BotFailure('钉钉没有给下载地址（错误码 ' + status + '）');
      const file = await downloadMedia(reply.data.downloadUrl, deps);
      return { bytes: file.data, name: media.name || file.name };
    },
    async reply(replyTo, text) {
      const target = replyTarget(replyTo.webhook, replyTo.expiresAt);
      if (target) await postJson(target, { msgtype: 'text', text: { content: text } }, deps);
    },
  };
}
