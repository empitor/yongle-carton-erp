import { z } from 'zod';

/** 预览摘要的格式（sha256 十六进制）：先预览、再确认的写入，提交时带回预览给的摘要（服务端做法见 server/core/storage/preview-digest.ts） */
export const previewDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** 摘要对不上时服务端回的出错类别（409）：页面按它把窗口换成最新的预览 */
export const PREVIEW_CHANGED_CODE = 'preview-changed';
