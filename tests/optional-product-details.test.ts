import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/auth.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ImportManager } from '../server/import/manager.js';
import { findImport } from '../server/business/import-execution.js';
import { productSchema } from '../shared/domain.js';
import {
  convertDimension,
  normalizeDimensionUnit,
  normalizedDimensions,
  productNotices,
} from '../shared/product-details.js';
import { headerFields, lineFields, blankField, evaluateDraft } from '../shared/order-draft.js';
import { standardOrderDraft } from '../server/import/standard-order.js';
import { docxFixture } from './import-fixtures.js';
function analysis() {
  const header = Object.fromEntries(headerFields.map((k) => [k, blankField()])),
    line = Object.fromEntries(lineFields.map((k) => [k, blankField()]));
  for (const [k, value] of Object.entries({
    buyerName: '可选资料客户（虚构）',
    supplierName: '宁波甬勒包装制品有限公司',
    orderDate: '2026-10-25',
    deliveryDate: '2026-11-01',
    currency: 'CNY',
    taxMode: '含税',
    purchaseOrderNumber: 'OPTIONAL-TEST-001',
  }))
    header[k] = { ...blankField(), value };
  for (const [k, value] of Object.entries({
    productName: '名称已明确的纸箱A',
    specification: '原单规格型号保持',
    notes: '包装备注保持',
    quantity: '1000',
    unit: '只',
    unitPrice: '1.3900',
  }))
    line[k] = { ...blankField(), value };
  return { header, lines: [line], warnings: [] };
}
async function fixture(response = analysis()) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-optional-')),
    store = new Store(join(dir, 'db.sqlite')),
    auth = new AuthManager(':memory:'),
    settings = new AiSettingsManager({
      protector: { protect: () => 'opaque', unprotect: () => 'sk-fictional-optional' },
      transport: async () => ({
        status: 200,
        body: {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(response) }],
            },
          ],
        },
      }),
    });
  let v = settings.saveDraft({
    name: '虚构连接',
    endpoint: 'https://api.example.com/v1',
    model: 'test',
    apiStyle: 'responses',
    apiKey: 'sk-fictional-optional',
    expectedRevision: 0,
  });
  settings.activate({ id: v.presets[0].id, expectedRevision: v.revision });
  const manager = new ImportManager({
      directory: join(dir, 'imports'),
      settings,
      findImport: (id, hash) => findImport(store, id, hash),
    }),
    server = createApp(store, {
      imports: manager,
      auth,
      aiSettings: settings,
      enableReviewedImports: true,
      importArchiveDirectory: join(dir, 'sources'),
    }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  let cookie = '';
  const request = (path: string, body?: unknown, method = 'POST') =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : method,
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-Auth-Token': auth.csrf,
        'X-ERP-AI-Token': settings.csrfToken,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await request('/auth/setup', {
    name: '测试管理员',
    password: 'test-password-at-least-12',
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  let w = (await manager.upload(docxFixture(), '可选资料测试.docx')).workspace;
  const p = settings.view().active!;
  w = manager.consent(w.id, {
    accepted: true,
    expectedRevision: w.revision,
    presetId: p.id,
    endpoint: p.endpoint,
    model: p.model,
    apiStyle: 'responses',
  });
  w = await manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
  return {
    dir,
    store,
    manager,
    request,
    w,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      manager.close();
      auth.close();
      settings.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('产品仅名称必填，真正NULL保存缺失尺寸；错误数值及错误单位仍被拒绝', () => {
  const p = productSchema.parse({ name: '仅名称' });
  assert.equal(p.length, null);
  assert.equal(p.width, null);
  assert.equal(p.height, null);
  assert.equal(p.material, '');
  assert.equal(p.flute, '');
  const store = new Store(':memory:');
  try {
    const saved = store.saveProduct(p);
    assert.equal(saved.length, null);
    assert.equal(saved.dimensionUnit, null);
    assert.equal(store.db.prepare('SELECT length FROM products').get()!.length, null);
    for (const wrong of [
      { name: '' },
      { name: 'A', length: 0 },
      { name: 'A', width: -1 },
      { name: 'A', height: NaN },
      { name: 'A', dimensionUnit: 'inch' },
      { name: 'A', length: 1001, dimensionUnit: 'cm' },
    ])
      assert.equal(productSchema.safeParse(wrong).success, false);
    assert.throws(() => store.db.prepare('UPDATE products SET width=0').run());
  } finally {
    store.close();
  }
});
test('缺长宽高/配纸/类型且单位未知的新产品可通过HTTP正式入库，字段金额不丢失', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/ai/imports/' + f.w.id + '/preview', {
      expectedRevision: f.w.revision,
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.plan.products[0].input.length, null);
    assert.equal(preview.plan.products[0].input.dimensionUnit, null);
    assert.ok(preview.plan.warnings.some((s: string) => s.includes('可后续补充')));
    const result = await f.request('/ai/imports/' + f.w.id + '/execute', {
      previewId: preview.id,
      acknowledged: true,
    });
    assert.equal(result.status, 200);
    const receipt = await result.json(),
      product = f.store.products()[0],
      order = f.store.order(receipt.orderId)!;
    assert.equal(product.material, '');
    assert.equal(product.flute, '');
    assert.equal(product.dimensionUnit, null);
    assert.equal(product.length, null);
    assert.equal(order.lines[0].productName, '名称已明确的纸箱A');
    assert.equal(order.lines[0].specification, '原单规格型号保持');
    assert.equal(order.lines[0].notes, '包装备注保持');
    assert.equal(order.lines[0].unitPriceExact, '1.3900');
    assert.equal(order.totalAmountExact, '1390.0000');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});
test('cm与mm均可创建产品及正式导入，小数和1cm=10mm换算往返不改变实际尺寸', async () => {
  for (const unit of ['cm', 'mm'] as const) {
    const data = analysis();
    for (const [k, value] of Object.entries({
      length: unit === 'cm' ? '30.25' : '302.5',
      width: unit === 'cm' ? '20' : '200',
      height: unit === 'cm' ? '15' : '150',
      dimensionUnit: unit,
    }))
      data.lines[0][k] = { ...blankField(), value };
    const f = await fixture(data);
    try {
      const previewResponse = await f.request('/ai/imports/' + f.w.id + '/preview', {
        expectedRevision: f.w.revision,
      });
      assert.equal(previewResponse.status, 200);
      const preview = await previewResponse.json();
      assert.equal(
        (
          await f.request('/ai/imports/' + f.w.id + '/execute', {
            previewId: preview.id,
            acknowledged: true,
          })
        ).status,
        200,
      );
      const saved = f.store.products()[0];
      assert.equal(saved.dimensionUnit, unit);
      assert.deepEqual(normalizedDimensions(saved), [302.5, 200, 150]);
    } finally {
      await f.close();
    }
  }
  for (const value of [0.29, 12.5, 300.125, 10000])
    assert.equal(convertDimension(convertDimension(value, 'mm', 'cm'), 'cm', 'mm'), value);
  assert.equal(convertDimension(0.29, 'cm', 'mm'), 2.9);
});
test('草稿只切换单位时后端同步换算尺寸，保存/撤销保持原始规格和实际大小', async () => {
  const data = analysis();
  for (const [k, value] of Object.entries({
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
  }))
    data.lines[0][k] = { ...blankField(), value };
  const f = await fixture(data);
  try {
    let w = f.w;
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [
        {
          op: 'set-line',
          lineId: w.draft!.lines[0].id,
          field: 'dimensionUnit',
          value: 'cm',
          reason: '用户切换单位',
        },
      ],
    });
    assert.equal(w.draft!.lines[0].fields.length.value, '30');
    assert.equal(w.draft!.lines[0].fields.width.value, '20');
    assert.equal(w.draft!.lines[0].fields.height.value, '15');
    assert.equal(w.draft!.lines[0].fields.specification.value, '原单规格型号保持');
    assert.equal(w.evaluation!.totalAmount, '1390.0000');
    w = f.manager.undo(w.id, { expectedRevision: w.revision });
    assert.equal(w.draft!.lines[0].fields.length.value, '300');
    assert.equal(w.draft!.lines[0].fields.dimensionUnit.value, 'mm');
  } finally {
    await f.close();
  }
});
test('未知单位不当成毫米、无本地推算，保留原文且允许后续确认', async () => {
  const data = analysis();
  data.lines[0].length = { ...blankField(), value: '3.5' };
  data.lines[0].dimensionUnit = { ...blankField(), value: '英寸' };
  const f = await fixture(data);
  try {
    const response = await f.request('/ai/imports/' + f.w.id + '/preview', {
      expectedRevision: f.w.revision,
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.plan.products[0].input.dimensionUnit, null);
    assert.equal(preview.plan.products[0].input.dimensionUnitRaw, '英寸');
    assert.equal(preview.plan.products[0].input.length, 3.5);
    assert.equal(
      (
        await f.request('/ai/imports/' + f.w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    assert.equal(f.store.products()[0].dimensionUnit, null);
    assert.equal(f.store.products()[0].dimensionUnitRaw, '英寸');
    assert.equal(normalizeDimensionUnit('unknown'), null);
  } finally {
    await f.close();
  }
});
test('同名产品同类补充提醒合并一次且不是红色错误，真正尺寸错误仍阻止提交', async () => {
  const f = await fixture();
  try {
    const w = structuredClone(f.w);
    w.draft!.lines.push({ ...structuredClone(w.draft!.lines[0]), id: crypto.randomUUID() });
    w.mapping = {
      customer: { mode: 'new' },
      products: Object.fromEntries(w.draft!.lines.map((l) => [l.id, { mode: 'new' }])),
      roundingPolicy: 'exact-cents',
    };
    const projection = standardOrderDraft(f.store, w)!;
    assert.deepEqual(projection.issues, []);
    assert.equal(projection.notices.filter((s) => s.includes('可后续补充')).length, 1);
    const evaluation = evaluateDraft(w.draft!);
    assert.ok(!evaluation.issues.some((i) => i.severity === 'error'));
    assert.equal(evaluation.issues.filter((i) => i.message.includes('可后续补充')).length, 1);
    assert.equal(new Set(projection.notices).size, projection.notices.length);
    const line = w.draft!.lines[0];
    line.fields.length.value = '-5';
    assert.ok(standardOrderDraft(f.store, w)!.issues.length);
    assert.ok(
      evaluateDraft(w.draft!).issues.some(
        (i) => i.severity === 'error' && i.message.includes('长'),
      ),
    );
    assert.equal(
      productNotices([
        { name: 'A', length: null },
        { name: 'A', length: null },
      ]).filter((s) => s.includes('可后续补充')).length,
      1,
    );
  } finally {
    await f.close();
  }
});
test('旧products表兼容迁移保留历史产品、价格扩展和订单外键，原尺寸明确为mm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-product-v3-')),
    file = join(dir, 'old.sqlite');
  let store = new Store(file);
  try {
    const c = store.saveCustomer({
        name: '历史客户',
        contact: '',
        phone: '',
        address: '',
        notes: '',
      }),
      p = store.saveProduct(
        productSchema.parse({
          name: '历史产品',
          length: 300,
          width: 200,
          height: 150,
          dimensionUnit: 'mm',
          material: '牛卡',
          flute: 'B',
          priceCents: 139,
          priceExact: '1.3900',
        }),
      );
    const order = store.saveOrder({
      customerId: c.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-02',
      status: '草稿',
      notes: '历史原文',
      costs: null,
      lines: [
        {
          productId: p.id,
          productName: '历史存货名称',
          specification: '历史规格快照',
          notes: '原备注',
          quantity: 1000,
          unitPriceCents: 139,
          unitPriceExact: '1.3900',
        },
      ],
    });
    const before = JSON.stringify(store.orders());
    store.db.exec(
      'PRAGMA foreign_keys=OFF; BEGIN; CREATE TABLE products_legacy(id INTEGER PRIMARY KEY,name TEXT NOT NULL,length INTEGER NOT NULL CHECK(length>0),width INTEGER NOT NULL CHECK(width>0),height INTEGER NOT NULL CHECK(height>0),material TEXT NOT NULL,flute TEXT NOT NULL,requirements TEXT NOT NULL,price_cents INTEGER NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL); INSERT INTO products_legacy SELECT id,name,length,width,height,material,flute,requirements,price_cents,version,created_at FROM products; DROP TABLE products; ALTER TABLE products_legacy RENAME TO products; DELETE FROM schema_migrations WHERE version=4; COMMIT; PRAGMA foreign_keys=ON',
    );
    store.close();
    store = new Store(file);
    assert.equal(store.product(p.id)!.dimensionUnit, 'mm');
    assert.equal(store.product(p.id)!.length, 300);
    assert.equal(store.product(p.id)!.priceExact, '1.3900');
    assert.equal(JSON.stringify(store.orders()), before);
    assert.equal(store.order(order.id)!.lines[0].notes, '原备注');
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    const fresh = store.saveProduct(productSchema.parse({ name: '新的不完整产品' }));
    assert.equal(fresh.length, null);
    assert.equal(fresh.dimensionUnit, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一实际尺寸的cm档案与mm草稿能够正确匹配，不创建重复产品或改变旧档案', async () => {
  const data = analysis();
  for (const [k, value] of Object.entries({
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
  }))
    data.lines[0][k] = { ...blankField(), value };
  const f = await fixture(data);
  try {
    const product = f.store.saveProduct(
      productSchema.parse({
        name: '名称已明确的纸箱A',
        length: 30,
        width: 20,
        height: 15,
        dimensionUnit: 'cm',
        material: '牛卡',
        flute: 'B',
        priceCents: 139,
      }),
    );
    const response = await f.request('/ai/imports/' + f.w.id + '/preview', {
      expectedRevision: f.w.revision,
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.plan.products[0].mode, 'existing');
    assert.equal(preview.plan.products[0].id, product.id);
    assert.equal(
      (
        await f.request('/ai/imports/' + f.w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    assert.equal(f.store.products().length, 1);
    assert.equal(f.store.product(product.id)!.length, 30);
    assert.equal(f.store.product(product.id)!.dimensionUnit, 'cm');
    assert.equal(f.store.orders()[0].lines[0].unitPriceExact, '1.3900');
  } finally {
    await f.close();
  }
});
