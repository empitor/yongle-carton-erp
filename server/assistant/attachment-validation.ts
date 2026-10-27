import { extname } from 'node:path';
import yauzl from 'yauzl';
import { loadImage } from '@napi-rs/canvas';
import { XMLParser } from 'fast-xml-parser';
import { ImportError } from '../import/errors.js';
import { attachmentLimits, type AssistantAttachment } from '../../shared/assistant-attachments.js';
const mime: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
};
const fail = (message: string): never => {
  throw new ImportError(message, 415);
};
export function attachmentText(bytes: Buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
      return fail('文本含二进制控制字符，不能作为TXT/CSV发送。');
    if (text.length > 200000) return fail('文本超过20万字符，请拆分后上传。');
    return text.replace(/^\uFEFF/, '');
  } catch (e) {
    if (e instanceof ImportError) throw e;
    return fail('TXT/CSV目前仅支持UTF-8，请另存为UTF-8后上传。');
  }
}
async function validateOffice(bytes: Buffer, ext: string) {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new ImportError('Office不是有效ZIP文档。', 415));
      let total = 0,
        count = 0,
        done = false;
      const names = new Set<string>();
      const macroDefaults = new Set<string>();
      const bad = (message: string) => {
        if (done) return;
        done = true;
        zip.close();
        reject(new ImportError(message, 415));
      };
      zip.on('error', () => bad('Office压缩容器损坏。'));
      zip.on('entry', (entry) => {
        const n = entry.fileName;
        if (++count > 2000 || names.has(n) || /(^\/|\\|(?:^|\/)\.\.(?:\/|$)|:)/.test(n))
          return bad('Office包含异常路径或过多条目。');
        names.add(n);
        total += entry.uncompressedSize;
        if (
          entry.generalPurposeBitFlag & 1 ||
          entry.uncompressedSize > 8 * 1024 * 1024 ||
          total > 40 * 1024 * 1024 ||
          entry.uncompressedSize > Math.max(1024 * 1024, entry.compressedSize * 150)
        )
          return bad('Office加密、展开过大或压缩比例异常。');
        if (/vbaProject|activeX|embeddings\//i.test(n))
          return bad('不接受宏、ActiveX或嵌入可执行对象。');
        if (n === '[Content_Types].xml')
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return bad('Office内容类型损坏。');
            let xml = '';
            stream.on('data', (b) => {
              xml += b.toString('utf8');
              if (xml.length > 200000) bad('Office类型信息过大。');
            });
            stream.on('error', () => bad('Office内容损坏。'));
            stream.on('end', () => {
              if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return bad('不接受宏或XML实体文档。');
              try {
                const types = new XMLParser({
                  ignoreAttributes: false,
                  processEntities: false,
                  removeNSPrefix: true,
                }).parse(xml)?.Types;
                if (!types || typeof types !== 'object') return bad('Office类型信息无效。');
                const list = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
                if (
                  list(types?.Override).some((v) =>
                    /macroEnabled|vbaProject/i.test(String(v['@_ContentType'])),
                  )
                )
                  return bad('不接受宏或XML实体文档。');
                for (const v of list(types?.Default))
                  if (/macroEnabled|vbaProject/i.test(String(v['@_ContentType'])))
                    macroDefaults.add(String(v['@_Extension']).toLowerCase());
              } catch {
                return bad('Office类型信息无效。');
              }
              if (!done) zip.readEntry();
            });
          });
        else zip.readEntry();
      });
      zip.on('end', () => {
        if (done) return;
        // SheetJS等写入器会列出未使用的bin宏类型；仅实际存在对应部件才构成宏文件。
        if ([...names].some((n) => macroDefaults.has(extname(n).slice(1).toLowerCase())))
          return bad('不接受宏或XML实体文档。');
        done = true;
        if (
          !names.has('[Content_Types].xml') ||
          !names.has(ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml')
        )
          reject(new ImportError('扩展名与Office文档类型不符。', 415));
        else resolve();
      });
      zip.readEntry();
    });
  });
}
function dimensions(bytes: Buffer, ext: string): [number, number] {
  if (ext === 'png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      return fail('PNG内容无效。');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (ext === 'webp') {
    if (
      bytes.length < 30 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP'
    )
      return fail('WebP内容无效。');
    const t = bytes.toString('ascii', 12, 16);
    if (t === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (t === 'VP8L' && bytes[20] === 0x2f)
      return [
        1 + (bytes.readUInt32LE(21) & 0x3fff),
        1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff),
      ];
    if (t === 'VP8 ' && bytes.toString('hex', 23, 26) === '9d012a')
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    return fail('WebP图像头无效。');
  }
  if (bytes[0] !== 255 || bytes[1] !== 216) return fail('JPEG内容无效。');
  let p = 2;
  while (p + 9 < bytes.length) {
    if (bytes[p++] !== 255) continue;
    const marker = bytes[p++];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = bytes.readUInt16BE(p);
    if (len < 2 || p + len > bytes.length) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    )
      return [bytes.readUInt16BE(p + 5), bytes.readUInt16BE(p + 3)];
    p += len;
  }
  return fail('无法读取有效JPEG尺寸。');
}
export async function validateAttachment(
  bytes: Buffer,
  name: string,
): Promise<Pick<AssistantAttachment, 'mime' | 'kind' | 'transfer' | 'width' | 'height'>> {
  if (!bytes.length || bytes.length > attachmentLimits.fileBytes)
    throw new ImportError('每份附件须大于0且不超过10MB。', 413);
  if (
    !name.trim() ||
    name.length > 180 ||
    /[\x00-\x1f/\\:]/.test(name) ||
    name === '.' ||
    name === '..'
  )
    return fail('附件名称无效，不允许路径或控制字符。');
  const ext = extname(name).slice(1).toLowerCase();
  if (!mime[ext]) return fail('不支持此附件类型。支持JPG、PNG、WebP、PDF、Word、Excel、CSV、TXT。');
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    const [w, h] = dimensions(bytes, ext);
    if (!w || !h || w * h > 20000000) return fail('图片尺寸无效或超过2000万像素。');
    try {
      const image = await loadImage(bytes);
      if (image.width !== w || image.height !== h) return fail('图片实际尺寸与文件头不一致。');
    } catch {
      return fail('图像内容损坏，无法解码。');
    }
    return { mime: mime[ext], kind: 'image', transfer: 'image', width: w, height: h };
  }
  if (ext === 'txt' || ext === 'csv') {
    attachmentText(bytes);
    return { mime: mime[ext], kind: 'text', transfer: 'text' };
  }
  if (ext === 'pdf') {
    if (
      bytes.toString('ascii', 0, 5) !== '%PDF-' ||
      !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))
    )
      return fail('PDF文件头或结尾无效，可能已损坏。');
    if (/\/JavaScript\b|\/JS\b|\/Launch\b|\/EmbeddedFile\b/.test(bytes.toString('latin1')))
      return fail('不接受包含脚本、启动动作或嵌入文件的PDF。');
    return { mime: mime.pdf, kind: 'pdf', transfer: 'file' };
  }
  if (ext === 'docx' || ext === 'xlsx') await validateOffice(bytes, ext);
  else if (
    bytes.includes(Buffer.from('VBA', 'utf16le')) ||
    bytes.includes(Buffer.from('EncryptedPackage', 'utf16le'))
  )
    return fail('不接受含宏或加密包的传统Office文件。');
  else if (
    bytes.length < 512 ||
    bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1' ||
    (!bytes.includes(Buffer.from(ext === 'doc' ? 'WordDocument' : 'Workbook', 'utf16le')) &&
      !(ext === 'xls' && bytes.includes(Buffer.from('Book', 'utf16le'))))
  )
    return fail('传统Office文件内容与扩展名不符。');
  return { mime: mime[ext], kind: 'office', transfer: 'file' };
}
