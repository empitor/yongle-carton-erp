import yauzl from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const base = dirname(fileURLToPath(import.meta.url));
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});
function xml(buffer) {
  const text = buffer.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('文件包含不允许的 XML 实体声明。');
  return xmlParser.parse(text);
}
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return Object.entries(node)
    .filter(([k]) => !k.startsWith('@_'))
    .map(([k, v]) => (k === '#text' ? String(v) : textOf(v)))
    .join('');
}
async function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => {
        if (error) return reject(new Error('Office 文件不是有效 ZIP 容器。'));
        const files = new Map();
        let total = 0,
          count = 0;
        const fail = (message) => {
          zip.close();
          reject(new Error(message));
        };
        zip.on('error', () => fail('Office 压缩文件损坏。'));
        zip.on('entry', (entry) => {
          const name = entry.fileName;
          if (++count > 2000 || /(^\/|\\|(?:^|\/)\.\.(?:\/|$)|:)/.test(name) || files.has(name))
            return fail('Office 压缩包条目过多、路径异常或重复。');
          if (entry.generalPurposeBitFlag & 1) return fail('不支持加密文件。');
          total += entry.uncompressedSize;
          if (
            entry.uncompressedSize > 8 * 1024 * 1024 ||
            total > 40 * 1024 * 1024 ||
            entry.uncompressedSize > Math.max(1024 * 1024, entry.compressedSize * 150)
          )
            return fail('Office 文件展开后过大或压缩比例异常。');
          if (/vbaProject|activeX|embeddings\//i.test(name))
            return fail('文件包含宏、ActiveX 或嵌入对象，已拒绝。');
          if (/\/$/.test(name)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (e, stream) => {
            if (e) return fail('Office 条目读取失败。');
            const chunks = [];
            let bytes = 0;
            stream.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) {
                stream.destroy();
                fail('Office 条目展开超限。');
              } else chunks.push(chunk);
            });
            stream.on('error', () => fail('Office 文件损坏。'));
            stream.on('end', () => {
              files.set(name, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => resolve(files));
        zip.readEntry();
      },
    );
  });
}
// execFile 不接受 input；使用子进程标准输入传递文件路径，不拼接命令文本。
async function ocr(path) {
  if (process.platform !== 'win32') return null;
  const { spawn } = await import('node:child_process');
  const script = await readFile(join(base, '../../scripts/ocr-image.ps1'), 'utf8');
  return new Promise((resolve) => {
    const child = spawn(
      join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '',
      finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 20000);
    child.stdout.on('data', (b) => {
      output += b.toString('utf8');
      if (output.length > 1024 * 1024) {
        child.kill();
        finish(null);
      }
    });
    child.on('error', () => finish(null));
    child.on('exit', () => {
      try {
        const doc = JSON.parse(output.replace(/^\uFEFF/, ''));
        finish(doc.ok ? doc : null);
      } catch {
        finish(null);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ path }));
  });
}
function assertImageSize(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 20000000)
      throw new Error('图片超过像素限制。');
    return;
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let pos = 2;
    while (pos + 4 < bytes.length) {
      if (bytes[pos++] !== 255) continue;
      let marker = bytes[pos++];
      while (marker === 255) marker = bytes[pos++];
      if (marker === 217 || marker === 218) break;
      const size = bytes.readUInt16BE(pos);
      if (size < 2 || pos + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (size < 7 || bytes.readUInt16BE(pos + 3) * bytes.readUInt16BE(pos + 5) > 20000000)
          throw new Error('JPEG 超过像素限制。');
        return;
      }
      pos += size;
    }
    throw new Error('JPEG 尺寸头缺失或损坏。');
  }
  throw new Error('不是受支持的 PNG/JPEG 图像。');
}
export async function parseFile(path, format, fileId, directory, textOnly=false) {
  path = resolve(path);
  directory = resolve(directory);
  const buffer = await readFile(path),
    blocks = [],
    previews = [],
    warnings = [],
    imagePages = [];
  const add = (text, ref, method) => {
    if (blocks.length >= 3000) throw new Error('文件超过 3000 个来源块，请拆分文件。');
    blocks.push({ id: 'source-' + (blocks.length + 1), text, ref: { ...ref, fileId }, method });
  };
  const addImage = async (bytes, page) => {
    assertImageSize(bytes);
    const image = await loadImage(bytes);
    if (image.width * image.height > 20000000) throw new Error('图像超过 2000 万像素。');
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const name = 'preview-' + page + '.png';
    await writeFile(join(directory, name), canvas.toBuffer('image/png'));
    previews.push({ page, name });
    imagePages.push(page);
    add('', { kind: 'image', page, region: [0, 0, 1, 1], unit: 'normalized' }, 'vision-required');
    warnings.push('第 ' + page + ' 页使用原图视觉识别，不依赖本机OCR；模型不支持时明确报错。');
  };
  if (format === 'xls') {
    if (
      !buffer.includes(Buffer.from('Workbook', 'utf16le')) &&
      !buffer.includes(Buffer.from('Book', 'utf16le'))
    )
      throw new Error('OLE容器不是传统Excel工作簿。');
    if (
      buffer.includes(Buffer.from('VBA', 'utf16le')) ||
      buffer.includes(Buffer.from('EncryptedPackage', 'utf16le'))
    )
      throw new Error('不接受含宏或加密的XLS。');
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buffer, {
      type: 'buffer',
      cellNF: true,
      cellText: true,
      cellFormula: true,
      bookVBA: true,
    });
    if (wb.vbaraw || wb.SheetNames.length > 20) throw new Error('工作簿含宏或工作表超过20张。');
    let count = 0;
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 50000)
        throw new Error('工作簿范围过大。');
      for (let row = range.s.r; row <= range.e.r; row++) {
        const values = [];
        for (let col = range.s.c; col <= range.e.c; col++) {
          const address = XLSX.utils.encode_cell({ r: row, c: col }),
            cell = sheet[address];
          if (!cell) continue;
          if (++count > 50000) throw new Error('工作簿超过50000单元格。');
          values.push(
            address +
              '=' +
              String(cell.v ?? '') +
              ' [显示:' +
              String(cell.w ?? cell.v ?? '') +
              ';格式:' +
              String(cell.z ?? '') +
              (cell.f ? ';公式缓存，未执行' : '') +
              ']',
          );
        }
        if (values.length)
          add(
            values.join(' | '),
            {
              kind: 'excel',
              sheet: name,
              row: row + 1,
              columns: values.map((v) => v.split('=')[0]).join(','),
            },
            'xls-binary',
          );
      }
    }
  } else if (format === 'xlsx' || format === 'docx') {
    const files = await unzip(buffer);
    if (!files.has('[Content_Types].xml')) throw new Error('不是有效的 Office Open XML 文件。');
    for (const [name, data] of files)
      if (name.endsWith('.xml') || name.endsWith('.rels')) xml(data);
    if (format === 'xlsx') {
      if (!files.has('xl/workbook.xml'))
        throw new Error('文件扩展名为 xlsx，但内容不是 Excel 工作簿。');
      const wb = xml(files.get('xl/workbook.xml')).workbook,
        rels = arr(xml(files.get('xl/_rels/workbook.xml.rels')).Relationships?.Relationship);
      const strings = files.has('xl/sharedStrings.xml')
        ? arr(xml(files.get('xl/sharedStrings.xml')).sst?.si).map(textOf)
        : [];
      const styles = files.has('xl/styles.xml') ? xml(files.get('xl/styles.xml')).styleSheet : null,
        formats = new Map(
          arr(styles?.numFmts?.numFmt).map((n) => [n['@_numFmtId'], n['@_formatCode']]),
        ),
        xfs = arr(styles?.cellXfs?.xf);
      const sheets = arr(wb.sheets?.sheet);
      if (sheets.length > 20) throw new Error('工作表超过 20 张。');
      let cells = 0;
      for (const sheet of sheets) {
        const rel = rels.find((r) => r['@_Id'] === sheet['@_r:id']);
        if (!rel || rel['@_TargetMode'] === 'External') throw new Error('工作表关联无效。');
        const target = rel['@_Target'].replace(/^\//, '');
        const name = target.startsWith('xl/') ? target : 'xl/' + target;
        if (!files.has(name)) throw new Error('工作表文件缺失。');
        const data = xml(files.get(name)).worksheet;
        for (const row of arr(data.sheetData?.row)) {
          const values = [];
          for (const c of arr(row.c)) {
            if (++cells > 50000) throw new Error('工作簿超过 50000 个单元格。');
            const coord = c['@_r'] || '',
              kind = c['@_t'];
            let value =
              kind === 's'
                ? strings[Number(c.v)] || ''
                : kind === 'inlineStr'
                  ? textOf(c.is)
                  : String(c.v ?? '');
            if (kind === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
            const style = xfs[Number(c['@_s'] || 0)],
              fmtId = style?.['@_numFmtId'],
              fmt = formats.get(fmtId) || '';
            if (
              value &&
              (/^14$|^15$|^16$|^17$|^22$/.test(fmtId || '') ||
                /[yd]/i.test(fmt.replace(/"[^"]*"/g, '')))
            ) {
              const serial = Number(value);
              if (Number.isFinite(serial) && serial >= 0 && serial < 100000) {
                const date1904 = ['1', 'true'].includes(wb.workbookPr?.['@_date1904']);
                if (!date1904 && serial === 60) value += '（Excel 虚构闰日，待确认）';
                else {
                  const days = date1904 ? serial : serial > 60 ? serial - 1 : serial;
                  value +=
                    '（日期 ' +
                    new Date(
                      Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) +
                        days * 86400000,
                    )
                      .toISOString()
                      .slice(0, 10) +
                    '）';
                }
              }
            }
            if (fmt && !/[yd]/i.test(fmt.replace(/"[^"]*"/g, '')))
              value += ' [数字格式:' + fmt + ']';
            if (c.f !== undefined) {
              value += ' [公式缓存；未执行公式]';
              warnings.push('存在公式：只保留缓存与来源，不执行公式或外链。');
            }
            if (value) values.push(coord + '=' + value);
          }
          if (values.length)
            add(
              values.join(' | '),
              {
                kind: 'excel',
                sheet: sheet['@_name'],
                row: Number(row['@_r']),
                columns: values.map((v) => v.split('=')[0]).join(','),
              },
              'xml',
            );
        }
        if (sheet['@_state'])
          warnings.push(
            '包含隐藏工作表 ' + sheet['@_name'] + '，其内容已纳入本地预览，请检查外发范围。',
          );
      }
      if (files.has('xl/externalLinks/_rels/externalLink1.xml.rels'))
        warnings.push('工作簿存在外部链接，未访问或更新外链。');
    } else {
      if (!files.has('word/document.xml'))
        throw new Error('文件扩展名为 docx，但内容不是 Word 文档。');
      const ordered = new XMLParser({
        preserveOrder: true,
        ignoreAttributes: false,
        parseTagValue: false,
        processEntities: true,
        trimValues: false,
      }).parse(files.get('word/document.xml').toString('utf8'));
      let paragraph = 0;
      const extract = (node) => {
        if (Array.isArray(node)) return node.map(extract).join('');
        if (!node || typeof node !== 'object') return '';
        return Object.entries(node)
          .map(([k, v]) =>
            k === '#text'
              ? String(v)
              : k === 'w:p'
                ? extract(v) + '\n'
                : k === 'w:tab'
                  ? '\t'
                  : k === 'w:br'
                    ? '\n'
                    : k === ':@'
                      ? ''
                      : extract(v),
          )
          .join('');
      };
      const walk = (nodes) => {
        for (const node of arr(nodes))
          for (const [k, v] of Object.entries(node)) {
            if (k === 'w:tr') {
              const text = arr(v)
                .filter((n) => n['w:tc'])
                .map((n) => extract(n['w:tc']))
                .join(' | ');
              if (text.trim()) add(text, { kind: 'document', paragraph: ++paragraph }, 'xml');
            } else if (k === 'w:p') {
              const text = extract(v);
              if (text.trim()) add(text, { kind: 'document', paragraph: ++paragraph }, 'xml');
            } else if (k !== ':@' && Array.isArray(v)) walk(v);
          }
      };
      walk(ordered);
      warnings.push(
        'Word 来源按段落／表格行定位，未推断版式页码；页眉页脚及修订内容请结合原件核对。',
      );
      if(!textOnly){
        let page = 0;
        for (const [name, data] of files)
          if (/^word\/media\/.*\.(png|jpe?g)$/i.test(name)) {
            if (++page > 10) throw new Error('嵌入图片超过 10 张。');
            await addImage(data, page);
          }
      }
    }
  } else if (format === 'doc') {
    if (buffer.length < 512 || buffer.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1')
      throw new Error('不是有效的传统 Word 二进制文件。');
    if (!buffer.includes(Buffer.from('WordDocument', 'utf16le')))
      throw new Error('OLE 容器中没有 WordDocument。');
    if (
      buffer.includes(Buffer.from('VBA', 'utf16le')) ||
      buffer.includes(Buffer.from('EncryptedPackage', 'utf16le'))
    )
      throw new Error('不接受含宏或加密的传统 Word 文件。');
    // 锁定版本的解析器钩子：在处理 Table 流前校验 MS-DOC FibBase，拒绝加密/混淆数据。
    const { default: WordOleExtractor } = await import('word-extractor/lib/word-ole-extractor.js');
    const { default: BufferReader } = await import('word-extractor/lib/buffer-reader.js');
    class CheckedWordExtractor extends WordOleExtractor {
      extractWordDocument(document, wordBuffer) {
        if (wordBuffer.length < 32 || wordBuffer.readUInt16LE(0) !== 0xa5ec)
          throw new Error('不支持此传统 Word 版本，请另存 docx/PDF。');
        if (wordBuffer.readUInt16LE(0x0a) & 0x0100)
          throw new Error('传统 DOC 已加密或混淆，无法读取，请提供解密副本。');
        return super.extractWordDocument(document, wordBuffer);
      }
    }
    const doc = await new CheckedWordExtractor().extract(new BufferReader(buffer));
    let paragraph = 0;
    for (const text of [
      doc.getBody(),
      doc.getHeaders(),
      doc.getFootnotes(),
      doc.getEndnotes(),
      doc.getTextboxes(),
    ]
      .join('\n')
      .split(/[\n\r]+/))
      if (text.trim()) add(text, { kind: 'document', paragraph: ++paragraph }, 'doc-binary');
    warnings.push(
      '传统 DOC 使用本地二进制提取器，不需要 Office。复杂排版、扫描图片和不兼容版本可能无法完整提取；没有可靠页码。',
    );
  } else if (format === 'pdf') {
    if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new Error('不是有效的 PDF。');
    if (/\/JavaScript\b|\/JS\b|\/Launch\b|\/EmbeddedFile\b/.test(buffer.toString('latin1')))
      throw new Error('PDF 包含脚本、启动动作或嵌入文件，已拒绝。');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
      enableXfa: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    let pdf;
    try {
      pdf = await task.promise;
      if (pdf.numPages > 10) throw new Error('PDF 超过 10 页，请拆分。');
      if (await pdf.hasJSActions()) throw new Error('PDF 包含脚本动作。');
      if (Object.keys((await pdf.getAttachments()) || {}).length)
        throw new Error('PDF 包含嵌入附件，已拒绝。');
      for (let page = 1; page <= pdf.numPages; page++) {
        const p = await pdf.getPage(page),
          content = await p.getTextContent();
        const items = content.items.filter((i) => typeof i.str === 'string');
        let lines = [],
          current = '',
          lastY = null;
        for (const item of items) {
          const y = item.transform?.[5];
          if (lastY !== null && Math.abs(y - lastY) > 3 && current) {
            lines.push(current);
            current = '';
          }
          current += item.str + ' ';
          lastY = y;
          if (item.hasEOL) {
            lines.push(current);
            current = '';
          }
        }
        if (current) lines.push(current);
        const text = lines.join('\n').trim();
        if(textOnly){
          if(text.replace(/\s/g,'').length>=15){for(const line of lines)if(line.trim())add(line.trim(),{kind:'pdf',page},'pdf-text');}
          else{const viewport=p.getViewport({scale:Math.min(2,1600/Math.max(p.getViewport({scale:1}).width,p.getViewport({scale:1}).height))}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await p.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;const name='chat-page-'+page+'.jpg';await writeFile(join(directory,name),canvas.toBuffer('image/jpeg',80));previews.push({page,name});imagePages.push(page);add('',{kind:'pdf',page},'vision-required');}
          p.cleanup();continue;
        }
        const viewport = p.getViewport({
          scale: Math.min(
            3,
            4200 / Math.max(p.getViewport({ scale: 1 }).width, p.getViewport({ scale: 1 }).height),
          ),
        });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await p.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
        if (text.replace(/\s/g, '').length >= 15) {
          const name = 'preview-' + page + '.png';
          await writeFile(join(directory, name), canvas.toBuffer('image/png'));
          previews.push({ page, name });
          for (const line of lines)
            if (line.trim()) add(line.trim(), { kind: 'pdf', page }, 'pdf-text');
          imagePages.push(page);
          add(
            '',
            { kind: 'image', page, region: [0, 0, 1, 1], unit: 'normalized' },
            'vision-required',
          );
        } else await addImage(canvas.toBuffer('image/png'), page);
        p.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else await addImage(buffer, 1);
  if (!blocks.length) throw new Error('没有提取到可用文字或图像，请转换为清晰的 PDF 或图片。');
  if (blocks.reduce((n, b) => n + b.text.length, 0) > 100000)
    throw new Error('提取文本超过 10 万字符，请拆分订单。');
  return { format, blocks, previews, warnings: [...new Set(warnings)], imagePages };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const result = await parseFile(
      process.argv[2],
      process.argv[3],
      process.argv[4],
      process.argv[5],
      process.argv[6]==='chat-text-only',
    );
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, message: error instanceof Error ? error.message : '解析失败' }),
    );
    process.exitCode = 1;
  }
}
