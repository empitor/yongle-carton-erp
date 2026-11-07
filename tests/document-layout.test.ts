import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { uppercaseAmount } from '../shared/display-amount.js';
import {
  defaultDocumentTemplates,
  normalizeTemplateState,
  templateSchema,
  templatePaper,
  templateCopyLabels,
  defaultCopyLabels,
  purchaseColumns,
  deliveryColumns,
  templateColumnsAreDefault,
  resetTemplateColumns,
  templateSettingsSchema,
} from '../shared/document-templates.js';
import { packInfo, splitFields } from '../shared/document-layout.js';
import { sampleDocument } from '../server/documents/sample.js';
import { documentRowsPerPage, renderBusinessForm } from '../server/documents/templates.js';

function zipEntries(bytes: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const result = new Map<string, string>();
      zip.on('error', reject);
      zip.on('end', () => resolve(result));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            if (entry.fileName.endsWith('.xml'))
              result.set(entry.fileName, Buffer.concat(chunks).toString());
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    }),
  );
}
const templates = defaultDocumentTemplates().templates,
  purchase = templates.find((t) => t.kind === 'purchase')!,
  delivery = templates.find((t) => t.kind === 'delivery')!;
const pageSize = (xml: string) => {
  const m = xml.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/)!;
  return [Math.round(Number(m[1]) / 56.6929), Math.round(Number(m[2]) / 56.6929)];
};

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
  assert.equal(uppercaseAmount('待核价'), null);
});

test('老模板没有纸张、联次、商标字段时按单据类型补默认，清空联次后不再补', () => {
  const legacy = normalizeTemplateState({
    revision: 3,
    templates: templates.map(({ paper: _p, copyLabels: _c, showLogo: _s, ...t }) => t),
  });
  const [p, d] = ['purchase', 'delivery'].map((k) => legacy.templates.find((t) => t.kind === k)!);
  assert.equal(templatePaper(p), 'a4');
  assert.equal(templatePaper(d), 'continuous-241x140');
  assert.equal(templateCopyLabels(p), '');
  assert.equal(templateCopyLabels(d), defaultCopyLabels);
  assert.equal(templateCopyLabels({ ...d, copyLabels: '' }), '');
  assert.equal(p.showLogo && d.showLogo, true);
  assert.equal(templateSchema.safeParse({ ...d, paper: 'b5' }).success, false);
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

test('送货单默认按 241×140 针式二等分出 Word，带联次竖排；三等分和 A5 尺寸正确', async () => {
  for (const [paper, size] of [
    [undefined, [241, 140]],
    ['continuous-241x93', [241, 93]],
    ['a5', [210, 148]],
  ] as const) {
    const parts = await zipEntries(
      await renderBusinessForm(sampleDocument({ ...delivery, paper }), 'docx'),
    );
    for (const xml of parts.values()) assert.equal(XMLValidator.validate(xml), true);
    const xml = parts.get('word/document.xml')!;
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

test('采购单 A4 出大写合计；待核价不出大写；标题保留原文便于搜索', async () => {
  const xml = (await zipEntries(await renderBusinessForm(sampleDocument(purchase), 'docx'))).get(
    'word/document.xml',
  )!;
  assert.deepEqual(pageSize(xml), [210, 297]);
  assert.match(xml, /采购订货单/);
  assert.match(xml, /合计金额（大写）：壹仟叁佰叁拾肆元伍角整/);
  assert.match(xml, /1,334\.50/);
  assert.match(xml, /税费说明/);
  const pending = (
    await zipEntries(
      await renderBusinessForm(
        { ...sampleDocument({ ...purchase, orientation: 'landscape' }), total: null },
        'docx',
      ),
    )
  ).get('word/document.xml')!;
  assert.deepEqual(pageSize(pending), [297, 210]);
  assert.match(pending, /待核价/);
  assert.doesNotMatch(pending, /大写/);
});

test('Excel 按纸张设置纸型：A4、A5 写标准纸型，针式联单交给打印机默认纸', async () => {
  for (const [template, paperSize, orientation] of [
    [purchase, 9, 'portrait'],
    [{ ...delivery, paper: 'a5' as const }, 11, 'landscape'],
    [delivery, undefined, 'portrait'],
  ] as const) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderBusinessForm(sampleDocument(template), 'xlsx')) as any);
    const sheet = book.worksheets[0];
    assert.equal(sheet.pageSetup.paperSize, paperSize);
    assert.equal(sheet.pageSetup.orientation, orientation);
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    const text = JSON.stringify(sheet.getSheetValues());
    assert.match(text, /No\. TEST-/);
    if (template.kind === 'purchase') assert.match(text, /壹仟叁佰叁拾肆元伍角整/);
    else assert.match(text, /第一联 存根/);
  }
});

test('固定版式：每张行数固定，货少留空行，超出一张续页，每张重复抬头，合计只在最后一张', async () => {
  for (const template of [
    purchase,
    delivery,
    { ...delivery, paper: 'continuous-241x140' as const },
    { ...delivery, paper: 'a5' as const },
    { ...purchase, orientation: 'landscape' as const },
  ]) {
    const base = sampleDocument(template),
      N = base.rowsPerPage!;
    assert.ok(N >= 3, '每张至少放得下 3 行明细');
    const withRows = (n: number) => ({
      ...base,
      rows: Array.from({ length: n }, (_, i) =>
        base.rows[i % 2].map((v, j) => (j ? v : String(i + 1))),
      ),
    });
    for (const [n, sheets] of [
      [0, 1],
      [2, 1],
      [N, 1],
      [N + 1, 2],
    ] as const) {
      const xml = (await zipEntries(await renderBusinessForm(withRows(n), 'docx'))).get(
        'word/document.xml',
      )!;
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
      const book = new ExcelJS.Workbook();
      await book.xlsx.load((await renderBusinessForm(withRows(n), 'xlsx')) as any);
      const sheet = book.worksheets[0],
        headers = sheet
          .getRows(1, sheet.rowCount)!
          .filter((r) => r.getCell(2).value === '产品名称');
      assert.equal(headers.length, sheets);
      const sheetXml = (await zipEntries(await renderBusinessForm(withRows(n), 'xlsx'))).get(
        'xl/worksheets/sheet1.xml',
      )!;
      assert.equal((sheetXml.match(/<brk /g) || []).length, sheets - 1);
      const excelIndexes: string[] = [];
      for (const [page, header] of headers.entries()) {
        const filled = Math.max(0, Math.min(N, n - page * N));
        for (let i = 1; i <= N; i++) {
          const row = sheet.getRow(header.number + i);
          if (i <= filled) excelIndexes.push(String(row.getCell(1).value));
          else
            for (let c = 1; c <= base.headers.length; c++) assert.equal(row.getCell(c).value, '');
        }
        assert.equal(
          sheet.getRow(header.number + N + 1 + (base.total !== undefined ? 1 : 0)).getCell(1).value,
          '备注',
        );
      }
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

test('长明细只缩小目标单元格的字号，Word和Excel使用相同字号与固定高度', async () => {
  const base = sampleDocument(delivery);
  for (const long of ['虚构需缩字号名称', 'W'.repeat(10)]) {
    const form = { ...base, rows: [base.rows[0].map((v, j) => (j === 1 ? long : v))] };
    const xml = (await zipEntries(await renderBusinessForm(form, 'docx'))).get(
      'word/document.xml',
    )!;
    const row = wordRows(detailTables(xml)[0])[1],
      cells = wordCells(row),
      target = cells[1];
    assert.equal(cellTexts(row)[1], long);
    const targetPt = Number(target.match(/<w:sz w:val="(\d+)"\/>/)![1]) / 2;
    assert.ok(
      targetPt >= 7 && targetPt < base.fontSize!,
      '目标名称必须实际缩字，禁用缩字时本断言必须失败',
    );
    assert.equal(Number(cells[0].match(/<w:sz w:val="(\d+)"\/>/)![1]) / 2, base.fontSize);
    assert.match(row, /w:hRule="exact"/);
    const book = new ExcelJS.Workbook();
    const excelBytes = await renderBusinessForm(form, 'xlsx');
    await book.xlsx.load(excelBytes as any);
    const sheet = book.worksheets[0],
      data = sheet.getRows(1, sheet.rowCount)!.find((r) => r.getCell(2).value === long)!;
    // ExcelJS 读取字号时会截去 .5，直接核对文件中目标单元格引用的字体。
    const parts = await zipEntries(excelBytes),
      parser = new XMLParser({ ignoreAttributes: false });
    const styles = parser.parse(parts.get('xl/styles.xml')!).styleSheet;
    const cellStyle = Number(
      parts
        .get('xl/worksheets/sheet1.xml')!
        .match(new RegExp(`<c r="${data.getCell(2).address}" s="(\\d+)"`))![1],
    );
    const fontId = Number(styles.cellXfs.xf[cellStyle]['@_fontId']);
    assert.equal(Number(styles.fonts.font[fontId].sz['@_val']), targetPt);
    assert.equal(data.getCell(1).font.size, base.fontSize);
    assert.ok(
      Math.abs(data.height! - Number(row.match(/w:trHeight[^>]*w:val="(\d+)"/)![1]) / 20) < 0.03,
    );
  }
});

test('同一模板行数不随联系信息、地址、备注、日期、单号、草稿和合计内容改变', async () => {
  for (const template of [
    delivery,
    { ...delivery, paper: 'continuous-241x140' as const },
    { ...delivery, paper: 'a5' as const },
    purchase,
    { ...purchase, orientation: 'landscape' as const },
  ]) {
    const base = sampleDocument(template),
      N = base.rowsPerPage;
    for (const notes of ['', '虚构备注'.repeat(25), '虚构备注'.repeat(75)]) {
      const changed = {
        ...base,
        notes,
        draft: false,
        sample: false,
        number: 'TEST-OTHER',
        total: null,
        fields: base.fields
          .filter(([k]) => k !== '客户联系信息')
          .map(([k, v]) => [k, k.includes('地址') ? '虚构地址'.repeat(30) : v] as [string, string]),
        rowsPerPage: 1,
      };
      assert.equal(documentRowsPerPage(changed), N);
    }
  }
  const base = sampleDocument(delivery),
    form = { ...base, notes: '虚构备注'.repeat(25) };
  for (const format of ['docx', 'xlsx'] as const)
    assert.ok((await renderBusinessForm(form, format)).length > 0);
  assert.ok(base.fields.some(([k]) => k === '客户联系信息'));
});

test('最小字号仍放不下时，两种格式返回带单号、明细行号、字段和建议的中文错误', async () => {
  const base = sampleDocument(delivery);
  const cases = [
    {
      form: {
        ...base,
        rows: [base.rows[0], base.rows[1].map((v, j) => (j === 1 ? '虚构长文字'.repeat(24) : v))],
      },
      field: /第 2 行明细“产品名称”/,
    },
    { form: { ...base, notes: '虚构备注'.repeat(75) }, field: /“备注”/ },
    {
      form: {
        ...base,
        fields: base.fields.map(
          ([k, v]) => [k, k === '客户联系信息' ? '虚构联系人'.repeat(50) : v] as [string, string],
        ),
      },
      field: /“客户联系信息”/,
    },
    {
      form: {
        ...base,
        fields: base.fields.map(
          ([k, v]) => [k, k === '收货地址' ? '虚构地址'.repeat(100) : v] as [string, string],
        ),
      },
      field: /“收货地址”/,
    },
  ];
  for (const { form, field } of cases)
    for (const format of ['docx', 'xlsx'] as const)
      await assert.rejects(renderBusinessForm(form, format), (e: any) => {
        assert.equal(e.code, 'document_layout_overflow');
        assert.equal(e.status, 400);
        assert.match(e.message, /TEST-DN-001/);
        assert.match(e.message, field);
        assert.match(e.message, /最小 7 磅/);
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
      rows: Array.from({ length: base.rowsPerPage! + 1 }, (_, i) =>
        base.rows[i % 2].map((v, j) => (columns[j] === 'index' ? String(i + 1) : v)),
      ),
    };
    const xml = (await zipEntries(await renderBusinessForm(form, 'docx'))).get(
      'word/document.xml',
    )!;
    const tables = detailTables(xml);
    for (const [i, table] of tables.entries()) {
      const row = wordRows(table).at(-2)!,
        text = cellTexts(row).join('');
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
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderBusinessForm(form, 'xlsx')) as any);
    const sheet = book.worksheets[0],
      rows = sheet
        .getRows(1, sheet.rowCount)!
        .filter((r) => String(r.getCell(1).value).startsWith('合计金额'));
    assert.equal(rows.length, 2);
    assert.match(String(rows[0].getCell(1).value), /见最后一张/);
    assert.match(String(rows[1].getCell(1).value), /壹仟叁佰叁拾肆元伍角整.*1,334\.50/);
    assert.equal(
      sheet.getCell(rows[1].number, columns.length).master.address,
      rows[1].getCell(1).address,
    );
  }
});

test('默认模板：送货单针式三等分每张 6 行，订货单 A4 竖版每张 24 行；送货单方向不变', () => {
  assert.equal(templatePaper(delivery), 'continuous-241x93');
  assert.equal(delivery.orientation, 'landscape');
  assert.equal(sampleDocument(delivery).rowsPerPage, 6);
  assert.equal(templatePaper(purchase), 'a4');
  assert.equal(purchase.orientation, 'portrait');
  assert.equal(sampleDocument(purchase).rowsPerPage, 24);
});

test('已保存的老模板读进来不受新默认值影响：没写纸张的送货单仍按 241×140，订货单仍是保存时的横版', () => {
  // 0.8.0 及以前保存的模板：没有 paper / copyLabels / showLogo，orientation 按当时默认存成 landscape。
  const saved = normalizeTemplateState({
    revision: 5,
    templates: [
      {
        id: 'purchase-default',
        kind: 'purchase',
        name: '标准采购订货单',
        companyName: '虚构样式工厂',
        title: '采购订货单',
        footerNotes: '',
        color: 'E8EEF0',
        fontSize: 10,
        orientation: 'landscape',
        defaultFormat: 'docx',
        signatures: ['制单人'],
      },
      {
        id: 'delivery-default',
        kind: 'delivery',
        name: '标准送货单',
        companyName: '虚构样式工厂',
        title: '送货单',
        footerNotes: '',
        color: 'E8EEF0',
        fontSize: 10,
        orientation: 'landscape',
        defaultFormat: 'docx',
        signatures: ['送货人签字'],
      },
    ],
  });
  const [p, d] = ['purchase', 'delivery'].map((k) => saved.templates.find((t) => t.kind === k)!);
  assert.equal(saved.revision, 5);
  assert.equal(templatePaper(p), 'a4');
  assert.equal(p.orientation, 'landscape');
  assert.equal(templatePaper(d), 'continuous-241x140');
  assert.equal(d.paper, undefined, '读取时不补写纸张字段，不改已保存内容');
  assert.equal(sampleDocument(d).rowsPerPage, 11);
  assert.equal(sampleDocument(p).rowsPerPage, 14);
});

test('明细列恢复默认：回到这类单据的默认列和顺序，只动明细列，保存后导出用默认列', () => {
  const custom = {
    ...purchase,
    paper: 'a4' as const,
    orientation: 'landscape' as const,
    companyContact: '虚构联系人',
    paymentTerms: '虚构付款条件',
    columns: ['amount', 'quantity', 'name', 'unit', 'flute'] as any,
  };
  assert.equal(templateColumnsAreDefault(purchase), true, '没自定义过的默认模板，按钮置灰');
  assert.equal(templateColumnsAreDefault({ ...purchase, columns: [...purchaseColumns] }), true);
  assert.equal(templateColumnsAreDefault(custom), false);
  assert.equal(
    templateColumnsAreDefault({ ...delivery, columns: [...deliveryColumns].reverse() }),
    false,
    '列一样但顺序不同也算改过',
  );
  const reset = resetTemplateColumns(custom);
  assert.equal(templateColumnsAreDefault(reset), true);
  assert.equal('columns' in reset, false);
  assert.equal(custom.columns.length, 5, '不改原对象，只在待保存内容里换掉');
  const { columns: _c, ...othersBefore } = custom;
  assert.deepEqual(reset, othersBefore, '纸张、方向、公司资料、条款都不变');
  // 恢复后的模板能照常保存，导出时用默认列和顺序
  const saved = templateSettingsSchema.parse({ expectedRevision: 0, templates: [reset, delivery] });
  assert.equal(saved.templates[0].columns, undefined);
  const form = sampleDocument(saved.templates[0]);
  assert.deepEqual(form.columnKeys, purchaseColumns);
  assert.equal(form.headers[0], '序号');
  assert.equal(form.headers[1], '产品名称');
});
