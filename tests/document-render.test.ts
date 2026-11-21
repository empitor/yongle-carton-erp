// 单据渲染（server/documents/render*.ts、layout.ts、apply-template.ts，shared/documents）：纸张、联次、固定版式、
// 缩字号和变高、放不下时的提示、合计行、套模板。纯渲染，不建库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { uppercaseAmount } from '../shared/core/display-amount.js';
import { defaultDocumentTemplates, templateSchema, templatePaper } from '../shared/documents/document-templates.js';
import { packInfo, splitFields } from '../shared/documents/document-layout.js';
import { sampleDocument } from '../server/documents/sample.js';
import { documentRowsPerPage } from '../server/documents/layout.js';
import { layoutCases } from '../server/documents/layout-check.js';
import { renderBusinessForm } from '../server/documents/render.js';
import { AppError } from '../server/core/errors.js';
import { allRows, wordXml, zipEntries } from './document-fixture.js';

const templates = defaultDocumentTemplates().templates;
/** 出厂默认模板里这一类的那一份 */
function defaultTemplate(kind: 'purchase' | 'delivery') {
  const template = templates.find((t) => t.kind === kind);
  assert.ok(template, '出厂默认有' + kind + '模板');
  return template;
}
const purchase = defaultTemplate('purchase'),
  delivery = defaultTemplate('delivery');

/** 文字里按规则取出的第一组数字；取不到就报错 */
function numberIn(text: string, pattern: RegExp) {
  const m = pattern.exec(text);
  assert.ok(m, '找不到 ' + String(pattern));
  return Number(m[1]);
}

const pageSize = (xml: string) => {
  const m = xml.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/);
  assert.ok(m, 'Word 里有纸张大小');
  return [Math.round(Number(m[1]) / 56.6929), Math.round(Number(m[2]) / 56.6929)];
};
/** Excel 读进来的第一张表 */
async function firstSheet(bytes: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.read(Readable.from([bytes]));
  return book.worksheets[0];
}
/** 每张行数：样张都算好了 */
function rowsPerPageOf(form: { rowsPerPage?: number }) {
  assert.ok(form.rowsPerPage !== undefined, '样张算好了每张行数');
  return form.rowsPerPage;
}

// 只在目标明细单元格中检查字号，避免命中页眉、页脚的小字号。
const detailTables = (xml: string) =>
  [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)]
    .map((m) => m[0])
    .filter((t) => t.includes('<w:tblHeader/>'));

const wordRows = (table: string) => [...table.matchAll(/<w:tr[ >].*?<\/w:tr>/gs)].map((m) => m[0]);

const wordCells = (row: string) => [...row.matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((m) => m[0]);

const cellTexts = (row: string) =>
  wordCells(row).map((cell) =>
    [...cell.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)].map((m) => m[1]).join(''),
  );


test('大写金额只写到分，分以下有数或负数时不出大写、不四舍五入', () => {
  assert.equal(uppercaseAmount('1,334.50'), '壹仟叁佰叁拾肆元伍角整');
  assert.equal(uppercaseAmount('100100.3'), '壹拾万零壹佰元叁角整');
  assert.equal(uppercaseAmount('100000001'), '壹亿零壹元整');
  assert.equal(uppercaseAmount('1.05'), '壹元零伍分');
  assert.equal(uppercaseAmount('0.05'), '伍分');
  assert.equal(uppercaseAmount('0'), '零元整');
  assert.equal(uppercaseAmount('20000000.00'), '贰仟万元整');
  assert.equal(uppercaseAmount('1234.5678'), null);
  assert.equal(uppercaseAmount('-5'), null);
  assert.equal(uppercaseAmount('单价待定'), null);
});

test('信息格保持字段顺序，地址占两格，单号日期和条款不进信息格', () => {
  const { number, date, terms, info } = splitFields({
    number: 'X',
    draft: false,
    fields: [
      ['采购单号', 'PO-1'],
      ['供应商', '虚构供应商'],
      ['下单日期', '2026-11-01'],
      ['交货地址', '虚构地址'],
      ['预计交货日期', '2026-11-05'],
      ['付款条件', '虚构条件'],
    ],
  });
  assert.equal(number, 'PO-1');
  assert.deepEqual(date, ['下单日期', '2026-11-01']);
  assert.deepEqual(terms, [['付款条件', '虚构条件']]);
  assert.deepEqual(
    packInfo(info, 2).map((r) => r.map((i) => i.k + i.slots)),
    [['供应商1', '预计交货日期1'], ['交货地址2']],
  );
  assert.deepEqual(
    packInfo(info, 3).map((r) => r.map((i) => i.k + i.slots)),
    [['供应商1', '交货地址2'], ['预计交货日期3']],
  );
});

test('送货单没选纸张按针式三等分出 Word，默认带联次竖排、清空就不印；二等分和 A5 尺寸正确', async () => {
  for (const [paper, size] of [
    [undefined, [241, 93]],
    ['continuous-241x140', [241, 140]],
    ['a5', [210, 148]],
  ] as const) {
    const parts = await zipEntries(
      await renderBusinessForm(sampleDocument({ ...delivery, paper }), 'docx'),
    );
    for (const xml of parts.values()) assert.equal(SyntaxValidator.validate(xml), true);
    const xml = parts.get('word/document.xml');
    assert.ok(xml);
    assert.deepEqual(pageSize(xml), size);
    assert.match(xml, /TEST-DN-001/);
    assert.match(xml, /本批送货数量/);
    const header = [...parts].find(([k, v]) => k.startsWith('word/header') && /tbRl/.test(v));
    assert.ok(header, '联次说明应在页眉的竖排浮动表格里');
    assert.match(header[1], /第一联 存根/);
  }
  const plain = await zipEntries(
    await renderBusinessForm(sampleDocument({ ...delivery, copyLabels: '' }), 'docx'),
  );
  assert.equal(
    [...plain.values()].some((v) => /第一联/.test(v)),
    false,
  );
});

test('采购单 A4 出大写合计；单价待定时合计写“单价待定”、不出大写；标题保留原文便于搜索', async () => {
  const xml = await wordXml(await renderBusinessForm(sampleDocument(purchase), 'docx'));
  assert.deepEqual(pageSize(xml), [210, 297]);
  assert.match(xml, /采购订货单/);
  assert.match(xml, /合计金额（大写）：壹仟叁佰叁拾肆元伍角整/);
  assert.match(xml, /1,334\.50/);
  assert.match(xml, /税费说明/);
  const pending = await wordXml(
    await renderBusinessForm({ ...sampleDocument({ ...purchase, orientation: 'landscape' }), total: null }, 'docx'),
  );
  assert.deepEqual(pageSize(pending), [297, 210]);
  assert.match(pending, /单价待定/);
  assert.doesNotMatch(pending, /待核价/);
  assert.doesNotMatch(pending, /大写/);
});

test('Excel 按纸张设置纸型：A4、A5 写标准纸型，针式联单交给打印机默认纸', async () => {
  for (const [template, paperSize, orientation] of [
    [purchase, 9, 'portrait'],
    [{ ...delivery, paper: 'a5' as const }, 11, 'landscape'],
    [delivery, undefined, 'portrait'],
  ] as const) {
    const sheet = await firstSheet(await renderBusinessForm(sampleDocument(template), 'xlsx'));
    assert.equal(sheet.pageSetup.paperSize, paperSize);
    assert.equal(sheet.pageSetup.orientation, orientation);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    const text = JSON.stringify(sheet.getSheetValues());
    assert.match(text, /No\. TEST-/);
    if (template.kind === 'purchase') assert.match(text, /壹仟叁佰叁拾肆元伍角整/);
    else assert.match(text, /第一联 存根/);
  }
});

test('固定版式：每张行数固定，超出一张续页、最后一张补空行，每张重复抬头，合计只在最后一张', async () => {
  for (const template of [purchase, delivery]) {
    const base = sampleDocument(template),
      N = rowsPerPageOf(base);
    assert.ok(N >= 3, '每张至少放得下 3 行明细');
    const withRows = (n: number) => ({
      ...base,
      rows: Array.from({ length: n }, (_, i) =>
        base.rows[i % 2].map((v, j) => (j ? v : String(i + 1))),
      ),
    });
    for (const [n, sheets] of [
      [N, 1],
      [N + 1, 2],
    ] as const) {
      const xml = await wordXml(await renderBusinessForm(withRows(n), 'docx'));
      assert.equal((xml.match(/<w:pageBreakBefore\/>/g) || []).length, sheets - 1);
      // 每张一张明细表：表头行数 = 张数；明细行数（含空行）= 张数 × N
      assert.equal((xml.match(/<w:tblHeader\/>/g) || []).length, sheets);
      assert.equal((xml.match(/TEST-[DP][NO]-001/g) || []).length, sheets);
      const tables = detailTables(xml);
      const indexes: string[] = [];
      for (const [page, table] of tables.entries()) {
        const rows = wordRows(table);
        assert.equal(rows.length, 1 + N + 1 + (base.total !== undefined ? 1 : 0));
        const data = rows.slice(1, N + 1);
        const filled = Math.max(0, Math.min(N, n - page * N));
        assert.equal(data.filter((r) => cellTexts(r).some(Boolean)).length, filled);
        assert.ok(
          data.slice(filled).every((r) => cellTexts(r).every((v) => !v)),
          '最后一张空行全部补满',
        );
        indexes.push(...data.slice(0, filled).map((r) => cellTexts(r)[0]));
      }
      assert.deepEqual(
        indexes,
        Array.from({ length: n }, (_, i) => String(i + 1)),
      );
      if (template.kind === 'purchase') {
        assert.equal((xml.match(/壹仟叁佰叁拾肆元伍角整/g) || []).length, 1);
        assert.equal((xml.match(/见最后一张/g) || []).length, sheets - 1);
      }
      const xlsx = await renderBusinessForm(withRows(n), 'xlsx');
      const sheet = await firstSheet(xlsx),
        headers = allRows(sheet).filter((r) => r.getCell(2).value === '产品名称');
      assert.equal(headers.length, sheets);
      const sheetXml = (await zipEntries(xlsx)).get('xl/worksheets/sheet1.xml');
      assert.ok(sheetXml);
      assert.equal((sheetXml.match(/<brk /g) || []).length, sheets - 1);
      const excelIndexes = headers.flatMap((header, page) =>
        excelPage(sheet, header, { N, filled: Math.max(0, Math.min(N, n - page * N)), width: base.headers.length, total: base.total !== undefined }),
      );
      assert.deepEqual(excelIndexes, indexes);
      // 两张表头之间正好隔一整张：固定行数
      if (sheets === 2) {
        const first = headers[0].number,
          second = headers[1].number;
        assert.equal(sheet.getRow(first + N).getCell(1).value, N, '第一张最后一行明细是第 N 行');
        assert.equal(sheet.getRow(second + 1).getCell(1).value, N + 1);
      }
    }
  }
});

/** Excel 的一张：表头下前 filled 行是明细（返回序号），其余是整行空的补行；明细后（有合计再隔一行）是备注 */
function excelPage(sheet: ExcelJS.Worksheet, header: ExcelJS.Row, o: { N: number; filled: number; width: number; total: boolean }) {
  const indexes: string[] = [];
  for (let i = 1; i <= o.N; i++) {
    const row = sheet.getRow(header.number + i);
    if (i <= o.filled) indexes.push(String(row.getCell(1).value));
    else for (let c = 1; c <= o.width; c++) assert.equal(row.getCell(c).value, '');
  }
  assert.equal(sheet.getRow(header.number + o.N + 1 + (o.total ? 1 : 0)).getCell(1).value, '备注');
  return indexes;
}

/** Excel 样式表里用到的几项：单元格样式引用的字体、各字体的字号（属性原样是文字） */
const excelStyles = z.object({
  styleSheet: z.object({
    cellXfs: z.object({ xf: z.array(z.looseObject({ '@_fontId': z.string() })) }),
    fonts: z.object({ font: z.array(z.looseObject({ sz: z.looseObject({ '@_val': z.string() }).optional() })) }),
  }),
});

test('长明细只缩小目标单元格的字号，Word和Excel使用相同字号与固定高度', async () => {
  const base = sampleDocument(delivery);
  for (const long of ['虚构需缩字号名称', 'W'.repeat(10)]) {
    const form = { ...base, rows: [base.rows[0].map((v, j) => (j === 1 ? long : v))] };
    const xml = await wordXml(await renderBusinessForm(form, 'docx'));
    const row = wordRows(detailTables(xml)[0])[1],
      cells = wordCells(row),
      target = cells[1];
    assert.equal(cellTexts(row)[1], long);
    const targetPt = numberIn(target, /<w:sz w:val="(\d+)"\/>/) / 2,
      fontSize = base.fontSize;
    assert.ok(fontSize !== undefined);
    assert.ok(
      targetPt >= 7 && targetPt < fontSize,
      '目标名称必须实际缩字，禁用缩字时本断言必须失败',
    );
    assert.equal(numberIn(cells[0], /<w:sz w:val="(\d+)"\/>/) / 2, base.fontSize);
    assert.match(row, /w:hRule="exact"/);
    const excelBytes = await renderBusinessForm(form, 'xlsx');
    const data = allRows(await firstSheet(excelBytes)).find((r) => r.getCell(2).value === long);
    assert.ok(data);
    // ExcelJS 读取字号时会截去 .5，直接核对文件中目标单元格引用的字体。
    const parts = await zipEntries(excelBytes),
      parser = new XMLParser({ ignoreAttributes: false });
    const stylesXml = parts.get('xl/styles.xml'),
      sheetXml = parts.get('xl/worksheets/sheet1.xml');
    assert.ok(stylesXml && sheetXml);
    const styles = excelStyles.parse(parser.parse(stylesXml)).styleSheet;
    const cellStyle = numberIn(sheetXml, new RegExp(`<c r="${data.getCell(2).address}" s="(\\d+)"`));
    const fontId = Number(styles.cellXfs.xf[cellStyle]['@_fontId']);
    assert.equal(Number(styles.fonts.font[fontId].sz?.['@_val']), targetPt);
    assert.equal(data.getCell(1).font.size, base.fontSize);
    assert.ok(
      Math.abs(data.height - numberIn(row, /w:trHeight[^>]*w:val="(\d+)"/) / 20) < 0.03,
    );
  }
});

test('放得下时同一模板行数不随联系信息、地址、备注、日期、单号、草稿和合计内容改变', () => {
  for (const template of [
    delivery,
    { ...delivery, paper: 'continuous-241x140' as const },
    { ...delivery, paper: 'a5' as const },
    purchase,
    { ...purchase, orientation: 'landscape' as const },
  ]) {
    const base = sampleDocument(template),
      N = base.rowsPerPage;
    for (const notes of ['', '虚构备注'.repeat(10)]) {
      const changed = {
        ...base,
        notes,
        draft: false,
        sample: false,
        number: 'TEST-OTHER',
        total: null,
        fields: base.fields
          .filter(([k]) => k !== '客户联系信息')
          .map(([k, v]) => [k, k.includes('地址') ? '虚构地址'.repeat(4) : v] as [string, string]),
        rowsPerPage: 1,
      };
      assert.equal(documentRowsPerPage(changed), N);
    }
  }
});

test('最小字号仍放不下时，那一块变高、这张单据每张少放几行，内容完整，两种格式都能导出', async () => {
  for (const template of [delivery, purchase]) {
    const base = sampleDocument(template),
      N = rowsPerPageOf(base);
    const cases = [
      // 送货单默认是 241×93 的小联单，名称写得太长一张也放不下；这里用两种纸都能变高放下的长度
      { ...base, rows: [base.rows[0], base.rows[1].map((v, j) => (j === 1 ? '虚构长文字'.repeat(template === purchase ? 24 : 8) : v))] },
      { ...base, notes: '虚构备注'.repeat(template === purchase ? 75 : 45) },
      {
        ...base,
        fields: base.fields.map(([k, v]) => [k, /联系信息/.test(k) ? '虚构联系人'.repeat(template === purchase ? 50 : 16) : v] as [string, string]),
      },
      {
        ...base,
        fields: base.fields.map(([k, v]) => [k, /地址/.test(k) ? '虚构地址'.repeat(template === purchase ? 60 : 20) : v] as [string, string]),
      },
    ];
    for (const form of cases) {
      const n = documentRowsPerPage(form);
      assert.ok(n >= 1 && n <= N, '本单每张行数 ' + n + '，模板默认 ' + N);
    }
    // 变高以后照样排得出来
    for (const format of ['docx', 'xlsx'] as const) assert.ok((await renderBusinessForm(cases[0], format)).length > 0);
    if (template === purchase) assert.ok(documentRowsPerPage(cases[1]) < N, '备注很长时这张单据每张少放几行');
  }
});

test('一整张纸都放不下才拒绝导出，提示单号、明细行号或字段和建议', async () => {
  const base = sampleDocument(delivery);
  const cases = [
    {
      form: { ...base, rows: [base.rows[0], base.rows[1].map((v, j) => (j === 1 ? '虚构长文字'.repeat(400) : v))] },
      field: /第 2 行明细“产品名称”/,
    },
    { form: { ...base, notes: '虚构备注'.repeat(1500) }, field: /“备注”/ },
    {
      form: {
        ...base,
        fields: base.fields.map(([k, v]) => [k, k === '收货地址' ? '虚构地址'.repeat(400) : v] as [string, string]),
      },
      field: /“收货地址”/,
    },
  ];
  for (const { form, field } of cases)
    for (const format of ['docx', 'xlsx'] as const)
      await assert.rejects(renderBusinessForm(form, format), (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, 'document_layout_overflow');
        assert.equal(e.status, 400);
        assert.match(e.message, /TEST-DN-001/);
        assert.match(e.message, field);
        assert.match(e.message, /一整张纸也放不下/);
        assert.match(e.message, /缩短内容或换更大的纸张/);
        return true;
      });
});

test('合计独占整行：金额列在第一、第二、末尾和隐藏时均完整且只在最后一张出现', async () => {
  for (const columns of [
    ['amount', 'index', 'name', 'quantity', 'unit'],
    ['index', 'amount', 'name', 'quantity', 'unit'],
    ['index', 'name', 'quantity', 'unit', 'amount'],
    ['index', 'name', 'quantity', 'unit'],
  ]) {
    const base = sampleDocument(templateSchema.parse({ ...purchase, columns }));
    const form = {
      ...base,
      rows: Array.from({ length: rowsPerPageOf(base) + 1 }, (_, i) =>
        base.rows[i % 2].map((v, j) => (columns[j] === 'index' ? String(i + 1) : v)),
      ),
    };
    const xml = await wordXml(await renderBusinessForm(form, 'docx'));
    const tables = detailTables(xml);
    for (const [i, table] of tables.entries()) {
      const row = wordRows(table).at(-2);
      assert.ok(row, '合计行');
      const text = cellTexts(row).join('');
      assert.equal(wordCells(row).length, 1);
      assert.match(row, new RegExp(`w:gridSpan w:val="${columns.length}"`));
      assert.match(row, /w:hRule="exact"/);
      if (i === tables.length - 1) {
        assert.match(text, /壹仟叁佰叁拾肆元伍角整/);
        assert.match(text, /1,334\.50/);
      } else {
        assert.match(text, /见最后一张/);
        assert.doesNotMatch(text, /1,334|大写/);
      }
    }
    const sheet = await firstSheet(await renderBusinessForm(form, 'xlsx')),
      rows = allRows(sheet).filter((r) => String(r.getCell(1).value).startsWith('合计金额'));
    assert.equal(rows.length, 2);
    assert.match(String(rows[0].getCell(1).value), /见最后一张/);
    assert.match(String(rows[1].getCell(1).value), /壹仟叁佰叁拾肆元伍角整.*1,334\.50/);
    assert.equal(
      sheet.getCell(rows[1].number, columns.length).master.address,
      rows[1].getCell(1).address,
    );
  }
});

test('默认模板：送货单针式三等分、订货单 A4 竖版；排版自检的每种版式每张行数和样张一致', () => {
  assert.equal(templatePaper(delivery), 'continuous-241x93');
  assert.equal(delivery.orientation, 'landscape');
  assert.equal(templatePaper(purchase), 'a4');
  assert.equal(purchase.orientation, 'portrait');
  // Linux 部署自检（scripts/linux/verify-layout.mjs）按 layoutCases 核对排版，数字只写在那里
  for (const c of layoutCases()) assert.equal(sampleDocument(c.template).rowsPerPage, c.rowsPerPage, c.name);
});

test('套模板直接调用：按模板的列和顺序重排明细，隐藏的信息格不印，我方资料和条款补进信息格，算出每张行数', async () => {
  const { applyDocumentTemplate } = await import('../server/documents/apply-template.js');
  const [purchase] = defaultDocumentTemplates().templates;
  const template = {
    ...purchase,
    columns: ['name', 'quantity', 'unit'] as typeof purchase.columns,
    hiddenFields: ['供应商联系信息'] as typeof purchase.hiddenFields,
    companyContact: '虚构联系人',
    paymentTerms: '虚构月结',
  };
  const form = applyDocumentTemplate(
    {
      title: '采购订货单',
      number: 'XG-001',
      draft: false,
      fields: [
        ['采购单号', 'XG-001'],
        ['供应商', '虚构纸板厂'],
        ['供应商联系信息', '虚构电话'],
      ],
      headers: [],
      columnKeys: ['index', 'name', 'unit', 'quantity'],
      rows: [['1', '虚构纸板', '张', '100']],
      notes: '',
      signatures: ['制单人'],
    },
    template,
    7,
  );
  assert.deepEqual(form.rows, [['虚构纸板', '100', '张']]);
  assert.equal(form.headers.length, 3);
  assert.equal(form.headers[1], '订购数量');
  assert.equal(form.fields.some(([k]) => k === '供应商联系信息'), false);
  assert.ok(form.fields.some(([k, v]) => k === '我方联系人' && v === '虚构联系人'));
  assert.ok(form.fields.some(([k, v]) => k === '付款条件' && v === '虚构月结'));
  assert.equal(form.templateRevision, 7);
  assert.equal(form.rowsPerPage, documentRowsPerPage(form));
});
