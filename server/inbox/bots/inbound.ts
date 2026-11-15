/**
 * 机器人收到的一条消息放进收件箱：已经有的跳过，文字直接存，文件下载后存原文件；
 * 失败的留一条记录说明原因，不让消息悄悄丢失。最后给出要回给对方的一句话。
 * 消息内容只算数据，这里不调用模型，也不执行任何业务操作。
 */
import { failureMessage, isConstraintError } from '../../core/index.js';
import { errorMessage } from '../../../shared/core/index.js';
import { INBOX_MAX_FILE_TEXT, type InboxChannel, type InboxIncoming } from '../../../shared/import/index.js';
import { FileTooLarge, NoRetry, imageExtension, mimeOf, safeFileName } from './media.js';
import { BotFailure, ID_TAIL, type BotMessage } from './protocol.js';

/** 下载失败重试前等多久：先等 1 秒，再等 3 秒，之后放弃 */
const FIRST_RETRY_MS = 1000;
const SECOND_RETRY_MS = 3000;
const DOWNLOAD_RETRY_MS = [FIRST_RETRY_MS, SECOND_RETRY_MS];
const RECEIVED_REPLY = '已收到，已放进收件箱。';

export type InboundDeps<M> = {
  channel: InboxChannel;
  /** 平台名，拼进日志：企业微信、飞书、钉钉。 */
  name: string;
  ingest: (incoming: InboxIncoming) => unknown;
  exists: (channel: InboxChannel, externalId: string) => boolean;
  fetch: (media: M) => Promise<{ bytes: Uint8Array; name: string }>;
  sleep: (ms: number) => Promise<void>;
  /** 出错文字里去掉 Secret。 */
  redact: (text: string) => string;
};

async function fetchWithRetry<M>(media: M, deps: InboundDeps<M>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.fetch(media);
    } catch (e) {
      if (e instanceof NoRetry || attempt >= DOWNLOAD_RETRY_MS.length) throw e;
      await deps.sleep(DOWNLOAD_RETRY_MS[attempt]);
    }
  }
}

/**
 * 给人看的失败原因（回给发消息的人、写进收件箱）：文件太大；数据库约束拦下的用全站那一句（顺带记 [数据规则] 日志）；
 * 我们自己写的中文原因（BotFailure）原样给；别的（程序出错的英文原文）只进服务器日志，对外说一句中文。
 */
function reasonOf<M>(e: unknown, isFile: boolean, deps: InboundDeps<M>) {
  if (e instanceof FileTooLarge) return '文件超过 ' + INBOX_MAX_FILE_TEXT + '，没有保存';
  const where = deps.name + '消息入库';
  if (isConstraintError(e)) return failureMessage(e, where, '');
  if (!(e instanceof BotFailure))
    console.error('[机器人] ' + where + '出错：', deps.redact(e instanceof Error ? e.message : String(e)));
  const detail = e instanceof BotFailure ? deps.redact(e.message) : '处理时出错，详情在服务器日志里';
  return isFile ? '文件没有保存（' + detail + '），请让对方重新发送' : '消息没有保存（' + detail + '）';
}

/** 存好一条消息，返回存了几条和要回的话（全是重复的就不回，reply 为 null）。 */
export async function storeMessage<M>(message: Omit<BotMessage<M, unknown>, 'replyTo'>, deps: InboundDeps<M>) {
  const problems: string[] = [];
  let saved = 0;
  for (const part of message.parts) {
    if (deps.exists(deps.channel, part.externalId)) continue;
    const base = {
      channel: deps.channel,
      externalId: part.externalId,
      senderId: message.senderId,
      senderName: message.senderName,
      conversation: message.conversation,
      kind: part.kind,
      receivedAt: message.receivedAt,
    };
    try {
      if (part.media === undefined) {
        deps.ingest({ ...base, text: part.text ?? '' });
      } else {
        const file = await fetchWithRetry(part.media, deps);
        const fallback =
          part.kind === 'image'
            ? '图片-' + part.externalId.slice(-ID_TAIL) + '.' + imageExtension(file.bytes)
            : '文件-' + part.externalId.slice(-ID_TAIL);
        const name = safeFileName(file.name, fallback);
        deps.ingest({ ...base, file: { name, mime: mimeOf(name), bytes: new Uint8Array(file.bytes) } });
      }
      saved++;
    } catch (e) {
      const reason = reasonOf(e, part.media !== undefined, deps);
      problems.push(reason);
      // 留一条记录，不让消息悄悄丢失。
      try {
        if (part.media !== undefined) deps.ingest({ ...base, text: reason });
      } catch (recordError) {
        // 原因已经回给对方；连失败记录也存不进去（库出问题），记日志让维护的人知道
        console.error('[机器人] ' + deps.name + '消息的失败记录没有存上：', deps.redact(errorMessage(recordError)));
      }
    }
  }
  const reply = saved || problems.length ? (problems.length ? problems.join('；') : RECEIVED_REPLY) : null;
  return { saved, reply };
}
