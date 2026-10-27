import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { ImportError } from './errors.js';
import type { ParsedFile } from '../../shared/order-draft.js';
export function detectFormat(bytes: Buffer, name: string): ParsedFile['format'] {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new ImportError('文件必须大于0且不超过10MB。', 413, 'file-size');
  const ext = extname(name).toLowerCase(),
    magic = bytes.subarray(0, 8).toString('hex');
  if (['.xlsx', '.docx'].includes(ext) && magic.startsWith('504b0304'))
    return ext.slice(1) as 'xlsx' | 'docx';
  if (['.xls', '.doc'].includes(ext) && magic === 'd0cf11e0a1b11ae1')
    return ext.slice(1) as 'xls' | 'doc';
  if (ext === '.pdf' && bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (ext === '.png' && magic === '89504e470d0a1a0a') return 'png';
  if (['.jpg', '.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'jpg';
  throw new ImportError(
    '文件头与扩展名不符或格式不支持。支持XLS、XLSX、DOC、DOCX、PDF、JPG、JPEG、PNG。',
    415,
    'file-type',
  );
}
export async function storeOriginal(
  bytes: Buffer,
  name: string,
  _id: string,
  directory: string,
): Promise<ParsedFile> {
  const format = detectFormat(bytes, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'original'), bytes, { flag: 'wx' });
  // 保留兼容的元数据形状，不读取正文、不解压、不OCR、不生成解析预览。
  return { format, blocks: [], previews: [], warnings: [], imagePages: [] };
}
