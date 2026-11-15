import { extname } from 'node:path';

/** 发给 DeepSeek 的文件：按扩展名认格式（DeepSeek 也按它判断），文件名只留安全字符。 */
const mimes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};
const images = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'];
/** 按数据上传（user_data）的表格和纯文本 */
const tables = ['.xls', '.xlsx', '.txt', '.md', '.csv', '.json'];

export const extensionOf = (name: string) => extname(name).toLowerCase();
export const knownFile = (name: string) => !!mimes[extensionOf(name)];
export const isImage = (name: string) => images.includes(extensionOf(name));
export const isTable = (name: string) => tables.includes(extensionOf(name));

/** 文件名主干最多留多少字 */
const NAME_MAX_CHARS = 120;
/** 文件名只留安全字符，扩展名保留。 */
export function safeName(name: string) {
  const ext = extensionOf(name);
  const base = name.slice(0, name.length - ext.length).replace(/[\x00-\x1f/\\"]/g, '_').slice(0, NAME_MAX_CHARS) || 'file';
  return base + ext;
}
/** 放进 multipart 表单的文件。 */
export const fileBlob = (name: string, data: Buffer) =>
  new Blob([new Uint8Array(data)], { type: mimes[extensionOf(name)] || 'application/octet-stream' });
