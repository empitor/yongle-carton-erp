// Windows 生成基准；Linux 逐格比较接受、缩字和拒绝边界。只生成虚构单据，不读业务数据。
// node --import tsx scripts/linux/verify-layout.mjs 输出.json [Windows基准.json]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
// 虚构样张、排版函数和几种纸张走单据导出的接口（server/documents/index.ts 的排版自检那几项）
import { checkDocumentFonts, layoutCases, renderBusinessForm, sampleDocument } from '../../server/documents/index.ts';
import yauzl from 'yauzl';
const output = process.argv[2];
assert.ok(output, '请指定矩阵输出路径');
checkDocumentFonts();
const documentXml = (buffer) => new Promise((resolve, reject) => {
  yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject);
    zip.on('entry', (entry) => {
      if (entry.fileName !== 'word/document.xml') return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('data', (b) => chunks.push(b));
        stream.on('error', reject);
        stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString()); });
      });
    });
    zip.readEntry();
  });
});
/** 渲染后改的那一格的字号（磅）；排不下被拒绝时是 null。 */
const cellPoints = async (form, index) => {
  try {
    const xml = await documentXml(await renderBusinessForm(form, 'docx'));
    const table = [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].map((m) => m[0]).find((t) => t.includes('<w:tblHeader/>'));
    const row = [...table.matchAll(/<w:tr[ >].*?<\/w:tr>/gs)][1][0];
    const cell = [...row.matchAll(/<w:tc>.*?<\/w:tc>/gs)][index][0];
    return Number(cell.match(/<w:sz w:val="(\d+)"\/>/)[1]) / 2;
  } catch (error) {
    assert.equal(error.code, 'document_layout_overflow');
    return null;
  }
};
const matrix = [];
for (const { name, template, rowsPerPage: count } of layoutCases()) {
  const base = sampleDocument(template);
  assert.equal(base.rowsPerPage, count);
  for (const field of ['name', 'notes', 'orderNumber']) {
    const index = base.columnKeys.indexOf(field);
    if (index < 0) continue;
    for (const token of ['虚构', 'W', 'il', '09', '测A-']) {
      for (const length of [1, 3, 5, 7, 9, 11, 14, 18, 24, 36, 60]) {
        const text = token.repeat(length);
        const form = { ...base, rows: [base.rows[0].map((v, i) => i === index ? text : v)] };
        matrix.push({ name, count, field, token, length, pt: await cellPoints(form, index) });
      }
    }
  }
}
writeFileSync(output, JSON.stringify({ platform: process.platform, matrix }, null, 2));
if (process.argv[3]) {
  const baseline = JSON.parse(readFileSync(process.argv[3], 'utf8')).matrix;
  assert.equal(matrix.length, baseline.length);
  for (const [i, linux] of matrix.entries()) {
    const windows = baseline[i];
    assert.deepEqual({ ...linux, pt: null }, { ...windows, pt: null });
    assert.ok(linux.pt === null || (windows.pt !== null && linux.pt <= windows.pt), 'Linux 比 Windows 更宽松：' + JSON.stringify({ linux, windows }));
  }
}
assert.ok(matrix.some((r) => r.pt === null));
assert.ok(matrix.some((r) => r.pt !== null && r.pt < 10));
console.log(JSON.stringify({ platform: process.platform, cases: matrix.length, rejected: matrix.filter((r) => r.pt === null).length, baselineCompared: !!process.argv[3] }));
