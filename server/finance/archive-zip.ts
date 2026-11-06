import { crc32, deflateRawSync } from 'node:zlib';
import { financeError } from './core.js';

const uint32Max = 0xffffffff;
const uint16Max = 0xffff;
const utf8 = 1 << 11;
const deflate = 8;
const dosDate = 0x21; // 1980-01-01，ZIP 格式可表示的首日。

export function archiveZip(files: readonly { name: string; bytes: Buffer }[]) {
  if (files.length >= uint16Max) financeError('归档文件数量超过下载上限。');
  const entries: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0,
    directorySize = 0;
  for (const { name, bytes } of files) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(bytes);
    if (
      filename.length > uint16Max ||
      bytes.length >= uint32Max ||
      compressed.length >= uint32Max ||
      offset + 30 + filename.length + compressed.length >= uint32Max
    )
      financeError('归档文件大小超过下载上限。');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8, 6);
    local.writeUInt16LE(deflate, 8);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8, 8);
    central.writeUInt16LE(deflate, 10);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(local, filename, compressed);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
    directorySize += central.length + filename.length;
  }
  if (offset + directorySize + 22 >= uint32Max) financeError('归档文件大小超过下载上限。');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, ...directory, end]);
}
