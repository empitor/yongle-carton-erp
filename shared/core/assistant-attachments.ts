import { MIB } from './measures.js';

/** 助手附件的大小上限（MB）：单个文件、一条消息合计、每个账号合计、全部合计（提示里的数字也从这里拼） */
export const attachmentLimitMb = { file: 10, message: 30, user: 200, total: 1024 };
export const attachmentLimits = {
  fileBytes: attachmentLimitMb.file * MIB,
  messageBytes: attachmentLimitMb.message * MIB,
  messageCount: 6,
  userBytes: attachmentLimitMb.user * MIB,
  totalBytes: attachmentLimitMb.total * MIB,
  pendingCount: 6,
};
/** 单份附件太大或是空的：服务端拒收、页面选文件时都说这一句 */
export const attachmentSizeMessage = '每份附件须大于0且不超过' + attachmentLimitMb.file + 'MB。';
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
