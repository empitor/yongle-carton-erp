// 导出文件的版式（server/documents/render.ts）：Word、Excel 多行续页、中文规格、精度、公式；送货单按本批数量、料号和订单号栏、改了栏位的金额。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { SyntaxValidator } from 'fast-xml-validator';
import { renderBusinessForm } from '../server/documents/render.js';
import { allRows, setup, wordXml, zipEntries } from './document-fixture.js';
import { randomUUID } from 'node:crypto';
import { workbenchFixture } from './flow-fixture.js';
import { shipOnDocDate } from './ship-date.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { DocumentTemplateSettings } from '../server/documents/settings.js';
import { specification } from '../shared/core/domain.js';
import { count } from '../server/core/index.js';
import { actor } from './actor-fixture.js';

test('采购Word和Excel完整多行、可容纳中文规格、原单位尺寸和精度可读回，标题与打印布局合法', async () => {
  const f = setup();
  try {
    const long = '虚构规格说明',
      p = f.flow.stock.savePurchase(
        {
          ...f.current(),
          status: '待订货',
          version: f.current().version,
          lines: Array.from({ length: 32 }, (_, i) => ({
            ...f.current().lines[0],
            id: undefined,
            stockItemId: null,
            name: '虚构纸板' + i,
            specification: long,
            quantity: String(100 + i),
            unitPrice: '1.2345',
          })),
        },
        actor,
        f.purchase.id,
      );
    for (const format of ['docx', 'xlsx'] as const) {
      const file = await f.docs.generate(
          f.exp('purchase', p.id, { format, markOrdered: false }),
          actor,
        ),
        bytes = f.docs.file(file.exportId, actor).buffer;
      if (format === 'docx') {
        const parts = await zipEntries(bytes);
        for (const xml of parts.values()) assert.equal(SyntaxValidator.validate(xml), true);
        const xml = parts.get('word/document.xml');
        assert.ok(xml);
        assert.match(xml, /虚构纸板31/);
        assert.match(xml, /1.2345/);
        assert.match(xml, /采购订货单/);
        assert.match(xml, /tblHeader/);
        assert.ok((xml.match(/<w:pageBreakBefore\/>/g) || []).length >= 1, '明细超过一张时应续页');
        assert.doesNotMatch(xml, /w:orient="landscape"/);
        const page = xml.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/);
        assert.ok(page && Number(page[1]) < Number(page[2]), '默认订货单是 A4 竖版');
      } else {
        const book = new ExcelJS.Workbook();
        await book.xlsx.read(Readable.from([bytes]));
        const sheet = book.worksheets[0];
        const header = allRows(sheet).find((r) => r.getCell(2).value === '产品名称');
        assert.ok(header);
        // 固定版式：明细按每张行数续页，每张都有自己的表头，张与张之间手动分页。
        const rows = allRows(sheet),
          headers = rows.filter((r) => r.getCell(2).value === '产品名称'),
          names = rows
            .map((r) => String(r.getCell(2).value ?? ''))
            .filter((v) => v.startsWith('虚构纸板'));
        assert.ok(headers.length > 1, '明细超过一张时应续页');
        assert.equal(names.length, new Set(names).size);
        assert.ok(names.includes('虚构纸板31'));
        const sheetXml = (await zipEntries(bytes)).get('xl/worksheets/sheet1.xml');
        assert.ok(sheetXml);
        assert.equal((sheetXml.match(/<brk /g) || []).length, headers.length - 1);
        assert.equal(sheet.pageSetup.orientation, 'portrait');
        assert.match(JSON.stringify(sheet.getSheetValues()), /1.2345/);
      }
    }
  } finally {
    f.store.close();
  }
});

test('正式送货单按本批数量导出，待送货的标非正式；导出不出库', async () => {
  const f = setup();
  try {
    const draft = f.saveDelivery();
    assert.equal(f.docs.form('delivery', draft.id).form.draft, true);
    assert.equal(f.docs.form('delivery', draft.id).form.rows[0][4], '4000');
    f.confirm(draft);
    const second = f.saveDelivery('6000');
    f.confirm(second);
    const before = f.ops.balance(f.stock.id),
      moves = count(f.store.db, 'SELECT COUNT(*) n FROM stock_movements');
    for (const [id, q] of [
      [draft.id, '4000'],
      [second.id, '6000'],
    ] as const) {
      assert.equal(f.docs.form('delivery', id).form.draft, false);
      assert.equal(f.docs.form('delivery', id).form.rows[0][4], q);
      for (const format of ['docx', 'xlsx'] as const) {
        const file = await f.docs.generate(f.exp('delivery', id, { format }), actor);
        f.docs.delivered(file.exportId, actor);
        f.docs.complete(file.exportId, file.sha256, actor);
        const bytes = f.docs.file(file.exportId, actor).buffer;
        if (format === 'docx') {
          assert.match(await wordXml(bytes), new RegExp(q));
        } else {
          const book = new ExcelJS.Workbook();
          await book.xlsx.read(Readable.from([bytes]));
          const sheet = book.worksheets[0],
            header = allRows(sheet).find((r) => r.getCell(5).value === '本批送货数量');
          assert.ok(header);
          assert.equal(sheet.getRow(header.number + 1).getCell(5).value, Number(q));
        }
      }
    }
    assert.equal(f.ops.balance(f.stock.id), before);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM stock_movements'), moves);
  } finally {
    f.store.close();
  }
});

test('送货单的栏位：料号保留前导零、带订单号、规格里尺寸只写一次；模板改了栏位，金额照订单单价算', () => {
  const f = workbenchFixture(actor);
  try {
    const stock = f.ops.saveItem({ name: '虚构有料号成品', kind: 'finished', unit: '只', productId: f.product.id, specification: specification(f.product) }, actor);
    f.flow.stock.move(stock.id, { expectedVersion: stock.version, requestId: randomUUID(), action: 'in', quantity: '100', date: f.order.orderDate, notes: '虚构期初', acknowledged: true }, actor);
    const doc = f.flow.save(
      'delivery',
      { date: f.order.orderDate, customerId: f.customer.id, lines: [{ stockId: stock.id, orderId: f.order.id, orderLineId: f.order.lines[0].id, quantity: '40' }] },
      actor,
    );
    f.base.check(doc, shipOnDocDate(f.flow, doc.id), actor);
    const form = new BusinessDocuments(f.store).form('delivery', doc.id).form,
      keys = form.columnKeys;
    assert.ok(keys);
    assert.equal(form.rows[0][4], '40');
    assert.equal(form.rows[0][keys.indexOf('productCode')], '000123');
    assert.equal(form.rows[0][keys.indexOf('orderNumber')], f.order.number);
    assert.equal((String(form.rows[0][2]).match(/300/g) || []).length, 1);
    const settings = new DocumentTemplateSettings(f.store),
      state = settings.get();
    settings.save(
      {
        expectedRevision: state.revision,
        templates: state.templates.map((t) => (t.kind === 'delivery' ? { ...t, columns: ['name', 'quantity', 'unit', 'unitPrice', 'amount'] } : t)),
      },
      actor,
    );
    const priced = new BusinessDocuments(f.store).form('delivery', doc.id).form;
    assert.deepEqual([priced.rows[0][3], priced.rows[0][4]], ['1.00', '40.00']);
  } finally {
    f.store.close();
  }
});

test('Excel超15位有效数按原文保留，用户文本不会被解释为公式', async () => {
  const exact = '10000000000000110',
    bytes = await renderBusinessForm(
      {
        title: '精度验证',
        number: 'FICTIONAL',
        draft: true,
        fields: [],
        headers: ['数值', '文本'],
        rows: [[exact, '=1+1']],
        notes: '',
        signatures: [],
      },
      'xlsx',
    );
  const book = new ExcelJS.Workbook();
  await book.xlsx.read(Readable.from([bytes]));
  const sheet = book.worksheets[0],
    label = allRows(sheet).find((r) => r.getCell(1).value === '数值');
  assert.ok(label);
  const data = sheet.getRow(label.number + 1);
  assert.equal(data.getCell(1).value, exact);
  assert.equal(data.getCell(2).value, '=1+1');
  assert.equal(data.getCell(2).type, ExcelJS.ValueType.String);
});
