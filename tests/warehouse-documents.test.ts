import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { XMLValidator } from 'fast-xml-parser';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { WarehouseDaily } from '../server/flow/daily.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { renderBusinessForm } from '../server/documents/templates.js';
import { warehouseArrivalHash } from '../shared/arrival-navigation.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { actor, assistantFixture } from './assistant-fixture.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { legacyReceiptFixture } from './legacy-receipt-fixture.js';

function setup(store = new Store(':memory:')) {
  const ops = new OperationsService(store),
    flow = new FlowService(store),
    daily = new WarehouseDaily(store),
    docs = new BusinessDocuments(store);
  const supplier = ops.saveSupplier(
    { name: '虚构春芳纸板厂', contact: '虚构联系人', phone: '000-0000', address: '虚构供应商地址' },
    actor,
  );
  const raw = ops.saveItem(
    {
      name: '虚构纸板A',
      kind: 'raw',
      unit: '张',
      length: 1000,
      width: 800,
      dimensionUnit: 'mm',
      specification: 'K=A B楞',
    },
    actor,
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      orderDate: '2026-10-29',
      expectedDate: '2026-11-02',
      status: '待订货',
      notes: '按原单位与尺寸供货',
      lines: [{ ...raw, stockItemId: raw.id, quantity: '10000', unitPrice: '1.2345' }],
    },
    actor,
  );
  const current = () => store.purchases(true).find((p) => p.id === purchase.id)!;
  const ordered = () =>
    ops.savePurchase(
      { ...current(), status: '已订货', version: current().version },
      actor,
      purchase.id,
    );
  const customer = store.saveCustomer(
    customerSchema.parse({
      name: '虚构包装客户',
      contact: '虚构收货人',
      phone: '000-111',
      address: '虚构收货地址',
    }),
  );
  const product = store.saveProduct(
    productSchema.parse({
      name: '虚构纸箱产品',
      length: 300,
      width: 200,
      height: 150,
      dimensionUnit: 'mm',
    }),
  );
  const stock = ops.saveItem(
    {
      name: product.name,
      kind: 'finished',
      unit: '只',
      productId: product.id,
      specification: '纸箱300×200×150mm',
    },
    actor,
  );
  ops.move(
    stock.id,
    {
      expectedVersion: stock.version,
      requestId: randomUUID(),
      action: 'in',
      acknowledged: true,
      quantity: '10000',
      date: '2026-10-29',
      notes: '虚构期初',
    },
    actor,
  );
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-29',
      deliveryDate: '2026-11-03',
      status: '已确认',
      lines: [
        {
          productId: product.id,
          productName: product.name,
          specification: stock.specification,
          quantity: 10000,
          unit: '只',
          unitPriceCents: 100,
        },
      ],
    }),
  );
  const saveDelivery = (quantity = '4000', extra: any = {}) =>
    flow.save(
      'delivery',
      {
        date: '2026-10-29',
        plannedDate: '2026-10-30',
        plannedTime: '14:30',
        actualTime: '15:00',
        customerId: customer.id,
        lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity }],
        ...extra,
      },
      actor,
    );
  const confirm = (d: any) => {
    const p = flow.preview(d.id, actor, 'test');
    return flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      actor,
      'test',
    );
  };
  const exp = (kind: 'purchase' | 'delivery', id: number, extra: any = {}) => ({
    kind,
    id,
    format: 'docx',
    markOrdered: kind === 'purchase',
    expectedVersion: kind === 'purchase' ? current().version : flow.get(id).version,
    requestId: randomUUID(),
    ...extra,
  });
  const plan = (date = '2026-10-30', q = '5000') =>
    flow.saveArrivalPlan(
      {
        purchaseId: purchase.id,
        expectedPurchaseVersion: current().version,
        plannedDate: date,
        plannedTime: '14:00',
        requestId: randomUUID(),
        items: [{ lineId: purchase.lines[0].id, quantity: q }],
      },
      actor,
    ).document;
  const receive = (q = '5000', extra: any = {}) =>
    flow.receivePurchase(
      {
        purchaseId: purchase.id,
        expectedPurchaseVersion: current().version,
        reference: randomUUID(),
        date: '2026-10-29',
        actualTime: '14:00',
        requestId: randomUUID(),
        items: [
          {
            lineId: purchase.lines[0].id,
            quantity: q,
            acceptedQuantity: q,
            rejectedQuantity: '0',
            stockedQuantity: q,
          },
        ],
        ...extra,
      },
      actor,
      'test',
    );
  return {
    store,
    ops,
    flow,
    daily,
    docs,
    raw,
    purchase,
    current,
    ordered,
    customer,
    stock,
    order,
    saveDelivery,
    confirm,
    exp,
    plan,
    receive,
  };
}
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

test('每日到货合并计划和实际、跨日完成及未计划收货，取消和更正不重复计算', () => {
  const f = setup();
  try {
    f.ordered();
    const p = f.plan(),
      cancelled = f.plan('2026-11-02', '1000');
    f.flow.cancel(
      cancelled.id,
      { version: cancelled.version, reason: '虚构取消', acknowledged: true },
      actor,
    );
    assert.equal(f.ops.repo.balance(f.raw.id), 0);
    assert.deepEqual(f.daily.get({ kind: 'arrival', date: '2026-10-30' }).summary, {
      planned: 1,
      completed: 0,
      pending: 1,
    });
    f.receive('4000', { planId: p.id, expectedPlanVersion: p.version });
    assert.deepEqual(f.daily.get({ kind: 'arrival', date: '2026-10-30' }).summary, {
      planned: 1,
      completed: 0,
      pending: 0,
    });
    assert.deepEqual(f.daily.get({ kind: 'arrival', date: '2026-10-29' }).summary, {
      planned: 0,
      completed: 1,
      pending: 0,
    });
    assert.equal(f.daily.get({ kind: 'arrival', date: '2026-11-02' }).summary!.pending, 0);
    f.receive('1000');
    assert.equal(f.daily.get({ kind: 'arrival', date: '2026-10-29' }).summary!.completed, 2);
    const receipt = f.current().receipts.find((r: any) => r.id === 'flow-' + p.id)!;
    const input = {
      expectedVersion: receipt.version,
      expectedPurchaseVersion: f.current().version,
      reason: '虚构实收更正',
      items: [{ index: 0, lineId: receipt.correctionLines[0].lineId, quantity: '3500' }],
    };
    const preview = f.ops.previewReceiptCorrection(f.purchase.id, receipt.id, input, actor);
    f.ops.correctReceipt(
      f.purchase.id,
      receipt.id,
      { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest },
      actor,
    );
    assert.equal(f.daily.get({ kind: 'arrival', date: '2026-10-29' }).summary!.completed, 2);
    assert.equal(f.daily.get({ kind: 'arrival', date: '2026-10-30' }).summary!.planned, 1);
  } finally {
    f.store.close();
  }
});
test('送货同页按计划与实际日期分别归属、分批履约、库存及流水口径一致', () => {
  const f = setup();
  try {
    const p = f.saveDelivery();
    assert.equal(f.ops.repo.balance(f.stock.id), 10000000);
    assert.equal(f.daily.get({ kind: 'delivery', date: '2026-10-30' }).summary!.pending, 1);
    const adjusted = f.flow.schedule(
      p.id,
      {
        plannedDate: '2026-11-02',
        plannedTime: '16:00',
        expectedVersion: p.version,
        requestId: randomUUID(),
      },
      actor,
    ).document;
    assert.equal(adjusted.actualDate, null);
    assert.equal(adjusted.plannedTime, '16:00');
    f.confirm(adjusted);
    const first = f.daily.get({ kind: 'delivery', date: '2026-10-29' });
    assert.equal(first.summary!.completed, 1);
    assert.equal(first.summary!.planned, 0);
    assert.equal(first.records[0].lines[0].shippedQuantity, 4000);
    assert.equal(first.records[0].lines[0].remainingQuantity, 6000);
    assert.equal(first.records[0].lines[0].movements.length, 1);
    f.confirm(f.saveDelivery('6000', { date: '2026-10-30', plannedDate: null }));
    assert.equal(f.store.orders()[0].shippingProgress, '已发完');
    assert.equal(f.ops.repo.balance(f.stock.id), 0);
    assert.equal(f.daily.get({ kind: 'delivery', date: '2026-10-30' }).summary!.completed, 1);
  } finally {
    f.store.close();
  }
});
test('历史独立到货没有计划和时间证据仍正确显示，流水不重复入库', () => {
  const f = setup();
  try {
    f.ordered();
    legacyReceiptFixture(
      f.ops,
      f.purchase.id,
      {
        expectedVersion: f.current().version,
        reference: 'OLD-LEGACY',
        acknowledged: true,
        date: '2026-10-29',
        requestId: randomUUID(),
        items: [{ lineId: f.purchase.lines[0].id, quantity: '1000' }],
      },
      actor,
    );
    const before = f.ops.repo.balance(f.raw.id),
      d = f.daily.get({ kind: 'arrival', date: '2026-10-29' });
    assert.equal(d.summary!.completed, 1);
    assert.equal(d.summary!.planned, 0);
    assert.equal(d.records[0].actualTime, null);
    assert.equal(f.ops.repo.balance(f.raw.id), before);
  } finally {
    f.store.close();
  }
});
test('采购预览和文件生成不改变状态；完整交付后原服务更新已订货，重复导出幂等且不动库存', async () => {
  const f = setup();
  try {
    const form = f.docs.form('purchase', f.purchase.id).form;
    assert.equal(form.rows[0][4], '10000');
    assert.equal(f.current().businessStatus, '待订货');
    const v = f.exp('purchase', f.purchase.id),
      file = await f.docs.generate(v, actor);
    assert.equal(f.current().businessStatus, '待订货');
    assert.equal((await f.docs.generate(v, actor)).exportId, file.exportId);
    assert.throws(() => f.docs.complete(file.exportId, file.sha256, actor), /尚未完整交付/);
    f.docs.delivered(file.exportId, actor);
    assert.throws(() => f.docs.complete(file.exportId, '0'.repeat(64), actor), /校验失败/);
    const done = f.docs.complete(file.exportId, file.sha256, actor);
    assert.equal(done.businessStatus, '已订货');
    const version = f.current().version;
    assert.equal(f.docs.complete(file.exportId, file.sha256, actor).businessStatus, '已订货');
    const again = await f.docs.generate(
      f.exp('purchase', f.purchase.id, { format: 'xlsx' }),
      actor,
    );
    f.docs.delivered(again.exportId, actor);
    f.docs.complete(again.exportId, again.sha256, actor);
    assert.equal(f.current().version, version);
    assert.equal(f.store.purchases().length, 1);
    assert.equal(f.ops.repo.balance(f.raw.id), 0);
    assert.equal(f.current().lines[0].receivedQuantity, '0');
  } finally {
    f.store.close();
  }
});
test('生成失败、并发版本变化、交付后版本冲突及已取消采购均不误改订货状态', async () => {
  const f = setup();
  try {
    const fail = new BusinessDocuments(f.store, async () => {
      throw new Error('虚构导出失败');
    });
    await assert.rejects(() => fail.generate(f.exp('purchase', f.purchase.id), actor), /导出失败/);
    assert.equal(f.current().businessStatus, '待订货');
    const file = await f.docs.generate(f.exp('purchase', f.purchase.id), actor);
    f.ops.savePurchase(
      { ...f.current(), status: '待订货', notes: '虚构并发修改', version: f.current().version },
      actor,
      f.purchase.id,
    );
    f.docs.delivered(file.exportId, actor);
    assert.throws(() => f.docs.complete(file.exportId, file.sha256, actor), /采购单已变化/);
    assert.equal(f.current().businessStatus, '待订货');
    const cancelled = f.ops.savePurchase(
      { ...f.current(), status: '已取消', version: f.current().version },
      actor,
      f.purchase.id,
    );
    await assert.rejects(() => f.docs.generate(f.exp('purchase', f.purchase.id), actor), /已取消/);
    await f.docs.generate(f.exp('purchase', f.purchase.id, { markOrdered: false }), actor);
    assert.equal(f.current().businessStatus, '已取消');
    assert.equal(cancelled.businessStatus, '已取消');
  } finally {
    f.store.close();
  }
});
test('采购Word和Excel完整多行、长中文、原单位尺寸和精度可读回，标题与打印布局合法', async () => {
  const f = setup();
  try {
    const long = '虚构长规格说明'.repeat(14),
      p = f.ops.savePurchase(
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
        for (const xml of parts.values()) assert.equal(XMLValidator.validate(xml), true);
        const xml = parts.get('word/document.xml')!;
        assert.match(xml, /虚构纸板31/);
        assert.match(xml, /1.2345/);
        assert.match(xml, /采购订货单/);
        assert.match(xml, /tblHeader/);
        assert.match(xml, /landscape/);
        const page = xml.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/);
        assert.ok(page && Number(page[1]) > Number(page[2]), '打印页实际宽度应大于高度');
      } else {
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(bytes as any);
        const sheet = book.worksheets[0];
        const header = sheet.getRows(1, sheet.rowCount)!.find(r => r.getCell(2).value === '产品名称')!;
        assert.ok(header);
        assert.equal(sheet.getRow(header.number + 32).getCell(2).value, '虚构纸板31');
        assert.equal(sheet.pageSetup.orientation, 'landscape');
        assert.ok(sheet.pageSetup.printTitlesRow);
        assert.match(JSON.stringify(sheet.getSheetValues()), /1.2345/);
      }
      if (process.env.ERP_EXPORT_QA_DIR) {
        mkdirSync(process.env.ERP_EXPORT_QA_DIR, { recursive: true });
        writeFileSync(join(process.env.ERP_EXPORT_QA_DIR, '虚构采购订货单.' + format), bytes);
      }
    }
  } finally {
    f.store.close();
  }
});
test('正式送货单导出本批4000与6000，计划文件显式非正式，重复导出无额外出库', async () => {
  const f = setup();
  try {
    const draft = f.saveDelivery();
    assert.equal(f.docs.form('delivery', draft.id).form.draft, true);
    assert.equal(f.docs.form('delivery', draft.id).form.rows[0][4], '4000');
    f.confirm(draft);
    const second = f.saveDelivery('6000');
    f.confirm(second);
    const before = f.ops.repo.balance(f.stock.id),
      moves = f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n;
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
          assert.match((await zipEntries(bytes)).get('word/document.xml')!, new RegExp(q));
        } else {
          const book = new ExcelJS.Workbook();
          await book.xlsx.load(bytes as any);
          const sheet = book.worksheets[0], header = sheet.getRows(1, sheet.rowCount)!.find(r => r.getCell(5).value === '本批送货数量')!;
          assert.ok(header);
          assert.equal(sheet.getRow(header.number + 1).getCell(5).value, Number(q));
        }
        if (process.env.ERP_EXPORT_QA_DIR)
          writeFileSync(
            join(process.env.ERP_EXPORT_QA_DIR, '虚构送货单-' + q + '.' + format),
            bytes,
          );
      }
    }
    assert.equal(f.ops.repo.balance(f.stock.id), before);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, moves);
  } finally {
    f.store.close();
  }
});
test('独立文件库重开后计划、每日汇总、导出文件及已订货状态保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-documents-')),
    path = join(dir, 'fake.sqlite');
  let f = setup(new Store(path));
  try {
    const file = await f.docs.generate(f.exp('purchase', f.purchase.id), actor);
    f.docs.delivered(file.exportId, actor);
    f.docs.complete(file.exportId, file.sha256, actor);
    f.plan();
    const id = f.purchase.id;
    f.store.close();
    const store = new Store(path);
    try {
      assert.equal(store.purchases().find((p) => p.id === id)!.businessStatus, '已订货');
      assert.equal(
        new WarehouseDaily(store).get({ kind: 'arrival', date: '2026-10-30' }).summary!.pending,
        1,
      );
      assert.ok(new BusinessDocuments(store).file(file.exportId, actor).buffer.length > 1000);
    } finally {
      store.close();
    }
  } finally {
    try {
      f.store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('AI查询日期汇总、采购导出交付与状态核验和人工共用同一服务', async () => {
  const a = assistantFixture(),
    f = setup(a.store);
  try {
    const t = a.manager.create(actor),
      request = f.exp('purchase', f.purchase.id);
    a.replies.push(
      {
        state: 'working',
        message: '查询今日到货',
        toolCalls: [{ name: 'flow.daily', args: { kind: 'arrival', date: '2026-10-29' } }],
      },
      {
        state: 'working',
        message: '导出正式订货单',
        toolCalls: [{ name: 'documents.export', args: request }],
      },
      { state: 'completed', message: '订货单已交付并标记已订货。', toolCalls: [] },
    );
    const result = await a.manager.chat(
      t.id,
      a.input('把虚构春芳纸板厂这张采购单导出Word并正式订货。', randomUUID()),
      actor,
      'test',
      (event: string, data: any) => {
        if (event === 'effect' && data.type === 'download') {
          const file = f.docs.file(data.file.exportId, actor);
          assert.ok(file.buffer.length > 1000);
          f.docs.delivered(file.requestId, actor);
          f.docs.complete(file.requestId, file.sha256, actor);
        }
      },
      () => actor,
    );
    assert.equal(f.current().businessStatus, '已订货');
    assert.ok(
      result.messages.some((m: any) =>
        m.executions?.some((e: any) => e.tool === 'documents.export' && e.result.completedAt),
      ),
    );
    const tools = new AssistantTools(a.store);
    assert.equal(
      tools.read('flow.daily', { kind: 'arrival', date: '2026-10-29' }, actor).summary.completed,
      0,
    );
    const registry = new AssistantToolRegistry();
    try {
      await assert.rejects(
        () =>
          registry.dispatch(
            'documents.export',
            request,
            { ...actor, permissions: [] },
            { workflow: () => assert.fail('不应调用'), read: () => null, business: () => null },
          ),
        /权限/,
      );
    } finally {
      registry.close();
    }
  } finally {
    a.close();
  }
});
test('AI送货计划、改期、实际发货及本批Excel导出共用原服务，旧排程链接回到统一台账', async () => {
  const a = assistantFixture(),
    f = setup(a.store);
  try {
    const tools = new AssistantTools(f.store);
    const draft = tools.commit(
      tools.prepare(
        'records.propose_save',
        {
          module: 'deliveries',
          patch: {
            date: '2026-10-29',
            plannedDate: '2026-10-30',
            plannedTime: '09:30',
            customerId: f.customer.id,
            lines: [
              {
                orderId: f.order.id,
                orderLineId: f.order.lines[0].id,
                stockId: f.stock.id,
                quantity: '4000',
              },
            ],
          },
        },
        actor,
        'test',
      ),
      actor,
      'test',
    );
    assert.equal(f.ops.repo.balance(f.stock.id), 10000000);
    tools.commit(
      tools.prepare(
        'flow.schedule',
        {
          id: draft.id,
          plannedDate: '2026-11-02',
          plannedTime: '16:00',
          expectedVersion: draft.version,
          requestId: randomUUID(),
        },
        actor,
        'test',
      ),
      actor,
      'test',
    );
    assert.equal(
      tools.read('flow.daily', { kind: 'delivery', date: '2026-11-02' }, actor).summary.pending,
      1,
    );
    tools.commit(
      tools.prepare('flow.propose_confirmation', { id: draft.id }, actor, 'test'),
      actor,
      'test',
    );
    const before = f.ops.repo.balance(f.stock.id),
      t = a.manager.create(actor);
    a.replies.push(
      {
        state: 'working',
        message: '导出本批送货',
        toolCalls: [{ name: 'documents.preview', args: { kind: 'delivery', id: draft.id } }],
      },
      {
        state: 'working',
        message: '生成文件',
        toolCalls: [
          { name: 'documents.export', args: f.exp('delivery', draft.id, { format: 'xlsx' }) },
        ],
      },
      { state: 'completed', message: '本批送货单已交付。', toolCalls: [] },
    );
    await a.manager.chat(
      t.id,
      a.input('将本批4000只的正式送货单导出Excel。', randomUUID()),
      actor,
      'test',
      (event: string, data: any) => {
        if (event === 'effect' && data.type === 'download') {
          f.docs.delivered(data.file.exportId, actor);
          f.docs.complete(data.file.exportId, data.file.sha256, actor);
        }
      },
      () => actor,
    );
    assert.equal(f.ops.repo.balance(f.stock.id), before);
    assert.equal(f.docs.form('delivery', draft.id).form.rows[0][4], '4000');
    assert.equal(
      warehouseArrivalHash('#warehouse?arrivalPlans=1&date=2026-11-02'),
      '#warehouse?date=2026-11-02&arrivals=1',
    );
    assert.equal(
      warehouseArrivalHash('#warehouse?deliveryPlans=1&doc=2'),
      '#warehouse?doc=2&deliveries=1',
    );
  } finally {
    a.close();
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
  await book.xlsx.load(bytes as any);
  assert.equal(book.worksheets[0].getRow(3).getCell(1).value, exact);
  assert.equal(book.worksheets[0].getRow(3).getCell(2).value, '=1+1');
  assert.equal(book.worksheets[0].getRow(3).getCell(2).type, ExcelJS.ValueType.String);
});
test('并发同请求仅保存一份完整文件，生成期间改动版本时拒绝旧文件交付', async () => {
  const f = setup();
  try {
    const request = f.exp('purchase', f.purchase.id, { markOrdered: false }),
      files = await Promise.all([f.docs.generate(request, actor), f.docs.generate(request, actor)]);
    assert.equal(files[0].sha256, files[1].sha256);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM operation_requests WHERE kind='document-export'")
        .get()!.n,
      1,
    );
    const concurrent = new BusinessDocuments(f.store, async (form, format) => {
      f.ops.savePurchase(
        {
          ...f.current(),
          version: f.current().version,
          status: '待订货',
          notes: '生成期间发生真实版本变化',
        },
        actor,
        f.purchase.id,
      );
      return renderBusinessForm(form, format);
    });
    await assert.rejects(
      () => concurrent.generate(f.exp('purchase', f.purchase.id), actor),
      /文件生成期间单据已更新/,
    );
    assert.equal(f.current().businessStatus, '待订货');
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM operation_requests WHERE kind='document-export'")
        .get()!.n,
      1,
    );
  } finally {
    f.store.close();
  }
});
test('聊天未完成文件交付时不能误报正式订货，后续下载按原回执恢复而不重新生成', async () => {
  const a = assistantFixture(),
    f = setup(a.store);
  try {
    const t = a.manager.create(actor),
      request = f.exp('purchase', f.purchase.id);
    a.replies.push(
      {
        state: 'working',
        message: '准备文件',
        toolCalls: [{ name: 'documents.export', args: request }],
      },
      { state: 'completed', message: '已经正式订货成功。', toolCalls: [] },
    );
    const result = await a.manager.chat(
      t.id,
      a.input('导出Word并正式订货。', randomUUID()),
      actor,
      'test',
      () => {},
      () => actor,
    );
    assert.match(result.messages.at(-1)!.text, /等待浏览器完成下载交付/);
    assert.doesNotMatch(result.messages.at(-1)!.text, /已经正式订货成功/);
    assert.equal(f.current().businessStatus, '待订货');
    const file = f.docs.status(request.requestId, actor);
    f.docs.delivered(file.exportId, actor);
    f.docs.complete(file.exportId, file.sha256, actor);
    a.manager.tasks.verify(t.id, actor, new AssistantTools(f.store));
    assert.equal(
      a.manager.tasks.get(t.id, actor)!.steps.find((s) => s.tool === 'documents.export')!.state,
      'completed',
    );
    assert.equal(f.current().businessStatus, '已订货');
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM operation_requests WHERE kind='document-export'")
        .get()!.n,
      1,
    );
  } finally {
    a.close();
  }
});
test('真实HTTP交付需登录与CSRF，文件完整返回且完整交付回执才修改状态', async () => {
  const f = setup(),
    auth = new AuthManager(':memory:'),
    app = createApp(f.store, { auth }),
    server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as any).port;
    const allowedOrigin = 'http://127.0.0.1:3001';
    let r = await fetch(origin + '/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f.exp('purchase', f.purchase.id)),
    });
    assert.ok(r.status === 401 || r.status === 403);
    const setupResponse = await fetch(origin + '/api/auth/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: allowedOrigin,
        'x-erp-auth-token': auth.csrf,
      },
      body: JSON.stringify({ name: '虚构导出管理员', password: 'fictional-export-pass-123' }),
    });
    assert.equal(setupResponse.status, 200, await setupResponse.clone().text());
    const cookie = setupResponse.headers.get('set-cookie')!.split(';')[0];
    const state = (await (
      await fetch(origin + '/api/auth/state', { headers: { cookie } })
    ).json()) as any;
    const headers = {
      'Content-Type': 'application/json',
      Origin: allowedOrigin,
      cookie,
      'x-erp-auth-token': state.csrf,
    };
    r = await fetch(origin + '/api/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify(f.exp('purchase', f.purchase.id)),
    });
    assert.equal(r.status, 200);
    const file = (await r.json()) as any;
    r = await fetch(origin + file.url, { method: 'HEAD', headers: { cookie } });
    assert.equal(r.status, 200);
    r = await fetch(origin + '/api/documents/' + file.exportId, { headers: { cookie } });
    assert.equal(((await r.json()) as any).deliveredAt, null);
    r = await fetch(origin + '/api/documents/' + file.exportId + '/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sha256: file.sha256 }),
    });
    assert.equal(r.status, 403);
    r = await fetch(origin + file.url, { headers: { cookie } });
    assert.equal(r.status, 200);
    const bytes = await r.arrayBuffer();
    assert.equal(bytes.byteLength, file.size);
    assert.equal(f.current().businessStatus, '待订货');
    r = await fetch(origin + '/api/documents/' + file.exportId + '/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sha256: file.sha256 }),
    });
    assert.equal(r.status, 200);
    assert.equal(f.current().businessStatus, '已订货');
    r = await fetch(origin + '/api/flow/daily?kind=delivery&date=2026-10-29', {
      headers: { cookie },
    });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).summary.pending, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    f.store.close();
  }
});
