// 原生环境和虚构单据冒烟；不读取业务库，不调用模型。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const speech = require('sherpa-onnx-node');
assert.equal(typeof speech.OfflineRecognizer, 'function');
const canvas = createCanvas(80, 40);
canvas.getContext('2d').fillText('虚构', 0, 20);
assert.ok(canvas.toBuffer('image/png').length);
const { defaultDocumentTemplates } = await import('../../shared/document-templates.ts');
const { sampleDocument } = await import('../../server/documents/sample.ts');
const { renderBusinessForm, checkDocumentFonts } = await import('../../server/documents/templates.ts');
checkDocumentFonts();
const dir = mkdtempSync(join(tmpdir(), 'erp-native-smoke-'));
const [purchase, delivery] = defaultDocumentTemplates().templates;
const matrix = [];
for (const [name, template, count] of [
  ['delivery-93', delivery, 6],
  ['delivery-140', { ...delivery, paper: 'continuous-241x140' }, 11],
  ['delivery-a5', { ...delivery, paper: 'a5' }, 11],
  ['purchase-a4', purchase, 24],
  ['purchase-wide', { ...purchase, orientation: 'landscape' }, 14],
]) {
  const form = sampleDocument(template);
  assert.equal(form.rowsPerPage, count);
  for (const format of ['docx', 'xlsx']) writeFileSync(join(dir, name + '.' + format), await renderBusinessForm(form, format));
  for (const field of ['name', 'notes']) {
    const index = form.columnKeys.indexOf(field);
    if (index < 0) continue;
    const long = { ...form, rows: [form.rows[0].map((v, i) => i === index ? '虚构长文字'.repeat(50) : v)] };
    for (const format of ['docx', 'xlsx']) await assert.rejects(renderBusinessForm(long, format), /内容过长/);
  }
  matrix.push({ name, rowsPerPage: form.rowsPerPage });
}
writeFileSync(join(dir, 'matrix.json'), JSON.stringify(matrix, null, 2));
console.log(JSON.stringify({ platform: process.platform, node: process.version, canvas: 'ok', speechNative: 'ok', optionalModels: 'not-required', matrix, directory: dir }, null, 2));
