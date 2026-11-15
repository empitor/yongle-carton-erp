import { MIB } from './measures.js';

/** 助手附件的大小上限（MB）：单个文件、一条消息合计、每个账号合计、全部合计 */
const LIMIT_MB = { file: 10, message: 30, user: 200, total: 1024 };
export const attachmentLimits = {
  fileBytes: LIMIT_MB.file * MIB,
  messageBytes: LIMIT_MB.message * MIB,
  messageCount: 6,
  userBytes: LIMIT_MB.user * MIB,
  totalBytes: LIMIT_MB.total * MIB,
  pendingCount: 6,
};
export const attachmentAccept = '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt';
/** 助手附件的种类（assistant_attachments.kind）能存的全部值，和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const attachmentKinds = ['image', 'pdf', 'office', 'text'] as const;
/** 附件交给模型的方式：图片、上传成文件、文字内联 */
export const attachmentTransfers = ['image', 'file', 'text'] as const;
export type AssistantAttachment = {
  id: string;
  threadId: string;
  name: string;
  size: number;
  mime: string;
  kind: (typeof attachmentKinds)[number];
  sha256: string;
  createdAt: string;
  deleted: boolean;
  transfer: (typeof attachmentTransfers)[number];
  width?: number;
  height?: number;
};
