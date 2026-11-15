/**
 * 三家机器人共用的约定：连接（connection.ts）只管生命周期，每家（wecom.ts 等）按这里的接口
 * 说清怎么拿连接地址和认证、怎么解析帧、怎么下载、怎么回复。
 */
import { z } from 'zod';
import type { BotChannel, InboxKind } from '../../../shared/import/index.js';

/** 应用编号（企业微信 Bot ID、飞书 App ID、钉钉 Client ID）和 Secret。 */
export type BotCredentials = { appId: string; secret: string };

/** 每家协议对外请求用的两样，只在测试和预览里换成本机替身。 */
export type ProtocolDeps = {
  /** 换掉以后连接请求和下载都走它；生产不传，下载走固定 IP 的 HTTPS（media.ts）。 */
  fetchImpl?: typeof fetch;
  /** 下载前核对域名解析到的公网地址；默认 resolvePublicAddress。 */
  checkHost?: (hostname: string) => Promise<string>;
};

/** 下载和公网 DNS 连的 HTTPS 端口 */
export const HTTPS_PORT = 443;
/** 没有文件名时拿消息编号的尾巴拼一个（图片-xxxxxxxx.jpg、视频-xxxxxxxx.mp4），取几位 */
export const ID_TAIL = 8;

/*
 * 三家发来的消息是外来数据，进来先用 zod 认一遍，不用断言。各家官方格式里这些栏目都是文字，
 * 偶尔是数字（钉钉的会话类型）；没写、类型不对的按没写算，和以前按 String(x || '') 读一样，不因为一栏不对丢掉整条消息。
 */
/** 外来消息里的一段文字：文字照用，数字转成文字，其余（没写、对象……）按空串 */
export const looseText = z.union([z.string(), z.number()]).transform(String).catch('');
/** 外来消息里的一串：不是数组按空的；里面认不出的项跳过（以前读到不是对象的项也是什么都不取） */
export const looseList = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    );
/** 一段 JSON 文字：解析不了按 undefined（交给后面的结构认成“不对”） */
export function jsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 一条消息拆出来的一条：图文混排拆成几条，每个文件都能单独转单。M 是本家下载要的信息。 */
export type BotPart<M> = {
  externalId: string;
  kind: InboxKind;
  text?: string;
  /** 有文件要下载：原样交回本家的 fetch。 */
  media?: M;
};

/** 收到的一条消息。replyTo（R）原样交回本家的 reply。 */
export type BotMessage<M, R> = {
  parts: BotPart<M>[];
  senderId: string;
  senderName: string;
  conversation: string;
  receivedAt: string;
  replyTo: R;
};

/** 连接交给本家用的手柄；连接换代以后，旧手柄上的调用都不起作用。 */
export type BotLink<M, R> = {
  /** 发一帧；连接已换代或没打开时不发，返回 false。 */
  send(data: string | Uint8Array): boolean;
  /** 发 WebSocket 自带的 ping（对方回 pong 也算心跳有回应）。 */
  wsPing(): void;
  authOk(): void;
  authFailed(message: string): void;
  pong(): void;
  kicked(message: string): void;
  received(message: BotMessage<M, R>): void;
  /** 对方要求断开（钉钉 disconnect）：关掉这条，按退避重连。 */
  reconnect(reason: string): void;
};

/**
 * 给人看的失败原因（简体中文）：显示在设置页、回给发消息的人、写进收件箱。
 * 不是它的错误（网络层、程序出错的英文原文）只进服务器日志，对外换成一句中文。
 */
export class BotFailure extends Error {}
/** 凭据被对方拒绝（或解不开）：不再重连，等人改了凭据再连。 */
export class BotAuthError extends BotFailure {}

/** 一家的协议。M 是这家下载文件要的信息，R 是回复要的信息（都由这家自己拆消息时填）。 */
export type BotProtocol<M = unknown, R = unknown> = {
  channel: BotChannel;
  /** 平台名，拼进给人看的状态和出错文字：企业微信、飞书、钉钉。 */
  name: string;
  /** 连接地址。企业微信是固定的，飞书、钉钉要先用凭据换；凭据被拒抛 BotAuthError。 */
  connectUrl(credentials: BotCredentials): string | Promise<string>;
  /** 连上以后：企业微信发订阅帧、等回应；不用等的直接 link.authOk()。 */
  onOpen(link: BotLink<M, R>, credentials: BotCredentials): void;
  /** 心跳间隔（毫秒），接通时读一次。 */
  heartbeatMs(): number;
  ping(link: BotLink<M, R>): void;
  onFrame(data: Buffer, link: BotLink<M, R>): void;
  /** 下载一个文件（企业微信已解密）；文件名不知道就给空串。 */
  fetch(media: M, credentials: BotCredentials): Promise<{ bytes: Uint8Array; name: string }>;
  /** 回一句话；发不出去不报错，消息已经进了收件箱。 */
  reply(replyTo: R, text: string, credentials: BotCredentials): void | Promise<void>;
};
