import { crc32 } from 'node:zlib';
import { createCanvas, PDFDocument, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { Workspace } from '../server/import/workspace-document.js';
/** 直接写进工作区库的一份工作区：给的几栏以外按刚上传、还没识别的填（和 WorkspaceStore.upload 写的一样） */
export function workspaceRecord(fields: Pick<Workspace, 'id' | 'fileHash' | 'revision'> & Partial<Workspace>): Workspace {
  return {
    fileName: '',
    size: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    parsed: { format: 'pdf' },
    draft: null,
    evaluation: null,
    changes: [],
    canUndo: false,
    history: [],
    audits: [],
    task: { state: 'uploaded' },
    mode: 'order',
    arrivalDocId: null,
    arrivalSourceId: null,
    promptVersion: 'fixture',
    ...fields,
  };
}
export function zipFixture(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name),
      data = Buffer.isBuffer(value) ? value : Buffer.from(value),
      crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(0x800, 6);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    locals.push(l, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const central = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
const fictionalRows = [
  '虚构验收订单（非真实客户文件）',
  '采购方：虚构验收客户甲；供应方：宁波甬勒包装制品有限公司',
  '采购订单号：TEST-20260901；订单日期：2026-09-01；交货日期：2026-09-04；人民币；含13%增值税',
  '纸箱A；规格300×200×150毫米；B楞；牛卡配纸；单色印刷；数量1000只；单价1.39元；金额1390.00元',
  '纸箱B；规格200×150×100毫米；E楞；白面纸；粘箱；数量2000只；单价0.73元；金额1460.00元',
  '数量合计3000只；金额合计2850.00元；备注：送货前电话确认',
];
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function xlsxFixture() {
  return zipFixture({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="虚构订单" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      fictionalRows
        .map(
          (s, i) =>
            `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${esc(s)}</t></is></c></row>`,
        )
        .join('') +
      '<row r="7"><c r="A7" t="inlineStr"><is><t>以下仅是小数精度测试注记，不属于订单产品明细</t></is></c><c r="B7"><v>1.2345</v></c><c r="C7"><f>B7*2</f><v>2.4690</v></c></row></sheetData></worksheet>',
  });
}
export function docxFixture() {
  return zipFixture({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      fictionalRows.map((s) => '<w:p><w:r><w:t>' + esc(s) + '</w:t></w:r></w:p>').join('') +
      '</w:body></w:document>',
  });
}
/** 画一张要几十毫秒，按格式只画一次，每次给一份副本 */
const images = new Map<boolean, Buffer>();
export function imageFixture(jpeg = false) {
  let image = images.get(jpeg);
  if (!image) {
    image = drawImage(jpeg);
    images.set(jpeg, image);
  }
  return Buffer.from(image);
}
function drawImage(jpeg: boolean) {
  const c = createCanvas(1800, 760),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'black';
  ctx.font = '31px "Microsoft YaHei"';
  fictionalRows.forEach((s, i) => ctx.fillText(s, 35, 65 + i * 105));
  return jpeg ? c.toBuffer('image/jpeg') : c.toBuffer('image/png');
}
/** PDF 页面的画布运行时能画图，但库的类型里 beginPage 交回的接口没写 drawImage：按方法在不在收窄 */
const canDraw = (ctx: object): ctx is SKRSContext2D => 'drawImage' in ctx;
export async function pdfFixture(scan = false) {
  if (!scan) {
    const lines = [
      'FICTIONAL TEST ORDER - NOT A REAL CUSTOMER',
      'Buyer: Fictional Customer A; Supplier: Yongle Packaging',
      'PO: TEST-20260901; Date: 2026-09-01; Delivery: 2026-09-04; CNY; VAT13% included',
      'Carton A 300x200x150mm; qty 1000; price 1.39; amount 1390.00',
      'Carton B 200x150x100mm; qty 2000; price 0.73; amount 1460.00',
      'Total quantity 3000; Total amount 2850.00',
    ];
    const stream =
      'BT /F1 12 Tf 30 750 Td ' +
      lines.map((s, i) => (i ? '0 -38 Td ' : '') + '(' + s + ') Tj').join('\n') +
      ' ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 850] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    ];
    let pdf = '%PDF-1.4\n',
      offsets = [0];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += i + 1 + ' 0 obj\n' + o + '\nendobj\n';
    });
    const start = Buffer.byteLength(pdf);
    pdf +=
      'xref\n0 6\n0000000000 65535 f \n' +
      offsets
        .slice(1)
        .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
        .join('') +
      'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n' +
      start +
      '\n%%EOF';
    return Buffer.from(pdf);
  }
  const pdf = new PDFDocument({ title: 'Fictional scan order' }),
    ctx = pdf.beginPage(1200, 850);
  const img = await loadImage(imageFixture());
  if (!canDraw(ctx)) throw new Error('PDF 页面上画不了图');
  ctx.drawImage(img, 0, 0, 1200, 507);
  pdf.endPage();
  return pdf.close();
}
