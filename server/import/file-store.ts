/** 识别原件的格式检查（扩展名 + 文件头，≤10 MB）和落盘。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { AppError } from '../core/index.js';
import { MIB } from '../../shared/core/index.js';
import { ORIGINAL_MAX_MB, type ParsedFile } from '../../shared/import/index.js';

type Format = ParsedFile['format'];
/** 文件头看前几个字节 */
const HEAD_BYTES = 8;
const formatByExtension = new Map<string, Format>([
  ['.xlsx', 'xlsx'],
  ['.docx', 'docx'],
  ['.xls', 'xls'],
  ['.doc', 'doc'],
  ['.pdf', 'pdf'],
  ['.png', 'png'],
  ['.jpg', 'jpg'],
  ['.jpeg', 'jpg'],
]);
/** 各格式的文件头（十六进制）：新版 Office 是 zip，旧版是 OLE 复合文档 */
const ZIP_HEAD = '504b0304';
const OLE_HEAD = 'd0cf11e0a1b11ae1';
const PDF_HEAD = Buffer.from('%PDF-').toString('hex');
const headMatches: Record<Format, (head: string) => boolean> = {
  xlsx: (head) => head.startsWith(ZIP_HEAD),
  docx: (head) => head.startsWith(ZIP_HEAD),
  xls: (head) => head === OLE_HEAD,
  doc: (head) => head === OLE_HEAD,
  pdf: (head) => head.startsWith(PDF_HEAD),
  png: (head) => head === '89504e470d0a1a0a',
  jpg: (head) => head.startsWith('ffd8ff'),
};
export function detectFormat(bytes: Buffer, name: string): Format {
  if (!bytes.length || bytes.length > ORIGINAL_MAX_MB * MIB)
    throw new AppError('文件必须大于0且不超过10MB。', 413, 'file-size');
  const format = formatByExtension.get(extname(name).toLowerCase()),
    head = bytes.subarray(0, HEAD_BYTES).toString('hex');
  if (format && headMatches[format](head)) return format;
  throw new AppError(
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
  // 只存原件、记格式，不读文件内容
  return { format };
}
