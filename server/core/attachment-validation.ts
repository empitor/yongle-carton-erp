import { extname } from 'node:path';
import { AppError, unsupportedFile } from './errors.js';
import { imageSize, isImageExtension } from './image-size.js';
import { validateOffice } from './office-validation.js';
import { attachmentLimits, type AssistantAttachment } from '../../shared/core/index.js';

/*
 * 助手附件上传、外发前的安全检查：名字、类型、大小，再按种类看内容（图片文件头和解码、文本编码、PDF 脚本、Office 宏）。
 * 新版 Office 的检查在 office-validation.ts，图片文件头在 image-size.ts。
 */

/** 收的扩展名和它的类型。用 Map：扩展名是用户给的，查普通对象会查到 constructor、__proto__ 这些自带的名字 */
const mimeTypes = new Map<string, string>(
  Object.entries({
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
  }),
);
/** 上传的文件（助手附件、识别原件、到货原件、收件箱收来的文件）文件名最多几个字 */
export const FILE_NAME_MAX = 180;
/** 文件名字数、图片像素、文本字数的上限 */
const LIMITS = { nameChars: FILE_NAME_MAX, imagePixels: 20_000_000, textChars: 200_000 };
/** PDF：开头的标记，结尾标记要出现在最后这么多字节里 */
const PDF = { start: '%PDF-', end: '%%EOF', tailBytes: 2048 };
/** 老版 Office（doc、xls）的复合文档：最小大小和 8 字节签名 */
const OLE = { minBytes: 512, signature: 'd0cf11e0a1b11ae1' };

type AttachmentCheck = Pick<AssistantAttachment, 'mime' | 'kind' | 'transfer' | 'width' | 'height'>;

function attachmentText(bytes: Buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
      throw unsupportedFile('文本含二进制控制字符，不能作为TXT/CSV发送。');
    if (text.length > LIMITS.textChars) throw unsupportedFile('文本超过20万字符，请拆分后上传。');
    return text.replace(/^﻿/, '');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw unsupportedFile('TXT/CSV目前仅支持UTF-8，请另存为UTF-8后上传。');
  }
}

function checkName(name: string) {
  if (
    !name.trim() ||
    name.length > LIMITS.nameChars ||
    /[\x00-\x1f/\\:]/.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw unsupportedFile('附件名称无效，不允许路径或控制字符。');
}

/** 把图片解码出宽高；解码不了就抛错 */
type ImageDecoder = (bytes: Buffer) => Promise<{ width: number; height: number }>;
/** 取得解码函数（加载图片库）；加载失败是服务器的问题，不是文件的问题 */
type DecoderLoader = () => Promise<ImageDecoder>;

/** 默认用原生图片库解码 */
const canvasDecoder: DecoderLoader = async () => {
  // 原生图片库只在检查图片时加载，基础层的入口不因此变重（单据导出画样张也用它，正式服务启动时照样要有这个库）
  const { loadImage } = await import('@napi-rs/canvas');
  return loadImage;
};

/** 解码；只有解码这一步失败才报“图像内容损坏”，加载图片库失败照常往上抛（回 500、进日志） */
async function decodeImage(bytes: Buffer, loadDecoder: DecoderLoader) {
  const decode = await loadDecoder();
  try {
    return await decode(bytes);
  } catch {
    throw unsupportedFile('图像内容损坏，无法解码。');
  }
}

/**
 * 图片：文件头的宽高在上限内，解码出来的宽高和文件头一致，或者正好对调（手机竖拍的照片带方向标记，
 * 图片库按标记转过来解码；像素数一样，像素上限照样按文件头的宽乘高算）。
 */
async function checkImage(
  bytes: Buffer,
  ext: Parameters<typeof imageSize>[1],
  mime: string,
  loadDecoder: DecoderLoader,
): Promise<AttachmentCheck> {
  const [w, h] = imageSize(bytes, ext);
  if (!w || !h || w * h > LIMITS.imagePixels) throw unsupportedFile('图片尺寸无效或超过2000万像素。');
  const image = await decodeImage(bytes, loadDecoder);
  const same = image.width === w && image.height === h,
    swapped = image.width === h && image.height === w;
  if (!same && !swapped) throw unsupportedFile('图片实际尺寸与文件头不一致。');
  return { mime, kind: 'image', transfer: 'image', width: w, height: h };
}

function checkPdf(bytes: Buffer) {
  if (
    bytes.toString('ascii', 0, PDF.start.length) !== PDF.start ||
    !bytes.subarray(-PDF.tailBytes).includes(Buffer.from(PDF.end))
  )
    throw unsupportedFile('PDF文件头或结尾无效，可能已损坏。');
  if (/\/JavaScript\b|\/JS\b|\/Launch\b|\/EmbeddedFile\b/.test(bytes.toString('latin1')))
    throw unsupportedFile('不接受包含脚本、启动动作或嵌入文件的PDF。');
}

/** 老版 Office（doc、xls）：不带宏和加密包，复合文档签名和扩展名对得上 */
function checkLegacyOffice(bytes: Buffer, ext: string) {
  if (bytes.includes(Buffer.from('VBA', 'utf16le')) || bytes.includes(Buffer.from('EncryptedPackage', 'utf16le')))
    throw unsupportedFile('不接受含宏或加密包的传统Office文件。');
  if (
    bytes.length < OLE.minBytes ||
    bytes.toString('hex', 0, OLE.signature.length / 2) !== OLE.signature ||
    (!bytes.includes(Buffer.from(ext === 'doc' ? 'WordDocument' : 'Workbook', 'utf16le')) &&
      !(ext === 'xls' && bytes.includes(Buffer.from('Book', 'utf16le'))))
  )
    throw unsupportedFile('传统Office文件内容与扩展名不符。');
}

/** 附件的安全检查；loadDecoder 取得图片的解码函数（默认加载原生图片库） */
export async function validateAttachment(
  bytes: Buffer,
  name: string,
  loadDecoder: DecoderLoader = canvasDecoder,
): Promise<AttachmentCheck> {
  if (!bytes.length || bytes.length > attachmentLimits.fileBytes)
    throw new AppError('每份附件须大于0且不超过10MB。', 413);
  checkName(name);
  const ext = extname(name).slice(1).toLowerCase();
  const mime = mimeTypes.get(ext);
  if (!mime) throw unsupportedFile('不支持此附件类型。支持JPG、PNG、WebP、PDF、Word、Excel、CSV、TXT。');
  if (isImageExtension(ext)) return checkImage(bytes, ext, mime, loadDecoder);
  if (ext === 'txt' || ext === 'csv') {
    attachmentText(bytes);
    return { mime, kind: 'text', transfer: 'text' };
  }
  if (ext === 'pdf') {
    checkPdf(bytes);
    return { mime, kind: 'pdf', transfer: 'file' };
  }
  if (ext === 'docx' || ext === 'xlsx') await validateOffice(bytes, ext);
  else checkLegacyOffice(bytes, ext);
  return { mime, kind: 'office', transfer: 'file' };
}
