// 原生环境和虚构单据冒烟；不读取业务库，不调用模型。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const canvas = createCanvas(80, 40);
canvas.getContext('2d').fillText('虚构', 0, 20);
assert.ok(canvas.toBuffer('image/png').length);
// 虚构样张、排版函数和几种纸张走单据导出的接口（server/documents/index.ts 的排版自检那几项）
const { checkDocumentFonts, layoutCases, renderBusinessForm, sampleDocument } = await import('../../server/documents/index.ts');
checkDocumentFonts();
const dir = mkdtempSync(join(tmpdir(), 'erp-native-smoke-'));
const matrix = [];
for (const { name, template, rowsPerPage: count } of layoutCases()) {
  const form = sampleDocument(template);
  assert.equal(form.rowsPerPage, count);
  for (const format of ['docx', 'xlsx']) writeFileSync(join(dir, name + '.' + format), await renderBusinessForm(form, format));
  for (const field of ['name', 'notes']) {
    const index = form.columnKeys.indexOf(field);
    if (index < 0) continue;
    // 行高能自动加高，A4 采购单 250 字也放得下；用 2500 字确认一整张纸放不下时会拒绝
    const long = { ...form, rows: [form.rows[0].map((v, i) => i === index ? '虚构长文字'.repeat(500) : v)] };
    for (const format of ['docx', 'xlsx']) await assert.rejects(renderBusinessForm(long, format), /内容过长|内容太长/);
  }
  matrix.push({ name, rowsPerPage: form.rowsPerPage });
}
writeFileSync(join(dir, 'matrix.json'), JSON.stringify(matrix, null, 2));
console.log(JSON.stringify({ platform: process.platform, node: process.version, canvas: 'ok', matrix, directory: dir }, null, 2));
