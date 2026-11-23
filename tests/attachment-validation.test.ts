// 上传附件、外发前的安全检查（server/core/files/attachment-validation.ts）。纯函数、虚构文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachment } from '../server/core/index.js';
import { imageFixture, docxFixture, pdfFixture, xlsxFixture, zipFixture } from './import-fixtures.js';

test('附件名带路径、类型不支持、内容和扩展名对不上、损坏、二进制或非 UTF-8 当文字、超大、带 XML 实体、带脚本的 PDF 都拒收', async () => {
  const bad: [string, Buffer, RegExp][] = [
    ['穿越/图.png', imageFixture(), /附件名称无效/],
    ['脚本.exe', Buffer.from('MZ'), /不支持此附件类型/],
    ['伪装.png', Buffer.from('<html>'), /PNG内容无效/],
    ['伪装.xlsx', docxFixture(), /扩展名与Office文档类型不符/],
    ['无效.pdf', Buffer.from('%PDF-test'), /PDF文件头或结尾无效/],
    ['脚本.pdf', Buffer.from('%PDF-1.7\n/JavaScript\n%%EOF'), /包含脚本/],
    ['二进制.txt', Buffer.from([0x41, 0, 0x42]), /二进制控制字符/],
    ['非UTF8.txt', Buffer.from([0x41, 255]), /仅支持UTF-8/],
    ['过大.txt', Buffer.alloc(10 * 1024 * 1024 + 1), /不超过10MB/],
    [
      '实体.docx',
      zipFixture({ '[Content_Types].xml': '<!DOCTYPE x [<!ENTITY x "evil">]><Types/>', 'word/document.xml': '<w:document/>' }),
      /XML实体/,
    ],
  ];
  for (const [name, bytes, message] of bad) await assert.rejects(validateAttachment(bytes, name), message, name);
  for (const [name, bytes] of [
    ['虚构订单.docx', docxFixture()],
    ['虚构订单.xlsx', xlsxFixture()],
    ['虚构订单.pdf', await pdfFixture()],
    ['虚构图.png', imageFixture()],
  ] as [string, Buffer][])
    await validateAttachment(bytes, name);
});

test('宏：真有宏部件或宏主文档的拒收；普通表格只列了没用到的宏类型不误拦', async () => {
  // 有些表格软件会列出没用到的 bin 宏类型；只有真有对应部件才算宏文件
  const binType = '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>';
  await validateAttachment(
    zipFixture({
      '[Content_Types].xml': `<Types>${binType}<Default Extension="xml" ContentType="application/xml"/></Types>`,
      'xl/workbook.xml': '<workbook/>',
    }),
    '普通.xlsx',
  );
  const mainOverride = (prefix: string) =>
    `<${prefix}Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>`;
  const plainTypes = '<Types><Default Extension="xml" ContentType="application/xml"/></Types>';
  const macros: [string, Record<string, string>][] = [
    ['宏部件.xlsx', { '[Content_Types].xml': plainTypes, 'xl/workbook.xml': '<workbook/>', 'xl/vbaProject.bin': 'macro' }],
    ['宏部件.docx', { '[Content_Types].xml': plainTypes, 'word/document.xml': '<xml/>', 'word/vbaProject.bin': 'x' }],
    ['用到的宏类型.xlsx', { '[Content_Types].xml': `<Types>${binType}</Types>`, 'xl/workbook.xml': '<workbook/>', 'xl/test.bin': 'fake' }],
    ['宏主文档.xlsx', { '[Content_Types].xml': `<Types>${mainOverride('')}</Types>`, 'xl/workbook.xml': '<workbook/>' }],
    [
      '带命名空间的宏主文档.xlsx',
      {
        '[Content_Types].xml': `<c:Types xmlns:c="http://schemas.openxmlformats.org/package/2006/content-types">${mainOverride('c:')}</c:Types>`,
        'xl/workbook.xml': '<workbook/>',
      },
    ],
  ];
  for (const [name, files] of macros) await assert.rejects(validateAttachment(zipFixture(files), name), /宏/, name);
});

test('压缩包里任何 XML 部件（正文、工作表、关系文件）带 DOCTYPE 都拒收，前面垫空白、注释、处理指令也拦；正文里的文字不误拦', async () => {
  const types = '<Types><Default Extension="xml" ContentType="application/xml"/></Types>',
    doctype = '<!DOCTYPE x [<!ENTITY e "虚构实体">]>';
  const padded = '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n' + ' '.repeat(5000) + '<!--' + '虚'.repeat(5000) + '-->\n<?虚构 指令?>' + doctype;
  const bad: [string, Record<string, string | Buffer>][] = [
    ['正文实体.docx', { '[Content_Types].xml': types, 'word/document.xml': '<?xml version="1.0"?>' + doctype + '<w:document>&e;</w:document>' }],
    ['工作簿实体.xlsx', { '[Content_Types].xml': types, 'xl/workbook.xml': doctype + '<workbook/>' }],
    ['垫了注释.xlsx', { '[Content_Types].xml': types, 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': padded + '<worksheet/>' }],
    ['UTF-16 工作簿.xlsx', { '[Content_Types].xml': types, 'xl/workbook.xml': Buffer.from('\uFEFF' + doctype + '<workbook/>', 'utf16le') }],
    ['关系文件.docx', { '[Content_Types].xml': types, 'word/document.xml': '<w:document/>', '_rels/.rels': doctype + '<Relationships/>' }],
  ];
  for (const [name, files] of bad) await assert.rejects(validateAttachment(zipFixture(files), name), /XML实体/, name);
  // 正文里写着这几个字（CDATA 里、注释里）的照常收
  const text = '<?xml version="1.0"?><!-- <!DOCTYPE 只是注释 --><w:document><w:t><![CDATA[<!DOCTYPE 写在正文里]]></w:t></w:document>';
  await validateAttachment(zipFixture({ '[Content_Types].xml': types, 'word/document.xml': text }), '正文文字.docx');
});

test('扩展名是 constructor、__proto__ 这类对象自带的名字时按不支持的类型拒收，不当成老版 Office 收下', async () => {
  // 老版 Excel 的样子：复合文档签名加上 UTF-16 的 Workbook，只是扩展名改了
  const legacyXls = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from('Workbook', 'utf16le'), Buffer.alloc(512)]);
  for (const name of ['改名.constructor', '改名.__proto__'])
    await assert.rejects(validateAttachment(legacyXls, name), (e: unknown) => e instanceof Error && 'status' in e && e.status === 415 && /不支持此附件类型/.test(e.message), name);
});

test('Office 类型表写了两个 Types 根的按类型信息无效拒收', async () => {
  const types = '<Types><Default Extension="xml" ContentType="application/xml"/></Types>';
  await assert.rejects(
    validateAttachment(zipFixture({ '[Content_Types].xml': types + types, 'xl/workbook.xml': '<workbook/>' }), '两个类型表.xlsx'),
    /Office类型信息无效/,
  );
});
