import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { customerSchema, productSchema, orderSchema, specification } from '../shared/domain.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { ManualProductionCompletion } from '../server/flow/production-completion.js';
import { WarehouseDaily } from '../server/flow/daily.js';
import { buildWorkbench, relatedBusiness } from '../server/business/workbench.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { DocumentTemplateSettings } from '../server/documents/settings.js';
import { templateSettingsSchema, templateSchema } from '../shared/document-templates.js';
import { sampleDocument } from '../server/documents/sample.js';
import { renderBusinessForm } from '../server/documents/templates.js';
import {
  aiSettingsTab,
  normalizeAiSettingsHash,
  pageLink,
} from '../shared/assistant-navigation.js';
import { deliveryCandidates } from '../shared/warehouse-delivery.js';
import ExcelJS from 'exceljs';
import { actor } from './assistant-fixture.js';
const date = '2026-10-29';
function fixture() {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构工作台客户' }));
  const product = store.saveProduct(
    productSchema.parse({
      name: '虚构有料号纸箱',
      length: 300,
      width: 200,
      height: 150,
      dimensionUnit: 'mm',
      material: 'K=A',
      flute: 'BC',
      customerProductCode: '000123',
    }),
  );
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: date,
      deliveryDate: date,
      status: '已确认',
      lines: [
        {
          productId: product.id,
          quantity: 100,
          unit: '只',
          unitPriceCents: 100,
          specification: specification(product),
          customerProductCode: '000123',
        },
      ],
    }),
  );
  const supplier = ops.saveSupplier({ name: '虚构模板供应商' }, actor),
    raw = ops.saveItem(
      { name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' },
      actor,
    );
  ops.move(
    raw.id,
    {
      expectedVersion: raw.version,
      requestId: randomUUID(),
      action: 'in',
      quantity: '100',
      date,
      notes: '虚构期初',
      acknowledged: true,
    },
    actor,
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: order.id,
      orderDate: date,
      expectedDate: '2026-11-02',
      status: '待订货',
      lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '1.2345' }],
    },
    actor,
  );
  const task = flow.save(
    'task',
    {
      productId: product.id,
      quantity: '100',
      unit: '只',
      date,
      plannedDate: '2026-11-01',
      orderIds: [order.id],
    },
    actor,
  );
  return { store, ops, flow, order, raw, product, purchase, task, customer };
}
test('工作台读取真实待办、跨日计划与当日实绩，读取及建立计划不会增加库存', () => {
  const f = fixture();
  try {
    assert.equal(buildWorkbench(f.store, date).toOrder, 1);
    const ordered = f.ops.savePurchase(
      { ...f.purchase, version: f.purchase.version, status: '已订货' },
      actor,
      f.purchase.id,
    );
    const plan = f.flow.saveArrivalPlan(
      {
        purchaseId: f.purchase.id,
        expectedPurchaseVersion: ordered.version,
        requestId: randomUUID(),
        plannedDate: '2026-11-02',
        notes: '',
        items: [{ lineId: f.purchase.lines[0].id, quantity: '500' }],
      },
      actor,
    );
    const before = f.ops.repo.balance(f.raw.id),
      work = buildWorkbench(f.store, date);
    assert.equal(work.toOrder, 0);
    assert.equal(work.pendingArrivals, 1);
    assert.equal(work.arrivalsToday, 0);
    assert.equal(work.activeTasks, 1);
    assert.equal(work.tasksToday, 0);
    assert.equal(work.productionToday, 0);
    assert.equal(new WarehouseDaily(f.store).get({ kind: 'arrival', date }).records.length, 0);
    assert.equal(
      new WarehouseDaily(f.store).get({ kind: 'arrival', date, scope: 'all' }).records.length,
      1,
    );
    const related = relatedBusiness(f.store, 'purchases', f.purchase.id)!;
    assert.equal(related.arrivals![0].flowId, plan.document.id);
    assert.equal(f.ops.repo.balance(f.raw.id), before);
    const sales = relatedBusiness(f.store, 'orders', f.order.id)!;
    assert.equal(sales.tasks![0].id, f.task.id);
    assert.equal(sales.purchases![0].id, f.purchase.id);
    assert.equal(sales.deliveries!.length, 0);
  } finally {
    f.store.close();
  }
});
test('有客户料号的纸箱从整批完工到部分送货闭环，规格与料号不混用', () => {
  const f = fixture();
  try {
    const completion = new ManualProductionCompletion(f.store),
      input = {
        requestId: randomUUID(),
        taskIds: [f.task.id],
        date,
        operator: '虚构生产员工',
        allocation: 'shared-proportional',
        materials: [{ stockId: f.raw.id, unit: '张', issued: '5', returned: '0' }],
        quantities: [{ taskId: f.task.id, goodQuantity: '100', scrapQuantity: '0' }],
        createMissingFinished: true,
      };
    const preview = completion.preview(input, actor, 'fixture-session');
    assert.equal(f.store.stock_items().filter((s) => s.kind === 'finished').length, 0);
    completion.execute({ input, previewDigest: preview.previewDigest }, actor, 'fixture-session');
    const stock = f.store.stock_items().find((s) => s.kind === 'finished')!;
    assert.equal(stock.specification, specification(f.product));
    assert.notEqual(stock.specification, '000123');
    assert.equal(deliveryCandidates(stock, f.customer.id, f.store.orders()).length, 1);
    const doc = f.flow.save(
      'delivery',
      {
        date,
        customerId: f.customer.id,
        lines: [
          {
            stockId: stock.id,
            orderId: f.order.id,
            orderLineId: f.order.lines[0].id,
            quantity: '40',
          },
        ],
      },
      actor,
    );
    const p = f.flow.preview(doc.id, actor, 'fixture-session');
    f.flow.confirm(
      doc.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      actor,
      'fixture-session',
    );
    assert.equal(f.ops.repo.balance(stock.id), 60000);
    assert.equal(f.store.orders()[0].shippingProgress, '部分发货');
    const form = new BusinessDocuments(f.store).form('delivery', doc.id).form;
    assert.equal(form.rows[0][4], '40');
    assert.equal(form.rows[0][form.columnKeys!.indexOf('productCode')], '000123');
    assert.equal(form.rows[0][form.columnKeys!.indexOf('orderNumber')], f.order.number);
    assert.equal((form.rows[0][2].match(/300/g) || []).length, 1);
    const settings = new DocumentTemplateSettings(f.store),
      state = settings.get();
    settings.save(
      {
        expectedRevision: state.revision,
        templates: state.templates.map((t) =>
          t.kind === 'delivery'
            ? { ...t, columns: ['name', 'quantity', 'unit', 'unitPrice', 'amount'] }
            : t,
        ),
      },
      actor,
    );
    const priced = new BusinessDocuments(f.store).form('delivery', doc.id).form;
    assert.equal(priced.rows[0][3], '1.00');
    assert.equal(priced.rows[0][4], '40.0000000');
    const work = buildWorkbench(f.store, date);
    assert.equal(work.activeTasks, 0);
    assert.equal(work.productionToday, 1);
    assert.equal(work.deliveriesToday, 1);
  } finally {
    f.store.close();
  }
});
test('多模板选择、默认切换、字段排序及隐藏对人工和AI共用文件生效，旧导出保持快照', async () => {
  const f = fixture();
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
        columns: ['name', 'quantity', 'unit', 'dimensions', 'amount'] as any,
        hiddenFields: ['供应商联系信息'] as any,
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
      '订购数量',
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
    assert.equal(docs.file(file.exportId, actor).templateSnapshot.companyName, custom.companyName);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(original as any);
    assert.equal(book.worksheets[0].pageSetup.orientation, 'portrait');
    assert.equal(f.store.purchases()[0].businessStatus, '待订货');
    assert.throws(() => docs.form('delivery', 1, custom.id));
  } finally {
    f.store.close();
  }
});
test('模板显隐不能删除业务必需的名称数量单位，重复列和错误默认类型均拒绝', () => {
  const f = fixture();
  try {
    const state = new DocumentTemplateSettings(f.store).get(),
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
  } finally {
    f.store.close();
  }
});
test('虚构样张按当前未保存配置生成，Excel保留前导零编码，不持久化业务或导出回执', async () => {
  const f = fixture();
  try {
    const state = new DocumentTemplateSettings(f.store).get(),
      template = {
        ...state.templates[1],
        columns: ['name', 'productCode', 'quantity', 'unit', 'orderNumber', 'unitPrice'] as any,
      },
      before = f.store.db.prepare('SELECT COUNT(*) n FROM operation_requests').get()!.n;
    const form = sampleDocument(template);
    assert.equal(form.sample, true);
    assert.equal(form.rows[0][2], '4000');
    assert.equal(form.rows[0][5], '未记录');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderBusinessForm(form, 'xlsx')) as any);
    const sheet = book.worksheets[0],
      header = sheet
        .getRows(1, sheet.rowCount)!
        .find((r) => r.getCell(2).value === '产品编码 / 客户料号')!;
    assert.equal(sheet.getRow(header.number + 1).getCell(2).value, '000123');
    assert.match(String(sheet.getCell('A1').value), /测试样张 非正式/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM operation_requests').get()!.n, before);
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.store.purchases().length, 1);
  } finally {
    f.store.close();
  }
});
test('旧单据模板地址兼容进入AI设置第四页签，AI导航与人工导航一致', () => {
  assert.equal(normalizeAiSettingsHash('#document-templates'), '#ai-settings?tab=templates');
  assert.equal(aiSettingsTab('#ai-settings?tab=templates'), 'templates');
  assert.equal(pageLink('document-templates'), '#ai-settings?tab=templates');
});
