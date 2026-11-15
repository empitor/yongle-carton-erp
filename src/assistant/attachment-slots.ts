import { KIB, MIB } from '../../shared/core/index';
import type { ChatAttachment } from './assistant-types';

/* 聊天附件的格子数据和几样小函数：上传 hook、附件卡片、预览、确认窗都从这里取，组件之间不互相引。 */

/** 聊天附件传到 DeepSeek 的那份留多久、什么时候删：输入框上方的说明、附件预览、删附件和清空、删除会话的确认窗都用这一句 */
export const remoteCopyNote = '传到 DeepSeek 的那份最多留 7 天；你删掉附件、清空或删除会话时一起删。';

export const attachmentUrl = (a: ChatAttachment, download = false) =>
  '/api/assistant/attachments/' +
  encodeURIComponent(a.id) +
  '/file' +
  (download ? '?download=1' : '');
export const fileSize = (n: number) =>
  n < KIB
    ? `${n} B`
    : n < MIB
      ? `${(n / KIB).toFixed(1)} KB`
      : `${(n / MIB).toFixed(1)} MB`;
export type AttachmentSlot = {
  key: string;
  file?: File;
  meta?: ChatAttachment;
  name: string;
  size: number;
  status: 'queued' | 'uploading' | 'ready' | 'failed';
  error?: string;
};
export const attachmentSlots = (files: ChatAttachment[]): AttachmentSlot[] =>
  files.map((a) => ({ key: a.id, meta: a, name: a.name, size: a.size, status: 'ready' }));

/** 附件卡片上大小后面那句：删了、在传、等着传、没传成，或者传好了以什么方式交给模型 */
export function slotStatusText(s: AttachmentSlot) {
  if (s.meta?.deleted) return '已删除';
  if (s.status === 'uploading') return '上传中…';
  if (s.status === 'queued') return '等待上传';
  if (s.status === 'failed') return '上传失败';
  return s.meta?.transfer === 'text' ? '发送UTF-8原文' : '原文件已保存';
}
