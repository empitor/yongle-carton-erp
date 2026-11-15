/**
 * 结账归档的压缩包：几个文件按 ZIP 格式（PKWARE APPNOTE）逐个 deflate 压缩，拼成一个包。
 * 每段头按顺序写一串小端整数，字段的先后和宽度照格式说明，不写偏移量。
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { financeError } from './core.js';

const uint32Max = 0xffffffff;
const uint16Max = 0xffff;
/** 头里一个字段占几个字节 */
const U16 = 2;
const U32 = 4;
/** 三种头的签名：本地文件头、中央目录项、中央目录结束 */
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** 生成和解压要的版本：2.0（支持 deflate） */
const ZIP_VERSION = 20;
/** 通用标志第 11 位：文件名按 UTF-8 */
const UTF8_NAMES = 0x800;
/** 压缩方法：deflate */
const DEFLATE = 8;
/** 修改日期：1980-01-01，ZIP 格式可表示的首日（时间是 0 点） */
const DOS_DATE = 0x21;
const NONE = 0;

type Field = readonly [width: typeof U16 | typeof U32, value: number];
const byteLength = (fields: readonly Field[]) => fields.reduce((n, [width]) => n + width, 0);
function packed(fields: readonly Field[]) {
  const buffer = Buffer.alloc(byteLength(fields));
  let at = 0;
  for (const [width, value] of fields) {
    if (width === U16) buffer.writeUInt16LE(value, at);
    else buffer.writeUInt32LE(value, at);
    at += width;
  }
  return buffer;
}

/** 一个文件压缩后的几项：文件名（UTF-8）、CRC、压缩前后的长度 */
type Packed = { filename: Buffer; crc: number; compressed: Buffer; size: number };
/** 本地文件头和中央目录项共有的一段：标志、压缩方法、修改时间日期、CRC、压缩前后长度、文件名长度、扩展字段长度 */
const commonFields = (file: Packed): Field[] => [
  [U16, UTF8_NAMES],
  [U16, DEFLATE],
  [U16, NONE],
  [U16, DOS_DATE],
  [U32, file.crc],
  [U32, file.compressed.length],
  [U32, file.size],
  [U16, file.filename.length],
  [U16, NONE],
];
const localHeader = (file: Packed): Field[] => [[U32, LOCAL_SIGNATURE], [U16, ZIP_VERSION], ...commonFields(file)];
/** 中央目录项：生成版本、解压版本，共有的一段，注释长度、起始盘、内外部属性，本地头在包里的位置 */
const centralHeader = (file: Packed, offset: number): Field[] => [
  [U32, CENTRAL_SIGNATURE],
  [U16, ZIP_VERSION],
  [U16, ZIP_VERSION],
  ...commonFields(file),
  [U16, NONE],
  [U16, NONE],
  [U16, NONE],
  [U32, NONE],
  [U32, offset],
];
/** 中央目录结束：本盘号、目录起始盘号、本盘和总共几项、目录多长、目录从哪开始、注释长度 */
const endRecord = (count: number, size: number, start: number): Field[] => [
  [U32, END_SIGNATURE],
  [U16, NONE],
  [U16, NONE],
  [U16, count],
  [U16, count],
  [U32, size],
  [U32, start],
  [U16, NONE],
];

export function archiveZip(files: readonly { name: string; bytes: Buffer }[]) {
  if (files.length >= uint16Max) financeError('归档文件数量超过下载上限。');
  const entries: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0,
    directorySize = 0;
  for (const { name, bytes } of files) {
    const file: Packed = {
      filename: Buffer.from(name, 'utf8'),
      crc: crc32(bytes),
      compressed: deflateRawSync(bytes),
      size: bytes.length,
    };
    const local = localHeader(file);
    if (
      file.filename.length > uint16Max ||
      bytes.length >= uint32Max ||
      file.compressed.length >= uint32Max ||
      offset + byteLength(local) + file.filename.length + file.compressed.length >= uint32Max
    )
      financeError('归档文件大小超过下载上限。');
    const localBytes = packed(local);
    const central = packed(centralHeader(file, offset));
    entries.push(localBytes, file.filename, file.compressed);
    directory.push(central, file.filename);
    offset += localBytes.length + file.filename.length + file.compressed.length;
    directorySize += central.length + file.filename.length;
  }
  const end = endRecord(files.length, directorySize, offset);
  if (offset + directorySize + byteLength(end) >= uint32Max) financeError('归档文件大小超过下载上限。');
  return Buffer.concat([...entries, ...directory, packed(end)]);
}
