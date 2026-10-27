import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sourceReferenceSchema, type ParsedFile } from '../../shared/order-draft.js';
import { ImportError } from './errors.js';

export function detectFormat(buffer: Buffer, name: string): ParsedFile['format'] {
  if (!buffer.length || buffer.length > 10 * 1024 * 1024)
    throw new ImportError('文件必须大于 0 且不超过 10 MB。', 413, 'file-size');
  const ext = extname(name).toLowerCase();
  if (['.xlsx', '.docx'].includes(ext) && buffer.subarray(0, 4).toString('hex') === '504b0304')
    return ext.slice(1) as 'xlsx' | 'docx';
  if (ext === '.doc' && buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'doc';
  if (ext === '.xls' && buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') return 'xls';
  if (ext === '.pdf' && buffer.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (ext === '.png' && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    if (buffer.length < 24 || buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 20000000)
      throw new ImportError('图片尺寸异常或超过 2000 万像素。');
    return 'png';
  }
  if (
    ['.jpg', '.jpeg'].includes(ext) &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return 'jpg';
  throw new ImportError(
    '文件内容与扩展名不符或格式不支持。仅接受 XLS、XLSX、DOC、DOCX、PDF、JPG、JPEG、PNG。',
    415,
    'file-type',
  );
}
const parsedSchema = z.strictObject({
  format: z.enum(['xls', 'xlsx', 'docx', 'doc', 'pdf', 'png', 'jpg']),
  blocks: z
    .array(
      z.strictObject({
        id: z.string().max(80),
        text: z.string().max(30000),
        ref: sourceReferenceSchema,
        method: z.enum([
          'xml',
          'xls-binary',
          'doc-binary',
          'pdf-text',
          'windows-ocr',
          'vision-required',
        ]),
      }),
    )
    .max(3000),
  previews: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        name: z.string().regex(/^preview-\d+\.png$/),
      }),
    )
    .max(10),
  warnings: z.array(z.string().max(2000)).max(500),
  imagePages: z.array(z.number().int().positive()).max(10),
});
export async function parseUpload(
  buffer: Buffer,
  name: string,
  id: string,
  directory: string,
): Promise<ParsedFile> {
  const format = detectFormat(buffer, name);
  await mkdir(directory, { recursive: true });
  const original = join(directory, 'original');
  await writeFile(original, buffer, { flag: 'wx' });
  const result = await new Promise<{ stdout: string; failed: boolean }>((resolve) => {
    execFile(
      process.execPath,
      [
        '--max-old-space-size=384',
        fileURLToPath(new URL('./parse-worker.mjs', import.meta.url)),
        original,
        format,
        id,
        directory,
      ],
      { windowsHide: true, timeout: 90000, maxBuffer: 3 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve({ stdout, failed: !!error }),
    );
  });
  let doc: any;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    throw new ImportError(
      '解析进程超时、文件损坏或资源超限，未生成工作区。请拆分或转换文件后重试。',
      422,
      'parse',
    );
  }
  if (!doc.ok)
    throw new ImportError(
      '文件解析失败：' + String(doc.message || '无法提取内容').slice(0, 250),
      422,
      'parse',
    );
  return parsedSchema.parse(doc.result);
}
