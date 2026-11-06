/**
 * 企业微信智能机器人长连接：只把收到的消息放进收件箱。
 * 消息内容只算数据，这里不调用模型，也不执行任何业务操作。
 */
import { createDecipheriv, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
// Node 自带的 WebSocket 连企业微信会被返回 404（2026-11 实测），官方 SDK 也用 ws。
import NodeWebSocket from 'ws';
import { isPublicIPv4, resolvePublicAddress } from '../ai/endpoint.js';
import type { InboxIncoming, InboxKind, WecomBotState, WecomBotStatus } from '../../shared/inbox.js';

export const WECOM_BOT_URL = 'wss://openws.work.weixin.qq.com';
const CHANNEL = 'wecom_bot' as const;
export const WECOM_MAX_FILE = 20 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const MAX_MISSED_PONGS = 2;
const AUTH_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_RETRY_MS = [1000, 3000];

/** AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 按 32 字节补齐（Node 默认按 16，要手动去）。 */
export function decryptWecomMedia(data: Uint8Array, aesKey: string) {
  const key = Buffer.from(aesKey, 'base64');
  if (key.length !== 32) throw new Error('解密密钥长度不对');
  if (!data.length || data.length % 16) throw new Error('密文长度不对');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('解密结果不对');
  for (let i = plain.length - pad; i < plain.length; i++)
    if (plain[i] !== pad) throw new Error('解密结果不对');
  return plain.subarray(0, plain.length - pad);
}

export function fileNameFromDisposition(header: string | null) {
  if (!header) return '';
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(header)?.[1];
  const plain = encoded || /filename="?([^";]+)"?/i.exec(header)?.[1];
  if (!plain) return '';
  try {
    return decodeURIComponent(plain.trim());
  } catch {
    return plain.trim();
  }
}

export function safeFileName(name: string, fallback: string) {
  const clean = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return (clean || fallback).slice(-200);
}

const mimeByExtension: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
};
function imageExtension(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  return 'jpg';
}
function mimeOf(name: string) {
  return mimeByExtension[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
}

class FileTooLarge extends Error {}

type MediaDeps = {
  fetchImpl: typeof fetch;
  checkHost: (hostname: string) => Promise<unknown>;
};
/** 地址来自企业微信下发，仍只接受 https 和公网地址；跳转的每一跳都检查。 */
async function downloadMedia(url: string, deps: MediaDeps) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const target = new URL(current);
    if (target.protocol !== 'https:') throw new Error('下载地址不是 https');
    if (isIP(target.hostname)) {
      if (!isPublicIPv4(target.hostname)) throw new Error('下载地址不是公网地址');
    } else await deps.checkHost(target.hostname);
    const response = await deps.fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) throw new Error('下载地址跳转无效');
      current = new URL(next, current).toString();
      continue;
    }
    if (!response.ok || !response.body) throw new Error('下载失败，状态 ' + response.status);
    // 密文最多比原文多 32 字节补齐。
    const limit = WECOM_MAX_FILE + 32;
    if (Number(response.headers.get('content-length') || 0) > limit) {
      await response.body.cancel().catch(() => {});
      throw new FileTooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new FileTooLarge();
      }
      chunks.push(value);
    }
    return {
      data: Buffer.concat(chunks),
      name: fileNameFromDisposition(response.headers.get('content-disposition')),
    };
  }
  throw new Error('下载地址跳转次数过多');
}

type MessagePart = {
  externalId: string;
  kind: InboxKind;
  text?: string;
  media?: { url?: string; aeskey?: string };
};
/** 图文混排拆成多条，每个文件都能单独转单。 */
export function wecomMessageParts(body: any): MessagePart[] {
  const msgid = String(body?.msgid || '');
  if (!msgid) return [];
  const one = (item: any, externalId: string): MessagePart => {
    switch (item?.msgtype) {
      case 'text':
        return { externalId, kind: 'text', text: String(item.text?.content ?? '') };
      case 'voice':
        return { externalId, kind: 'voice', text: String(item.voice?.content ?? '') };
      case 'image':
        return { externalId, kind: 'image', media: item.image };
      case 'file':
        return { externalId, kind: 'file', media: item.file };
      case 'video':
        return { externalId, kind: 'video', media: item.video };
      default:
        return {
          externalId,
          kind: 'other',
          text: '收到一条暂不支持的消息（类型：' + String(item?.msgtype || '未知') + '）',
        };
    }
  };
  if (body.msgtype === 'mixed') {
    const items = Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : [];
    return items.map((item: any, i: number) => one(item, msgid + '#' + i));
  }
  return [one(body, msgid)];
}

export type WecomBotCredentials = { botId: string; secret: string };
export type WecomBotOptions = {
  credentials: () => WecomBotCredentials | null;
  ingest: (incoming: InboxIncoming) => unknown;
  exists: (channel: typeof CHANNEL, externalId: string) => boolean;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  checkHost?: (hostname: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
};

export class WecomBotConnection {
  private socket: WebSocket | null = null;
  private generation = 0;
  private attempts = 0;
  private missedPongs = 0;
  private subscribeId = '';
  private secret = '';
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private current: WecomBotStatus = {
    state: 'off',
    lastError: '',
    connectedAt: null,
    lastMessageAt: null,
    received: 0,
  };
  constructor(private options: WecomBotOptions) {}
  status(): WecomBotStatus {
    return { ...this.current };
  }
  /** 重新读取凭据后连接；已有连接先断开。 */
  start() {
    this.teardown();
    let credentials: WecomBotCredentials | null = null;
    try {
      credentials = this.options.credentials();
    } catch (e) {
      this.setState('off', (e as Error).message);
      return;
    }
    if (!credentials) {
      this.setState('off', '');
      return;
    }
    this.attempts = 0;
    this.current.lastError = '';
    this.open(credentials);
  }
  stop() {
    this.teardown();
    this.setState('off', '');
  }
  /** 测试和关闭时等待已收到的消息处理完。 */
  idle() {
    return this.queue;
  }
  private setState(state: WecomBotState, error?: string) {
    this.current.state = state;
    if (error !== undefined) this.current.lastError = this.redact(error);
    if (state !== 'connected') this.current.connectedAt = null;
  }
  private redact(text: string) {
    return this.secret ? text.split(this.secret).join('***') : text;
  }
  private clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.heartbeat = this.authTimer = this.retryTimer = null;
  }
  private teardown() {
    this.generation++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {}
  }
  private open(credentials: WecomBotCredentials) {
    const generation = ++this.generation;
    this.secret = credentials.secret;
    this.setState('connecting');
    const Impl = this.options.WebSocketImpl || (NodeWebSocket as unknown as typeof WebSocket);
    let socket: WebSocket;
    try {
      socket = new Impl(this.options.url || WECOM_BOT_URL);
    } catch (e) {
      this.scheduleRetry(credentials, generation, (e as Error).message);
      return;
    }
    this.socket = socket;
    const live = () => generation === this.generation;
    socket.addEventListener('open', () => {
      if (!live()) return;
      this.subscribeId = 'aibot_subscribe_' + randomUUID();
      this.send({
        cmd: 'aibot_subscribe',
        headers: { req_id: this.subscribeId },
        body: { bot_id: credentials.botId, secret: credentials.secret },
      });
      this.authTimer = setTimeout(() => {
        if (live()) {
          this.current.lastError = '企业微信没有回应订阅请求';
          socket.close();
        }
      }, AUTH_TIMEOUT_MS);
    });
    socket.addEventListener('message', (event) => {
      if (live()) void this.onMessage(event.data, socket);
    });
    socket.addEventListener('error', () => {
      if (live()) this.current.lastError = '连接企业微信失败，正在重试';
    });
    socket.addEventListener('close', () => {
      if (!live()) return;
      this.clearTimers();
      this.socket = null;
      if (this.current.state === 'auth_failed' || this.current.state === 'kicked') return;
      this.scheduleRetry(credentials, generation, this.current.lastError || '连接已断开，正在重试');
    });
  }
  private scheduleRetry(credentials: WecomBotCredentials, generation: number, error: string) {
    if (generation !== this.generation) return;
    this.setState('retrying', error);
    const delay = Math.min(1000 * 2 ** this.attempts++, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      if (generation === this.generation) this.open(credentials);
    }, delay);
  }
  private send(frame: unknown) {
    const socket = this.socket;
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
  }
  private async onMessage(data: unknown, socket: WebSocket) {
    let frame: any;
    try {
      const text =
        typeof data === 'string'
          ? data
          : data instanceof Blob
            ? await data.text()
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      frame = JSON.parse(text);
    } catch {
      return;
    }
    const reqId = String(frame?.headers?.req_id || '');
    if (!frame?.cmd) {
      if (reqId === this.subscribeId && this.subscribeId) this.onSubscribed(frame, socket);
      else if (reqId.startsWith('ping_')) this.missedPongs = 0;
      return;
    }
    if (frame.cmd === 'aibot_msg_callback') {
      // 按收到的顺序逐条处理；下载慢也不影响心跳。
      this.queue = this.queue.then(() => this.onInbound(frame, socket)).catch(() => {});
      return;
    }
    if (frame.cmd === 'aibot_event_callback' && frame.body?.event?.eventtype === 'disconnected_event') {
      // 同一机器人只能有一条连接；不自动重连，否则两边会一直互相踢。
      this.setState('kicked', '这个机器人在别处建立了新连接，本机已断开。确认后可重新连接。');
      socket.close();
    }
  }
  private onSubscribed(frame: any, socket: WebSocket) {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    this.subscribeId = '';
    if (frame.errcode !== 0) {
      // 订阅有频率保护，凭据不对时不反复重试。
      this.setState(
        'auth_failed',
        frame.errcode === 853000
          ? 'Bot ID 或 Secret 不对（853000）。请到企业微信后台核对，并确认 API 模式是长连接。'
          : '企业微信拒绝连接（' + frame.errcode + '）：' + String(frame.errmsg || '请检查 Bot ID 和 Secret'),
      );
      socket.close();
      return;
    }
    this.attempts = 0;
    this.missedPongs = 0;
    this.setState('connected', '');
    this.current.connectedAt = new Date().toISOString();
    this.heartbeat = setInterval(() => {
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        this.current.lastError = '心跳没有回应，正在重连';
        socket.close();
        return;
      }
      this.missedPongs++;
      this.send({ cmd: 'ping', headers: { req_id: 'ping_' + randomUUID() } });
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
  }
  private async fetchMedia(media: { url?: string; aeskey?: string }) {
    if (!media.url || !media.aeskey) throw new Error('消息里没有下载信息');
    const deps: MediaDeps = {
      fetchImpl: this.options.fetchImpl || fetch,
      checkHost: this.options.checkHost || resolvePublicAddress,
    };
    const sleep = this.options.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        const file = await downloadMedia(media.url, deps);
        return { ...file, bytes: decryptWecomMedia(file.data, media.aeskey) };
      } catch (e) {
        if (e instanceof FileTooLarge || attempt >= DOWNLOAD_RETRY_MS.length) throw e;
        await sleep(DOWNLOAD_RETRY_MS[attempt]);
      }
    }
  }
  private async onInbound(frame: any, socket: WebSocket) {
    const body = frame.body || {},
      reqId = String(frame.headers?.req_id || ''),
      sender = String(body.from?.userid || ''),
      conversation = body.chattype === 'group' ? '群聊 ' + String(body.chatid || '') : '',
      receivedAt = new Date(
        typeof body.create_time === 'number' ? body.create_time * 1000 : Date.now(),
      ).toISOString();
    const problems: string[] = [];
    let saved = 0;
    for (const part of wecomMessageParts(body)) {
      if (this.options.exists(CHANNEL, part.externalId)) continue;
      const base = {
        channel: CHANNEL,
        externalId: part.externalId,
        senderId: sender,
        senderName: sender,
        conversation,
        kind: part.kind,
        receivedAt,
      };
      try {
        if (!part.media) {
          this.options.ingest({ ...base, text: part.text ?? '' });
        } else {
          const file = await this.fetchMedia(part.media);
          const fallback =
            part.kind === 'image'
              ? '图片-' + part.externalId.slice(-8) + '.' + imageExtension(file.bytes)
              : '文件-' + part.externalId.slice(-8);
          const name = safeFileName(file.name, fallback);
          this.options.ingest({
            ...base,
            file: { name, mime: mimeOf(name), bytes: new Uint8Array(file.bytes) },
          });
        }
        saved++;
      } catch (e) {
        const reason =
          e instanceof FileTooLarge
            ? '文件超过 20MB，没有保存'
            : part.media
              ? '文件没有保存（' + this.redact((e as Error).message) + '），请让对方重新发送'
              : '消息没有保存（' + this.redact((e as Error).message) + '）';
        problems.push(reason);
        // 留一条记录，不让消息悄悄丢失。
        try {
          if (part.media) this.options.ingest({ ...base, text: reason });
        } catch {}
      }
    }
    if (saved || problems.length) {
      this.current.received += saved;
      this.current.lastMessageAt = new Date().toISOString();
      this.reply(socket, reqId, problems.length ? problems.join('；') : '已收到，已放进收件箱。');
    }
  }
  private reply(socket: WebSocket, reqId: string, content: string) {
    if (!reqId || socket !== this.socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content } },
      }));
    } catch {}
  }
}
