import { unsupportedFile } from './errors.js';

/*
 * 从图片文件头读宽高（PNG、WebP、JPEG）。只看文件头，不解码：附件校验先用它挡掉超大、头坏了的图，
 * 再交给图片库解码核对（attachment-validation.ts）。
 * 下面几张表是各格式文件头里用得到的位置（字节偏移）、签名和位宽，出处是各格式的规范。
 */

/** PNG：8 字节签名，IHDR 块里宽、高各 4 字节大端 */
const PNG = { signature: '89504e470d0a1a0a', minBytes: 33, widthAt: 16, heightAt: 20 };
/** WebP：RIFF 容器，第一个块的种类决定宽高在哪 */
const WEBP = {
  minBytes: 30,
  riff: { at: 0, text: 'RIFF' },
  webp: { at: 8, text: 'WEBP' },
  chunk: { at: 12, chars: 4 },
  /** VP8X（扩展格式）：画布宽、高减一，各 3 字节小端 */
  extended: { text: 'VP8X', widthAt: 24, heightAt: 27, bytes: 3 },
  /** VP8L（无损）：签名字节之后 4 字节里宽、高减一各占 14 位 */
  lossless: { text: 'VP8L', signatureAt: 20, signature: 0x2f, sizeAt: 21, bits: 14, mask: 0x3fff },
  /** VP8（有损）：关键帧起始码之后宽、高各 2 字节小端，取低 14 位 */
  lossy: { text: 'VP8 ', startCode: { at: 23, hex: '9d012a' }, widthAt: 26, heightAt: 28, mask: 0x3fff },
};
/** JPEG：以 SOI 开头，一段段标记往后找帧头（SOF），帧头里高、宽各 2 字节大端 */
const JPEG = {
  start: 'ffd8',
  markerByte: 0xff,
  /** 读到图像结束（EOI）或扫描开始（SOS）还没见到帧头就不找了 */
  stops: new Set(Buffer.from('d9da', 'hex')),
  /** 各种帧头（SOF0～SOF15，去掉不是帧头的 C4 DHT、C8 JPG、CC DAC） */
  frames: new Set(Buffer.from('c0c1c2c3c5c6c7c9cacbcdcecf', 'hex')),
  /** 标记、段长、精度、高、宽：至少还要这么多字节才读得出 */
  headerBytes: 9,
  heightAt: 3,
  widthAt: 5,
};

const textAt = (bytes: Buffer, at: number, text: string) =>
  bytes.toString('ascii', at, at + text.length) === text;
const hexAt = (bytes: Buffer, at: number, hex: string) =>
  bytes.toString('hex', at, at + hex.length / 2) === hex;

function pngSize(bytes: Buffer): [number, number] {
  if (bytes.length < PNG.minBytes || !hexAt(bytes, 0, PNG.signature)) throw unsupportedFile('PNG内容无效。');
  return [bytes.readUInt32BE(PNG.widthAt), bytes.readUInt32BE(PNG.heightAt)];
}

function webpSize(bytes: Buffer): [number, number] {
  const { riff, webp, chunk, extended: x, lossless: l, lossy: y } = WEBP;
  if (bytes.length < WEBP.minBytes || !textAt(bytes, riff.at, riff.text) || !textAt(bytes, webp.at, webp.text))
    throw unsupportedFile('WebP内容无效。');
  const t = bytes.toString('ascii', chunk.at, chunk.at + chunk.chars);
  if (t === x.text) return [1 + bytes.readUIntLE(x.widthAt, x.bytes), 1 + bytes.readUIntLE(x.heightAt, x.bytes)];
  if (t === l.text && bytes[l.signatureAt] === l.signature) {
    const size = bytes.readUInt32LE(l.sizeAt);
    return [1 + (size & l.mask), 1 + ((size >>> l.bits) & l.mask)];
  }
  if (t === y.text && hexAt(bytes, y.startCode.at, y.startCode.hex))
    return [bytes.readUInt16LE(y.widthAt) & y.mask, bytes.readUInt16LE(y.heightAt) & y.mask];
  throw unsupportedFile('WebP图像头无效。');
}

function jpegSize(bytes: Buffer): [number, number] {
  if (!hexAt(bytes, 0, JPEG.start)) throw unsupportedFile('JPEG内容无效。');
  let p = JPEG.start.length / 2;
  while (p + JPEG.headerBytes < bytes.length) {
    if (bytes[p++] !== JPEG.markerByte) continue;
    const marker = bytes[p++];
    if (JPEG.stops.has(marker)) break;
    const len = bytes.readUInt16BE(p);
    if (len < 2 || p + len > bytes.length) break;
    if (JPEG.frames.has(marker))
      return [bytes.readUInt16BE(p + JPEG.widthAt), bytes.readUInt16BE(p + JPEG.heightAt)];
    p += len;
  }
  throw unsupportedFile('无法读取有效JPEG尺寸。');
}

const readers = { png: pngSize, webp: webpSize, jpg: jpegSize, jpeg: jpegSize };
type ImageExtension = keyof typeof readers;

/** 这个扩展名是不是收的图片（JPG、PNG、WebP） */
export const isImageExtension = (ext: string): ext is ImageExtension => Object.hasOwn(readers, ext);

/** 按扩展名读文件头里的宽高；头不对抛 415 */
export function imageSize(bytes: Buffer, ext: ImageExtension): [number, number] {
  return readers[ext](bytes);
}
