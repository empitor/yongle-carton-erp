import type { DatabaseSync } from 'node:sqlite';
import { AppError, one, parseStoredJson, rows } from '../core/index.js';
import { DEEPSEEK_LIMITS } from '../../shared/ai/index.js';
import { z } from 'zod';
import { field } from './chat/result-fields.js';

/** ASCII 以内的字符按 1 个计费字符算 */
const ASCII_END = 0x80;
const spokenMessage = rows.assistant_messages.pick({ seq: true, role: true, text: true, document: true });
/** 消息 document 里另一位助手补的话（message-document.ts 的 relay）；不是文字的段落跳过 */
const relayDocument = z.looseObject({ relay: z.array(z.unknown()).optional() });

/**
 * “读出来”要读的文字：按消息编号从库里取，不接受浏览器传来的任意文字。
 * 只读当前账号自己会话里助手的回复（含另一位助手补的话），太长的按 DeepSeek 朗读上限截到句末。
 * 只读库，不写；按主键取一条。
 */
export function messageForSpeech(db: DatabaseSync, threadId: string, messageId: string, userId: string): string {
  const row = one(
    db,
    spokenMessage,
    'SELECT m.seq,m.role,m.text,m.document FROM assistant_messages m JOIN assistant_threads t ON t.id=m.thread_id WHERE m.id=? AND m.thread_id=? AND t.user_id=?',
    messageId,
    threadId,
    userId,
  );
  if (!row) throw new AppError('没有找到这条回复，可能已被清空。', 404, 'not_found');
  if (row.role !== 'assistant') throw new AppError('只能朗读助手的回复。', 400, 'validation');
  // 另一位助手补充的话（消息 document 里的 relay）
  const { relay = [] } = parseStoredJson(relayDocument, row.document, `assistant_messages.document（第 ${row.seq} 行）`);
  const relayTexts = relay.flatMap((part) => {
    const said = field(part, 'text');
    return typeof said === 'string' ? [said] : [];
  });
  const text = [row.text, ...relayTexts].map((t) => t.trim()).filter(Boolean).join('\n');
  if (!text) throw new AppError('这条回复没有可以朗读的文字。', 422, 'validation');
  return clipForSpeech(text);
}

/** 计费字符：DeepSeek 按汉字算 2 个；拿不准的非 ASCII 字符也按 2 个算，只会少读不会超（代理对的前半个也不在 ASCII 以内）。 */
const billingChars = (ch: string) => (ch.charCodeAt(0) < ASCII_END ? 1 : 2);
const sentenceEnd = /[。！？；.!?;\n]/;

/** 超过朗读上限的截到上限以内最后一个句末；整段没有句末就硬截。 */
export function clipForSpeech(text: string, limit: number = DEEPSEEK_LIMITS.ttsBillingChars): string {
  let used = 0,
    cut = -1,
    lastEnd = -1;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    used += billingChars(chars[i]);
    if (used > limit) {
      cut = i;
      break;
    }
    if (sentenceEnd.test(chars[i])) lastEnd = i + 1;
  }
  if (cut < 0) return text;
  return chars
    .slice(0, lastEnd > 0 ? lastEnd : cut)
    .join('')
    .trim();
}
