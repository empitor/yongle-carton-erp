import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { ReceiptAi, supplierDefaultPreset } from '../server/flow/receipt-ai.js';
import { ImportManager } from '../server/import/manager.js';
import { ImportExecutionService } from '../server/business/import-execution.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/domain.js';
import {
  deliveryCandidates,
  selectedStockUnits,
  warehouseDeliveryHash,
} from '../shared/warehouse-delivery.js';
import {
  recognizedArrivalDraft,
  arrivalTotals,
  convertArrivalUnit,
} from '../shared/arrival-draft.js';
import { makeSettings, actor } from './assistant-fixture.js';
import { imageFixture, xlsxFixture, docxFixture } from './import-fixtures.js';
import { SseParser } from '../shared/sse.js';
import * as XLSX from 'xlsx';
import { validateAttachment } from '../server/assistant/attachment-validation.js';
import { zipFixture } from './import-fixtures.js';

const supplierResult = () => ({
  supplierName: '虚构纸板供应商',
  reference: 'ARRIVAL-NEW-01',
  purchaseNumber: null,
  date: today(),
  notes: null,
  warnings: [],
  lines: [
    {
      name: '瓦楞纸板',
      specification: '1000x500',
      material: 'K3',
      flute: 'B',
      length: '1000',
      width: '500',
      dimensionUnit: 'mm',
      quantity: '10',
      unit: '张',
      area: '5',
      unitPrice: '1.2345',
      priceBasis: 'area',
      notes: '独立纸板库存',
    },
  ],
});
function deliveryFixture() {
  const store = new Store(':memory:'),
    flow = new FlowService(store),
    ops = new OperationsService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '送货甲客户' })),
    other = store.saveCustomer(customerSchema.parse({ name: '送货乙客户' }));
  const products = ['成品一', '成品二'].map((name) =>
    store.saveProduct(productSchema.parse({ name })),
  );
  const stocks = products.map((p) =>
    ops.saveItem(
      { name: p.name, kind: 'finished', productId: p.id, unit: '只', specification: '型号' + p.id },
      actor,
    ),
  );
  for (const stock of stocks)
    ops.move(
      stock.id,
      {
        expectedVersion: stock.version,
        requestId: randomUUID(),
        action: 'in',
        quantity: '50',
        date: today(),
        notes: '隔离验收成品',
        acknowledged: true,
      },
      actor,
    );
  const createOrder = (customerId: number) =>
    store.saveOrder(
      orderSchema.parse({
        customerId,
        orderDate: today(),
        deliveryDate: today(),
        status: '已确认',
        lines: products.map((p, i) => ({
          productId: p.id,
          specification: '型号' + p.id,
          quantity: (i + 1) * 10,
          unit: '只',
          unitPriceCents: 100,
        })),
      }),
    );
  const order = createOrder(customer.id),
    otherOrder = createOrder(other.id);
  return { store, flow, ops, customer, other, products, stocks, order, otherOrder };
}
test('送货候选严格匹配客户/产品/单位/规格，旧链接统一转仓库且分配总量可核对', () => {
  const f = deliveryFixture();
  try {
    const candidates = deliveryCandidates(f.stocks[0], f.customer.id, f.store.orders());
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].orderId, f.order.id);
    assert.equal(
      deliveryCandidates({ ...f.stocks[0], unit: '箱' }, f.customer.id, f.store.orders()).length,
      0,
    );
    assert.equal(
      deliveryCandidates(
        { ...f.stocks[0], specification: '另一规格' },
        f.customer.id,
        f.store.orders(),
      ).length,
      0,
    );
    assert.equal(
      selectedStockUnits(
        [
          { stockId: 1, quantity: '1.5' },
          { stockId: 1, quantity: '2' },
        ],
        1,
      ),
      3500,
    );
    assert.equal(selectedStockUnits([{ stockId: 1, quantity: 'abc' }], 1), null);
    assert.match(warehouseDeliveryHash('#deliveries?order=3'), /^#warehouse\?.*createDelivery=1/);
    assert.match(warehouseDeliveryHash('#deliveries?doc=4&archived=1'), /deliveries=1/);
    assert.equal(warehouseDeliveryHash('#orders'), '#orders');
  } finally {
    f.store.close();
  }
});
test('多产品送货草稿不扣库存，保存/确认幂等、分批履约、完成状态和跨客户保护均经过原服务', () => {
  const f = deliveryFixture();
  try {
    const input = {
      customerId: f.customer.id,
      date: today(),
      address: '虚构地址',
      requestId: randomUUID(),
      lines: f.order.lines.map((l, i) => ({
        orderId: f.order.id,
        orderLineId: l.id,
        stockId: f.stocks[i].id,
        quantity: String((i + 1) * 4),
      })),
    };
    const doc = f.flow.save('delivery', input, actor);
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 50000);
    assert.equal(f.flow.save('delivery', input, actor).id, doc.id);
    assert.equal(f.flow.list('delivery').length, 1);
    assert.throws(
      () => f.flow.save('delivery', { ...input, address: '改变内容' }, actor),
      /同一请求/,
    );
    const preview = f.flow.preview(doc.id, actor, 's'),
      confirm = { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true };
    const saved = f.flow.confirm(doc.id, confirm, actor, 's');
    assert.equal(saved.status, 'confirmed');
    f.flow.confirm(doc.id, confirm, actor, 's');
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 46000);
    assert.equal(f.ops.repo.balance(f.stocks[1].id), 42000);
    assert.equal(f.store.order(f.order.id)!.status, '待发货');
    assert.equal(f.store.order(f.order.id)!.lines[0].remainingQuantity, 6);
    const second = f.flow.save(
      'delivery',
      {
        ...input,
        requestId: randomUUID(),
        lines: f.order.lines.map((l, i) => ({
          orderId: f.order.id,
          orderLineId: l.id,
          stockId: f.stocks[i].id,
          quantity: String((i + 1) * 6),
        })),
      },
      actor,
    );
    const p2 = f.flow.preview(second.id, actor, 's');
    f.flow.confirm(
      second.id,
      { previewId: p2.previewId, requestId: randomUUID(), acknowledged: true },
      actor,
      's',
    );
    assert.equal(f.store.order(f.order.id)!.status, '已发货');
    assert.equal(f.store.order(f.order.id)!.lines[1].remainingQuantity, 0);
    assert.equal(f.store.order(f.otherOrder.id)!.lines[0].shippedQuantity, 0);
    assert.throws(
      () =>
        f.flow.save(
          'delivery',
          { ...input, requestId: randomUUID(), customerId: f.other.id },
          actor,
        ),
      /同一客户/,
    );
    assert.throws(() =>
      f.flow.save(
        'delivery',
        {
          ...input,
          requestId: randomUUID(),
          lines: [{ ...input.lines[0], orderId: null, orderLineId: null }],
        },
        actor,
      ),
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('库存不足或同成品跨订单合计超过余额时禁止确认，失败不写半张单据', () => {
  const f = deliveryFixture();
  try {
    const otherSameCustomer = f.store.saveOrder(
      orderSchema.parse({
        ...f.order,
        lines: f.order.lines.map((l) => ({ ...l, id: undefined, quantity: 100 })),
      }),
    );
    const doc = f.flow.save(
      'delivery',
      {
        customerId: f.customer.id,
        date: today(),
        lines: [
          {
            orderId: otherSameCustomer.id,
            orderLineId: otherSameCustomer.lines[0].id,
            stockId: f.stocks[0].id,
            quantity: '51',
          },
        ],
      },
      actor,
    );
    assert.throws(() => f.flow.preview(doc.id, actor, 's'), /库存不足/);
    assert.equal(f.flow.get(doc.id).status, 'draft');
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 50000);
    const split = f.flow.save(
      'delivery',
      {
        customerId: f.customer.id,
        date: today(),
        lines: [
          {
            orderId: otherSameCustomer.id,
            orderLineId: otherSameCustomer.lines[0].id,
            stockId: f.stocks[0].id,
            quantity: '45',
          },
          {
            orderId: f.order.id,
            orderLineId: f.order.lines[0].id,
            stockId: f.stocks[0].id,
            quantity: '6',
          },
        ],
      },
      actor,
    );
    assert.throws(() => f.flow.preview(split.id, actor, 's'), /库存不足/);
    assert.equal(f.flow.get(split.id).status, 'draft');
    assert.equal(f.ops.repo.balance(f.stocks[0].id), 50000);
  } finally {
    f.store.close();
  }
});

test('普通XLSX的未使用宏类型声明不误拦截，实际宏部件和宏主文档仍拒绝', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['虚构纸板', 10]]), '到货');
  await validateAttachment(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), '普通.xlsx');
  const examples: Record<string, string>[] = [
    {
      '[Content_Types].xml':
        '<Types><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
      'xl/workbook.xml': '<workbook/>',
      'xl/test.bin': 'fake',
    },
    {
      '[Content_Types].xml':
        '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
      'xl/workbook.xml': '<workbook/>',
    },
    {
      '[Content_Types].xml':
        '<c:Types xmlns:c="http://schemas.openxmlformats.org/package/2006/content-types"><c:Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></c:Types>',
      'xl/workbook.xml': '<workbook/>',
    },
  ];
  for (const files of examples)
    await assert.rejects(() => validateAttachment(zipFixture(files), '宏.xlsx'), /不接受宏/);
});
test('到货转换不猜日期、未知单位或计价；重识别保留草稿ID；cm/mm切换保持面积', () => {
  const result = supplierResult();
  result.date = null as any;
  result.lines[0].dimensionUnit = '未知';
  result.lines[0].unit = '件';
  result.lines[0].priceBasis = null as any;
  const r = recognizedArrivalDraft({ id: randomUUID(), result }, [], {
    id: 8,
    version: 2,
    status: 'draft',
  });
  assert.equal(r.draft.id, 8);
  assert.equal(r.draft.version, 2);
  assert.equal(r.draft.date, '');
  assert.equal(r.draft.lines[0].quantity, '');
  assert.equal(r.draft.lines[0].item.dimensionUnit, null);
  assert.equal(r.draft.lines[0].priceBasis, null);
  assert(r.warnings.some((w) => w.includes('不会自动使用今天')));
  const normal = recognizedArrivalDraft({ id: randomUUID(), result: supplierResult() }, []).draft;
  const before = arrivalTotals(normal.lines);
  normal.lines[0].item = convertArrivalUnit(normal.lines[0].item, 'cm');
  assert.equal(normal.lines[0].item.length, 100);
  assert.equal(arrivalTotals(normal.lines).area, before.area);
  assert.equal(before.area, '5');
});

async function arrivalFixture(deepseek = false) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-warehouse-arrival-')),
    requests: any[] = [];
  let malformed = false;
  const settings = makeSettings(async (request) => {
    requests.push(request);
    const result = supplierResult();
    const response = {
      status: malformed ? 'incomplete' : 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(result) }],
        },
      ],
    };
    if ((request.body as any).stream) {
      request.onSseEvent?.({
        event: 'response.output_text.delta',
        data: JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(result) }),
      });
      request.onSseEvent?.({
        event: malformed ? 'response.incomplete' : 'response.completed',
        data: JSON.stringify({
          type: malformed ? 'response.incomplete' : 'response.completed',
          response,
        }),
      });
      return { status: 200, body: null, streamed: true };
    }
    return { status: 200, body: response };
  });
  if (deepseek) {
    const v = settings.view(),
      active = v.active!;
    const next = settings.saveDraft({
      id: active.id,
      name: active.name,
      endpoint: 'https://api.deepseek.com/v1',
      apiStyle: 'responses',
      model: active.model,
      apiKey: 'sk-fictional-deepseek-only',
      expectedRevision: v.revision,
    });
    settings.activate({ id: active.id, expectedRevision: next.revision });
  }
  const store = new Store(join(directory, 'erp.sqlite')),
    prompts = new PromptPresetManager(':memory:', supplierDefaultPreset),
    orderPrompts = new PromptPresetManager(':memory:');
  const ai = new ReceiptAi(store, settings, prompts),
    imports = new ImportManager({
      directory: join(directory, 'imports'),
      settings,
      promptPresets: orderPrompts,
    });
  return {
    directory,
    requests,
    store,
    settings,
    prompts,
    ai,
    imports,
    malformed: (v: boolean) => {
      malformed = v;
    },
    close() {
      imports.close();
      orderPrompts.close();
      prompts.close();
      settings.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('DeepSeek到货识别需新范围授权，兼容提取保留原件与独立提示词，不写库存', async () => {
  const f = await arrivalFixture(true);
  try {
    for (const [name, bytes] of [
      ['虚构.docx', docxFixture()],
      ['虚构.xlsx', xlsxFixture()],
      ['虚构.png', imageFixture()],
    ] as const) {
      const original = f.ai.upload(bytes, name, actor)!;
      await assert.rejects(
        () =>
          f.ai.analyze(
            original.id,
            { consent: true, stream: false, profile: f.settings.view().active },
            actor,
          ),
        /重新确认/,
      );
      const result = await f.ai.analyze(
        original.id,
        { consent: true, policyVersion: 4, stream: true, profile: f.settings.view().active },
        actor,
      );
      assert.equal(result!.result.reference, 'ARRIVAL-NEW-01');
      const body = JSON.stringify(f.requests.at(-1)!.body);
      assert(!body.includes('input_file'));
      assert.match(body, /供应商/);
      if (name.endsWith('.png')) assert(body.includes(bytes.toString('base64')));
      else assert.match(body, /兼容提取内容/);
      assert.equal(f.ai.source(original.id).hash, createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 0);
  } finally {
    f.close();
  }
});
test('双模式HTTP桥接：流式完整结果持久恢复、关联鉴权/来源校验、只确认原材料入库与重复防护', async () => {
  const f = await arrivalFixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, {
      auth,
      aiSettings: f.settings,
      imports: f.imports,
      receiptAi: f.ai,
    }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({
        name: '双模式虚构验收',
        password: 'fictional-warehouse-password-123',
      }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const post = (path: string, body: any, login = true) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ERP-AI-Token': f.imports.csrfToken,
          'X-ERP-Auth-Token': auth.csrf,
          ...(login ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    let w = (await f.imports.upload(imageFixture(), '到货.png')).workspace;
    const path = '/api/ai/imports/' + w.id;
    assert.equal(
      (await post(path + '/arrival/recognize', { consent: true, stream: false })).status,
      409,
    );
    w = f.imports.setMode(w.id, { mode: 'arrival', expectedRevision: w.revision });
    const wire = await (
      await post(path + '/arrival/recognize', { consent: true, stream: true })
    ).text();
    let source: any;
    new SseParser((e) => {
      if (e.event === 'result') source = JSON.parse(e.data);
    }).push(wire);
    assert(source?.result);
    w = f.imports.get(w.id);
    assert.equal(w.arrivalSourceId, source.id);
    assert.equal(w.draft, null);
    const restarted = new ImportManager({
      directory: join(f.directory, 'imports'),
      settings: f.settings,
      promptPresets: new PromptPresetManager(':memory:'),
    });
    assert.equal(restarted.get(w.id).arrivalSourceId, source.id);
    restarted.close();
    const ops = new OperationsService(f.store),
      supplier = ops.saveSupplier({ name: '虚构纸板供应商' }, actor),
      flow = new FlowService(f.store);
    const draft = recognizedArrivalDraft(source, [supplier]).draft;
    const doc = flow.save('arrival', { ...draft, requestId: randomUUID() }, actor);
    assert.equal(
      (
        await post(
          path + '/arrival/link',
          { expectedRevision: w.revision, docId: doc.id, sourceId: source.id },
          false,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(path + '/arrival/link', {
          expectedRevision: w.revision,
          docId: doc.id,
          sourceId: source.id,
        })
      ).status,
      200,
    );
    const preview = flow.preview(doc.id, actor, 's'),
      input = { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true };
    flow.confirm(doc.id, input, actor, 's');
    flow.confirm(doc.id, input, actor, 's');
    assert.equal(
      (
        await post(path + '/mode', {
          mode: 'order',
          expectedRevision: f.imports.get(w.id).revision,
        })
      ).status,
      409,
    );
    assert.equal(ops.repo.items().length, 1);
    assert.equal(ops.repo.items()[0].kind, 'raw');
    assert.equal(ops.repo.items()[0].quantity, '10');
    assert.equal(ops.repo.movements().length, 1);
    assert.equal(f.store.orders().length, 0);
    const other = f.ai.upload(docxFixture(), '其他.docx', actor)!;
    assert.equal(
      (
        await post(path + '/arrival/link', {
          expectedRevision: f.imports.get(w.id).revision,
          docId: doc.id,
          sourceId: other.id,
        })
      ).status,
      409,
    );
    const importer = new ImportExecutionService(f.store, f.imports, join(f.directory, 'archive'));
    await assert.rejects(
      () =>
        importer.preview(
          w.id,
          { expectedRevision: f.imports.get(w.id).revision },
          { ...actor, permissions: ['business:edit', 'import:execute'] },
        ),
      /到货单/,
    );
    const sourcesBefore = f.ai.sources().length;
    f.malformed(true);
    let bad = (await f.imports.upload(docxFixture(), '失败到货.docx')).workspace;
    bad = f.imports.setMode(bad.id, { mode: 'arrival', expectedRevision: bad.revision });
    const failed = await (
      await post('/api/ai/imports/' + bad.id + '/arrival/recognize', {
        consent: true,
        stream: true,
      })
    ).text();
    assert.match(failed, /event: error/);
    assert(!failed.includes('event: result'));
    assert.equal(f.imports.failures(bad.id).total, 1);
    assert.equal(ops.repo.movements().length, 1);
    assert.equal(f.ai.sources().length, sourcesBefore);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});
