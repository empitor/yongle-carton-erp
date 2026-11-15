import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { MIB } from '../../shared/core/index.js';
import { unsupportedFile } from './errors.js';

/*
 * 新版 Office 文档（docx、xlsx）的安全检查：助手附件和财务导入表格都走它。
 * 不解压到磁盘，逐个部件看：路径、条目数、加密、展开大小、宏和嵌入对象、XML 实体。
 */

const entityMessage = '不接受带XML实体（DOCTYPE）的Office文档。',
  macroMessage = '不接受带宏的Office文档。';
/** 单个部件和合计的展开大小上限（MB） */
const LIMIT_MB = { entry: 8, total: 40 };
/** 部件条数、单个部件和合计展开大小、压缩比（小于 1MB 的部件不看压缩比）、类型表字数 */
const OFFICE_LIMITS = {
  entries: 2000,
  entryBytes: LIMIT_MB.entry * MIB,
  totalBytes: LIMIT_MB.total * MIB,
  ratioFreeBytes: MIB,
  ratio: 150,
  contentTypesChars: 200_000,
};
/** 序言里要跳过的注释的开头 */
const COMMENT_OPEN = '<!--';
/** XML 开头两个字节认 UTF-16：带 BOM，或第一个字符“<”占两个字节；别的按 UTF-8 */
const UTF16_STARTS: Record<string, 'utf-16le' | 'utf-16be'> = {
  fffe: 'utf-16le',
  '3c00': 'utf-16le',
  feff: 'utf-16be',
  '003c': 'utf-16be',
};

function officeFail(message: string): never {
  throw unsupportedFile(message);
}

/**
 * Office 压缩包里一个 XML 部件的序言（第一个元素之前）有没有 DOCTYPE：正常的 Office 部件都不带，带了就可能藏实体。
 * DOCTYPE 只能出现在序言里，所以看到第一个元素就停；按块喂、不攒整个部件，注释和处理指令只留结尾标记前的几个字，
 * 前面垫多少空白、注释都一样查得到。编码按 XML 规定从开头两个字节认（UTF-16 带 BOM 或以 “<” 开头），其余按 UTF-8。
 */
class XmlProlog {
  result: 'pending' | 'clean' | 'doctype' = 'pending';
  private decoder?: TextDecoder;
  private head = Buffer.alloc(0);
  private text = '';
  /** 正在跳过的注释或处理指令的结尾标记 */
  private until = '';
  push(bytes: Buffer) {
    if (this.result !== 'pending') return this.result;
    if (!this.decoder) {
      this.head = Buffer.concat([this.head, bytes]);
      if (this.head.length < 2) return this.result;
      bytes = this.head;
      this.decoder = new TextDecoder(UTF16_STARTS[bytes.toString('hex', 0, 2)] ?? 'utf-8');
    }
    this.text += this.decoder.decode(bytes, { stream: true });
    return this.scan();
  }
  private scan() {
    for (;;) {
      if (this.until) {
        const at = this.text.indexOf(this.until);
        if (at < 0) {
          this.text = this.text.slice(-(this.until.length - 1));
          return this.result;
        }
        this.text = this.text.slice(at + this.until.length);
        this.until = '';
      }
      this.text = this.text.replace(/^[\s﻿]+/, '');
      const t = this.text;
      // 到了第一个元素（或序言里出现了不该有的文字）：序言结束，没有 DOCTYPE
      if (!t || (t[0] === '<' && t.length < 2)) return this.result;
      if (t[0] !== '<' || (t[1] !== '?' && t[1] !== '!')) return (this.result = 'clean');
      if (t[1] === '?') {
        this.text = t.slice(2);
        this.until = '?>';
        continue;
      }
      if (t.length < COMMENT_OPEN.length) return this.result;
      if (!t.startsWith(COMMENT_OPEN)) return (this.result = 'doctype');
      this.text = t.slice(COMMENT_OPEN.length);
      this.until = '-->';
    }
  }
}

function openZip(bytes: Buffer) {
  return new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) =>
      error || !zip ? reject(unsupportedFile('Office不是有效ZIP文档。')) : resolve(zip),
    ),
  );
}

/** 逐个部件读压缩包：读完一个再要下一个（lazyEntries），读到头返回 null；压缩容器坏了按“损坏”报 */
function zipEntries(zip: yauzl.ZipFile) {
  let broken = false;
  zip.on('error', () => (broken = true));
  return async function* () {
    for (;;) {
      if (broken) officeFail('Office压缩容器损坏。');
      const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
        const done = (value: yauzl.Entry | null) => {
          zip.off('entry', done).off('end', end).off('error', failed);
          resolve(value);
        };
        const end = () => done(null),
          failed = () => {
            zip.off('entry', done).off('end', end).off('error', failed);
            reject(unsupportedFile('Office压缩容器损坏。'));
          };
        zip.on('entry', done).on('end', end).on('error', failed);
        zip.readEntry();
      });
      if (!entry) return;
      yield entry;
    }
  };
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry, message: string) {
  return new Promise<Readable>((resolve, reject) =>
    zip.openReadStream(entry, (e, stream) =>
      e || !stream ? reject(unsupportedFile(message)) : resolve(stream),
    ),
  );
}

/** 解压出来的一块：yauzl 交出来的都是 Buffer，不是就当内容坏了 */
const chunkBytes = (chunk: unknown) => (Buffer.isBuffer(chunk) ? chunk : officeFail('Office内容损坏。'));

/** 部件名和大小在解压之前就查：路径、条目数、加密、展开大小和压缩比、宏和嵌入对象 */
function checkEntry(entry: yauzl.Entry, seen: { names: Set<string>; total: number }) {
  const n = entry.fileName;
  if (seen.names.size >= OFFICE_LIMITS.entries || seen.names.has(n) || /(^\/|\\|(?:^|\/)\.\.(?:\/|$)|:)/.test(n))
    officeFail('Office包含异常路径或过多条目。');
  seen.names.add(n);
  seen.total += entry.uncompressedSize;
  if (
    entry.generalPurposeBitFlag & 1 ||
    entry.uncompressedSize > OFFICE_LIMITS.entryBytes ||
    seen.total > OFFICE_LIMITS.totalBytes ||
    entry.uncompressedSize > Math.max(OFFICE_LIMITS.ratioFreeBytes, entry.compressedSize * OFFICE_LIMITS.ratio)
  )
    officeFail('Office加密、展开过大或压缩比例异常。');
  if (/vbaProject|activeX|embeddings\//i.test(n)) officeFail('不接受宏、ActiveX或嵌入可执行对象。');
}

/** 读类型表（[Content_Types].xml），最多 20 万字 */
async function readContentTypes(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  const stream = await openStream(zip, entry, 'Office内容类型损坏。');
  let xml = '';
  try {
    for await (const chunk of stream) {
      xml += chunkBytes(chunk).toString('utf8');
      if (xml.length > OFFICE_LIMITS.contentTypesChars) break;
    }
  } catch {
    officeFail('Office内容损坏。');
  }
  if (xml.length > OFFICE_LIMITS.contentTypesChars) officeFail('Office类型信息过大。');
  return xml;
}

/** 类型表解析出来的样子：根元素 Types 下的 Override、Default（一项是对象，几项是数组） */
const typesDocument = z.object({
  Types: z.object({ Override: z.unknown().optional(), Default: z.unknown().optional() }),
});
/** 类型表里的一项：只看内容类型和扩展名两个属性（缺了当文字 undefined，和原样拼出来的一致） */
const typeEntry = z.object({ '@_ContentType': z.unknown().optional(), '@_Extension': z.unknown().optional() });
const typeEntries = (v: unknown) =>
  (v == null ? [] : Array.isArray(v) ? v : [v]).map((item: unknown) => {
    const parsed = typeEntry.safeParse(item);
    return parsed.success ? parsed.data : {};
  });

/** 查类型表：带实体拒收；有宏主文档的拒收；返回声明成宏类型的扩展名（真有这种部件才算宏，见 validateOffice） */
function macroExtensions(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) officeFail(entityMessage);
  let parsed: unknown;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, processEntities: false, removeNSPrefix: true });
    parsed = parser.parse(xml);
  } catch {
    officeFail('Office类型信息无效。');
  }
  const document = typesDocument.safeParse(parsed);
  if (!document.success) return officeFail('Office类型信息无效。');
  const types = document.data.Types;
  const macro = (v: z.output<typeof typeEntry>) => /macroEnabled|vbaProject/i.test(String(v['@_ContentType']));
  if (typeEntries(types.Override).some(macro)) officeFail(macroMessage);
  return typeEntries(types.Default)
    .filter(macro)
    .map((v) => String(v['@_Extension']).toLowerCase());
}

/** 判断一个 XML 部件的序言里有没有 DOCTYPE：流式读，序言一结束就停 */
async function prologHasDoctype(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  const prolog = new XmlProlog();
  const stream = await openStream(zip, entry, 'Office内容损坏。');
  try {
    for await (const chunk of stream) if (prolog.push(chunkBytes(chunk)) !== 'pending') break;
  } catch {
    officeFail('Office内容损坏。');
  }
  return prolog.result === 'doctype';
}

export async function validateOffice(bytes: Buffer, ext: string) {
  const zip = await openZip(bytes);
  try {
    const seen = { names: new Set<string>(), total: 0 },
      macroDefaults = new Set<string>();
    for await (const entry of zipEntries(zip)()) {
      checkEntry(entry, seen);
      if (entry.fileName === '[Content_Types].xml')
        for (const e of macroExtensions(await readContentTypes(zip, entry))) macroDefaults.add(e);
      else if (/\.(xml|rels)$/i.test(entry.fileName) && (await prologHasDoctype(zip, entry)))
        officeFail(entityMessage);
    }
    // SheetJS等写入器会列出未使用的bin宏类型；仅实际存在对应部件才构成宏文件。
    if ([...seen.names].some((n) => macroDefaults.has(extname(n).slice(1).toLowerCase())))
      officeFail(macroMessage);
    const main = ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
    if (!seen.names.has('[Content_Types].xml') || !seen.names.has(main))
      officeFail('扩展名与Office文档类型不符。');
  } catch (e) {
    zip.close();
    throw e;
  }
}
