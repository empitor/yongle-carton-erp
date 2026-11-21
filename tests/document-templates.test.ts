// 单据模板设置和导出业务（server/documents/settings.ts、service.ts，shared/documents/document-templates.ts）：
// 列恢复默认、模板维护和校验、多模板、样张、设置的修订和审计、初始化时留什么、采购单单价写法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { defaultDocumentTemplates, templateSchema, purchaseColumns, deliveryColumns, templateColumnsAreDefault, resetTemplateColumns, templateSettingsSchema, templateHeaderText, type DocumentColumn, type DocumentTemplate } from '../shared/documents/document-templates.js';
import { AppError } from '../server/core/errors.js';
import { count as countRows } from '../server/core/sql.js';
import { sampleDocument } from '../server/documents/sample.js';
import { renderBusinessForm } from '../server/documents/render.js';
import { today } from '../shared/core/domain.js';
import { UNPRICED_TEXT } from '../shared/business/display-text.js';
import { workbenchFixture } from './flow-fixture.js';
import { toolsOf } from './assistant-fixture.js';
import { DocumentTemplateSettings } from '../server/documents/settings.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { BusinessReset } from '../server/admin/business-reset.js';
import '../server/import/index.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { FlowService } from '../server/flow/index.js';
import { actor } from './actor-fixture.js';

const [purchase, delivery] = defaultDocumentTemplates().templates;

test('明细列恢复默认：回到这类单据的默认列和顺序，只动明细列，保存后导出用默认列', () => {
  const custom = {
    ...purchase,
    paper: 'a4' as const,
    orientation: 'landscape' as const,
    companyContact: '虚构联系人',
    paymentTerms: '虚构付款条件',
    columns: ['amount', 'quantity', 'name', 'unit', 'flute'] satisfies DocumentColumn[],
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

test('模板维护：没权限不能改、版本冲突被拒；人工和助手读同一份；导出按模板印、不改采购单状态；模板类型不符拒绝', async () => {
  assert.equal(templateHeaderText('111111'), 'FFFFFF');
  assert.equal(templateHeaderText('E8EEF0'), '111111');
  const f = workbenchFixture(actor);
  try {
    const settings = new DocumentTemplateSettings(f.store),
      before = settings.get();
    const templates = before.templates.map((t) => ({
      ...t,
      companyName: '虚构模板工厂',
      title: t.kind === 'purchase' ? '材料采购订货单' : '客户送货凭证',
      footerNotes: '虚构备注：请按实收签认',
      color: 'CCDDEE',
      fontSize: 11,
      defaultFormat: 'xlsx' as const,
    }));
    assert.throws(
      () => settings.save({ expectedRevision: 0, templates }, { ...actor, permissions: [] }),
      /权限/,
    );
    settings.save({ expectedRevision: 0, templates }, actor);
    assert.throws(
      () => settings.save({ expectedRevision: 0, templates }, actor),
      /模板已在其他页面修改/,
    );
    const tools = toolsOf(f.store),
      fromAI = tools.read('documents.templates', {}, actor);
    assert.deepEqual(fromAI, settings.get());
    const docs = new BusinessDocuments(f.store),
      form = docs.form('purchase', f.purchase.id).form;
    assert.equal(form.companyName, '虚构模板工厂');
    assert.equal(form.rows[0][4], '1000');
    assert.match(form.notes, /按实收签认/);
    const file = await docs.generate(
      {
        kind: 'purchase',
        id: f.purchase.id,
        format: 'xlsx',
        templateId: 'purchase-default',
        expectedVersion: f.purchase.version,
        requestId: randomUUID(),
      },
      actor,
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.read(Readable.from([docs.file(file.exportId, actor).buffer]));
    const sheetText = JSON.stringify(book.worksheets[0].getSheetValues());
    assert.match(sheetText, /虚构模板工厂/);
    assert.match(sheetText, /材料采购订货单/);
    assert.equal(file.templateRevision, 1);
    assert.equal(new FlowService(f.store).views.purchases()[0].businessStatus, '待订货');
    await assert.rejects(
      () =>
        docs.generate(
          {
            kind: 'purchase',
            id: f.purchase.id,
            format: 'docx',
            templateId: 'delivery-default',
            expectedVersion: f.purchase.version,
            requestId: randomUUID(),
          },
          actor,
        ),
      /模板与当前单据类型不一致/,
    );
  } finally {
    f.store.close();
  }
});

test('多模板选择、默认切换、字段排序及隐藏对人工和AI共用文件生效，旧导出保持快照', async () => {
  const f = workbenchFixture(actor);
  try {
    const settings = new DocumentTemplateSettings(f.store),
      before = settings.get(),
      custom = {
        ...before.templates[0],
        id: 'purchase-office',
        name: '虚构办公室采购',
        companyName: '虚构样式工厂',
        headerText: '按原规格供货',
        footerText: '请签认',
        columns: ['name', 'quantity', 'unit', 'dimensions', 'amount'] satisfies DocumentColumn[],
        hiddenFields: ['供应商联系信息'] satisfies DocumentTemplate['hiddenFields'],
        fontFamily: '微软雅黑' as const,
        orientation: 'portrait' as const,
      };
    settings.save(
      {
        expectedRevision: 0,
        templates: [...before.templates, custom],
        defaults: { ...before.defaults, purchase: custom.id },
      },
      actor,
    );
    const docs = new BusinessDocuments(f.store),
      current = docs.form('purchase', f.purchase.id).form;
    assert.equal(current.templateId, custom.id);
    assert.deepEqual(current.headers, [
      '产品名称',
      '订货数量',
      '数量单位',
      '尺寸及单位',
      '金额（元）',
    ]);
    assert.equal(current.rows[0][1], '1000');
    assert.equal(current.rows[0][2], '张');
    assert.equal(
      current.fields.some(([k]) => k === '供应商联系信息'),
      false,
    );
    const file = await docs.generate(
      {
        kind: 'purchase',
        id: f.purchase.id,
        expectedVersion: f.purchase.version,
        templateId: custom.id,
        format: 'xlsx',
        requestId: randomUUID(),
      },
      actor,
    );
    const original = docs.file(file.exportId, actor).buffer,
      saved = settings.get();
    settings.save(
      {
        defaults: saved.defaults,
        expectedRevision: saved.revision,
        templates: saved.templates.map((t) => ({ ...t, companyName: '另一虚构工厂' })),
      },
      actor,
    );
    assert.deepEqual(docs.file(file.exportId, actor).buffer, original);
    assert.equal(templateSchema.parse(docs.file(file.exportId, actor).templateSnapshot).companyName, custom.companyName);
    const book = new ExcelJS.Workbook();
    await book.xlsx.read(Readable.from([original]));
    assert.equal(book.worksheets[0].pageSetup.orientation, 'portrait');
    assert.equal(new FlowService(f.store).views.purchases()[0].businessStatus, '待订货');
    assert.throws(() => docs.form('delivery', 1, custom.id));
  } finally {
    f.store.close();
  }
});

test('模板显隐不能删掉名称、数量、单位；重复列、不认识的纸张、默认模板类型不对都拒收', () => {
  {
    const state = defaultDocumentTemplates(),
      t = state.templates[0];
    assert.equal(
      templateSchema.safeParse({ ...t, columns: ['name', 'unit', 'amount'] }).success,
      false,
    );
    assert.equal(
      templateSchema.safeParse({ ...t, columns: ['name', 'unit', 'quantity', 'quantity'] }).success,
      false,
    );
    assert.equal(
      templateSettingsSchema.safeParse({
        expectedRevision: 0,
        templates: state.templates,
        defaults: { purchase: 'delivery-default', delivery: 'delivery-default' },
      }).success,
      false,
    );
    assert.equal(templateSchema.safeParse({ ...t, id: 'delivery-wrong' }).success, false);
    assert.equal(templateSchema.safeParse({ ...t, paper: 'b5' }).success, false, '不认识的纸张');
  }
});

test('虚构样张按当前未保存配置生成，Excel保留前导零编码，不持久化业务或导出回执', async () => {
  const f = workbenchFixture(actor);
  try {
    const state = new DocumentTemplateSettings(f.store).get(),
      template = {
        ...state.templates[1],
        columns: ['name', 'productCode', 'quantity', 'unit', 'orderNumber', 'unitPrice'] satisfies DocumentColumn[],
      },
      before = countRows(f.store.db, 'SELECT COUNT(*) n FROM operation_requests'),
      exportsBefore = countRows(f.store.db, 'SELECT COUNT(*) n FROM document_exports');
    const form = sampleDocument(template);
    assert.equal(form.sample, true);
    assert.equal(form.rows[0][2], '4000');
    assert.equal(form.rows[0][5], '未记录');
    const book = new ExcelJS.Workbook();
    await book.xlsx.read(Readable.from([await renderBusinessForm(form, 'xlsx')]));
    const sheet = book.worksheets[0],
      rows = sheet.getRows(1, sheet.rowCount);
    assert.ok(rows);
    const header = rows.find((r) => r.getCell(2).value === '客户料号');
    assert.ok(header);
    assert.equal(sheet.getRow(header.number + 1).getCell(2).value, '000123');
    assert.match(String(sheet.headerFooter.oddHeader), /测试样张 · 非正式/);
    assert.equal(countRows(f.store.db, 'SELECT COUNT(*) n FROM operation_requests'), before);
    assert.equal(countRows(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), exportsBefore, '样张不留导出记录');
    assert.equal(f.store.orders().length, 1);
    assert.equal(new FlowService(f.store).views.purchases().length, 1);
  } finally {
    f.store.close();
  }
});

test('模板设置：没保存过是出厂默认；每保存一次修订号加一，过期修订号 409，读出来是最新一份，审计照记', () => {
  const f = workbenchFixture(actor);
  try {
    const settings = new DocumentTemplateSettings(f.store);
    assert.deepEqual(settings.get(), defaultDocumentTemplates());
    const first = settings.save(
      { expectedRevision: 0, templates: settings.get().templates.map((t) => ({ ...t, companyName: '虚构工厂甲' })) },
      actor,
    );
    assert.equal(first.revision, 1);
    const second = settings.save(
      { expectedRevision: 1, templates: first.templates.map((t) => ({ ...t, companyName: '虚构工厂乙' })) },
      actor,
    );
    assert.equal(second.revision, 2);
    assert.throws(
      () => settings.save({ expectedRevision: 1, templates: second.templates }, actor),
      (e: unknown) => e instanceof AppError && e.status === 409 && /模板已在其他页面修改/.test(e.message),
    );
    assert.deepEqual(settings.get(), second);
    assert.equal(settings.get().templates[0].companyName, '虚构工厂乙');
    assert.equal(
      countRows(f.store.db, "SELECT COUNT(*) n FROM business_audit WHERE action='template-settings'"),
      2,
      '审计照常记',
    );
  } finally {
    f.store.close();
  }
});

test('初始化（清空业务数据）清掉导出记录；单据模板设置和订货单号的计数留着，订货单号不从 01 重来', async () => {
  const f = workbenchFixture(actor);
  try {
    const settings = new DocumentTemplateSettings(f.store),
      docs = new BusinessDocuments(f.store, async () => Buffer.from('虚构订货单文件'));
    settings.save(
      { expectedRevision: 0, templates: settings.get().templates.map((t) => ({ ...t, companyName: '虚构初始化前工厂' })) },
      actor,
    );
    const second = f.ops.savePurchase(
      {
        supplierId: f.purchase.supplierId,
        orderDate: today(),
        status: '待订货',
        lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '20', unitPrice: '1.2345', priceBasis: 'quantity' }],
      },
      actor,
    );
    const file = await docs.generate(
      {
        kind: 'purchase',
        id: f.purchase.id,
        format: 'xlsx',
        markOrdered: true,
        expectedVersion: f.purchase.version,
        purchases: [
          { id: f.purchase.id, version: f.purchase.version },
          { id: second.id, version: second.version },
        ],
        requestId: randomUUID(),
      },
      actor,
    );
    assert.match(file.batchNumber ?? '', /^DG-\d{8}-01$/);
    docs.delivered(file.exportId, actor);
    docs.complete(file.exportId, file.sha256, actor);
    const count = (table: string) => countRows(f.store.db, 'SELECT COUNT(*) n FROM ' + table);
    assert.deepEqual([count('document_exports'), count('order_batches'), count('number_sequences')], [1, 1, 1]);
    const owner = localAdministratorActor({ ...actor, role: 'super_admin' });
    const tables = new BusinessReset(f.store).preview('business', owner).tables;
    assert.equal(tables.document_exports, 1, '清空范围里列出导出记录');
    assert.equal('document_template_settings' in tables, false);
    assert.equal('number_sequences' in tables, false);
    new BusinessReset(f.store).execute({ scope: 'business' }, owner);
    assert.deepEqual([count('document_exports'), count('order_batches')], [0, 0]);
    assert.equal(settings.get().templates[0].companyName, '虚构初始化前工厂');
    assert.equal(settings.get().revision, 1);
    assert.equal(count('number_sequences'), 1);
    const { OrderBatchService } = await import('../server/operations/index.js');
    assert.match(new OrderBatchService(f.store).nextNumber(), /^DG-\d{8}-02$/, '初始化后订货单号接着往后排');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('采购单导出的单价和界面同一个写法：至少两位、最多四位，尾零去掉；按面积写“元/m²”，按数量写“元/单位”，没价单价、金额都写“单价待定”', () => {
  const f = workbenchFixture(actor);
  try {
    const docs = new BusinessDocuments(f.store),
      priceCell = (unitPrice: string | null, priceBasis: 'area' | 'quantity') => {
        const p = f.ops.savePurchase(
          {
            supplierId: f.purchase.supplierId,
            orderDate: today(),
            status: '待订货',
            lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '10', unitPrice, priceBasis }],
          },
          actor,
        );
        return docs.form('purchase', p.id).form.rows[0].slice(5, 7);
      };
    assert.equal(priceCell('2.7600', 'area')[0], '2.76 元/m²');
    assert.equal(priceCell('2.5', 'quantity')[0], '2.50 元/' + f.raw.unit);
    assert.equal(priceCell('1.2345', 'area')[0], '1.2345 元/m²');
    assert.deepEqual(priceCell(null, 'area'), [UNPRICED_TEXT, UNPRICED_TEXT]);
  } finally {
    f.store.close();
  }
});
