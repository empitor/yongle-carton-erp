import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ImportManager } from '../server/import/manager.js';
import { findImport } from '../server/business/import-execution.js';
import { standardOrderDraft } from '../server/import/standard-order.js';
import { analysisSchema, blankField, evaluateDraft } from '../shared/order-draft.js';
import { orderSchema, customerSchema, productSchema } from '../shared/domain.js';
import { inspectCurrency } from '../shared/currency.js';
import { docxFixture } from './import-fixtures.js';

const field = (value: string | null) => ({ ...blankField(), value });
function minimal(currency?: string | null): any {
  return {
    header: {
      buyerName: field('币种兼容客户（虚构）'),
      orderDate: field('2026-10-25'),
      deliveryDate: field('2026-11-01'),
      ...(currency !== undefined ? { currency: field(currency) } : {}),
      // 同时覆盖包装本身为空、value为空、空字符串及完全未返回字段。
      notes: null,
      supplierName: field(null),
      taxRate: field(''),
      terms: field('   '),
    },
    lines: [
      {
        productName: field('缺项纸箱A（虚构）'),
        quantity: field('1000'),
        unit: field('只'),
        unitPrice: field('1.3900'),
        specification: field(null),
        notes: null,
        material: field(''),
      },
    ],
  };
}
async function fixture(response = minimal()) {
  const dir = mkdtempSync(join(tmpdir(), 'erp-import-compat-'));
  const file = join(dir, 'erp.sqlite');
  const store = new Store(file),
    auth = new AuthManager(':memory:');
  const settings = new AiSettingsManager({
    protector: { protect: () => 'opaque', unprotect: () => 'sk-fictional-compatibility' },
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
  let view = settings.saveDraft({
    name: '虚构测试',
    endpoint: 'https://api.example.com/v1',
    apiKey: 'sk-fictional-compatibility',
    model: 'test',
    apiStyle: 'responses',
    expectedRevision: 0,
  });
  settings.activate({ id: view.presets[0].id, expectedRevision: view.revision });
  const manager = new ImportManager({
    directory: join(dir, 'imports'),
    settings,
    findImport: (id, hash) => findImport(store, id, hash),
  });
  const server = createApp(store, {
    aiSettings: settings,
    auth,
    imports: manager,
    enableReviewedImports: true,
    importArchiveDirectory: join(dir, 'archive'),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  let cookie = '';
  const request = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
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
    password: 'test-compatibility-password-123',
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  let w = (await manager.upload(docxFixture(), '虚构缺项订单.docx')).workspace;
  const active = settings.view().active!;
  w = manager.consent(w.id, {
    accepted: true,
    expectedRevision: w.revision,
    presetId: active.id,
    endpoint: active.endpoint,
    model: active.model,
    apiStyle: 'responses',
  });
  w = await manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
  return {
    dir,
    file,
    store,
    manager,
    request,
    w,
    async preview() {
      const confirmed = await request('/ai/imports/' + w.id + '/confirm', {
        expectedRevision: manager.get(w.id).revision,
        acknowledged: true,
      });
      assert.equal(confirmed.status, 200, await confirmed.text());
      return request('/ai/imports/' + w.id + '/preview', {
        expectedRevision: manager.get(w.id).revision,
      });
    },
    execute(previewId: string) {
      return request('/ai/imports/' + w.id + '/execute', { previewId, acknowledged: true });
    },
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

test('统一货币校验识别人民币等价写法与缺省，明确外币、混合币种和错误类型仍拒绝', () => {
  const base = {
    customerId: 1,
    orderDate: '2026-10-25',
    deliveryDate: '2026-11-01',
    status: '已确认',
    lines: [{ productId: 1, quantity: 1000, unitPriceCents: 139, unitPriceExact: '1.3900' }],
  };
  for (const currency of [
    'CNY',
    'cny',
    'RMB',
    ' rmb ',
    '人民币',
    '人民币元',
    '元',
    '¥',
    '￥',
    'CN¥',
    'RMB ￥',
    '人民币（CNY）',
    'RMB/¥',
    null,
    undefined,
    '',
    '  ',
    '未注明',
  ]) {
    const order = orderSchema.parse({ ...base, currency });
    assert.equal(order.currency, 'CNY', String(currency));
    assert.equal(order.notes, '');
    assert.equal(order.costs, null);
    assert.equal(order.lines[0].specification, '');
  }
  for (const currency of [
    'USD',
    '美元',
    'US$',
    '$',
    'EUR',
    '欧元',
    'JPY',
    '日元',
    '港币',
    'CNY/USD',
    '人民币/美元',
    'JPY¥',
    '未知币种XYZ',
    123,
    false,
    {},
  ]) {
    assert.equal(
      orderSchema.safeParse({ ...base, currency }).success,
      false,
      JSON.stringify(currency),
    );
    assert.equal(inspectCurrency(currency).currency, null);
  }
  assert.equal(orderSchema.safeParse({ ...base, status: '模型批准' }).success, false);
  assert.equal(orderSchema.safeParse({ ...base, roundingPolicy: '自动舍入' }).success, false);
  assert.equal(
    orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], notes: 12 }] }).success,
    false,
  );
  assert.equal(customerSchema.parse({ name: '虚构客户', contact: null }).contact, '');
  for (const unitPriceExact of [null, '', '   ', undefined]) {
    const parsed = orderSchema.parse({ ...base, lines: [{ ...base.lines[0], unitPriceExact }] });
    assert.equal(parsed.lines[0].unitPriceExact, undefined);
  }
  assert.equal(
    orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], deliveryDate: '2020-01-01' }] })
      .success,
    false,
  );
  assert.equal(
    orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], deliveryDate: '' }] }).success,
    true,
  );
  assert.equal(
    productSchema.parse({ name: '虚构产品', material: null, flute: null, requirements: null })
      .material,
    '',
  );
});

test('AI缺失字段仅补未知包装，不编造业务值；错误字段类型和越权键仍拒绝', () => {
  const parsed = analysisSchema.parse(minimal());
  assert.equal(parsed.header.currency.value, null);
  assert.equal(parsed.header.notes.value, null);
  assert.equal(parsed.lines[0].length.value, null);
  assert.equal(parsed.lines[0].notes.certainty, 'needs-review');
  assert.deepEqual(parsed.warnings, []);
  assert.equal(
    analysisSchema.safeParse({ ...minimal(), sql: 'DELETE FROM orders' }).success,
    false,
  );
  const bad = minimal();
  bad.lines[0].quantity = field(null);
  bad.lines[0].quantity.value = 1000;
  assert.equal(analysisSchema.safeParse(bad).success, false);

  const nullableNotes = minimal() as any;
  nullableNotes.header.orderDate.note = null;
  nullableNotes.header.orderDate.sources = null;
  nullableNotes.header.orderDate.quote = null;
  nullableNotes.lines[0].productName.note = null;
  nullableNotes.lines[0].productName.sources = null;
  nullableNotes.lines[0].productName.quote = null;
  const normalized = analysisSchema.parse(nullableNotes);
  assert.equal(normalized.header.orderDate.note, '');
  assert.deepEqual(normalized.header.orderDate.sources, []);
  assert.equal(normalized.header.orderDate.quote, '');
  assert.equal(normalized.lines[0].productName.note, '');
});

test('人民币别名及缺省订单在大量可选字段同时缺失时均可经HTTP核对、预览、事务正式导入并幂等重试', async () => {
  for (const currency of ['RMB', '人民币', '¥', '￥', ' rmb ', null, '', '   ', undefined]) {
    const f = await fixture(minimal(currency));
    try {
      assert.equal(f.w.draft!.header.currency.value, currency === undefined ? null : currency);
      assert.equal(
        f.w.evaluation!.issues.some((i) => i.severity === 'error'),
        false,
      );
      const res = await f.preview(),
        preview = await res.json();
      assert.equal(res.status, 200, JSON.stringify(preview));
      assert.equal(preview.plan.order.currency, 'CNY');
      assert.equal(preview.plan.order.notes, '');
      assert.equal(preview.plan.order.taxMode, '未明确');
      assert.equal(preview.plan.order.externalPurchaseOrder, '');
      assert.equal(preview.plan.products[0].input.length, null);
      if (inspectCurrency(currency).defaulted)
        assert.ok(preview.plan.warnings.some((s: string) => s.includes('默认保存')));
      const result = await f.execute(preview.id),
        receipt = await result.json();
      assert.equal(result.status, 200, JSON.stringify(receipt));
      const order = f.store.order(receipt.orderId)!;
      assert.equal(order.currency, 'CNY');
      assert.equal(order.costs, null);
      assert.equal(order.lines[0].specification, '');
      assert.equal(order.lines[0].notes, '');
      assert.equal(order.lines[0].unitPriceExact, '1.3900');
      assert.equal(order.totalAmountExact, '1390.0000');
      assert.equal(order.lines[0].productName, '缺项纸箱A（虚构）');
      assert.equal(order.lines[0].unit, '只');
      assert.equal(f.store.customers().length, 1);
      assert.equal(f.store.products().length, 1);
      const replay = await f.execute(preview.id);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).executionId, receipt.executionId);
      assert.equal(f.store.orders().length, 1);
      assert.ok(Number(f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n) >= 3);
      assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
      const reopened = new Store(f.file);
      try {
        assert.equal(reopened.order(receipt.orderId)!.currency, 'CNY');
        assert.equal(reopened.order(receipt.orderId)!.totalAmountExact, '1390.0000');
      } finally {
        reopened.close();
      }
    } finally {
      await f.close();
    }
  }
});

test('明确美元欧元及混合币种不会写库，中文提示可理解；人工修正为RMB后可重新预览导入', async () => {
  for (const currency of ['USD', '美元', 'EUR', '欧元', 'CNY/USD']) {
    const f = await fixture(minimal(currency));
    try {
      assert.ok(
        f.w.evaluation!.issues.some(
          (i) => i.severity === 'error' && i.message.includes('无法自动转换'),
        ),
      );
      const response = await f.preview(),
        error = await response.json();
      assert.equal(response.status, 400);
      assert.match(error.message, /原币种.*无法自动转换/);
      assert.doesNotMatch(error.message, /Invalid input|expected/);
      assert.equal(f.store.customers().length, 0);
      assert.equal(f.store.products().length, 0);
      assert.equal(f.store.orders().length, 0);
      assert.equal(f.manager.get(f.w.id).draft!.header.currency.value, currency);
      const edited = f.manager.edit(f.w.id, {
        expectedRevision: f.manager.get(f.w.id).revision,
        operations: [
          {
            op: 'set-header',
            field: 'currency',
            value: 'RMB',
            reason: '测试用户核对原件后明确修正',
          },
        ],
      });
      assert.equal(edited.confirmedRevision, null);
      const corrected = await f.preview(),
        preview = await corrected.json();
      assert.equal(corrected.status, 200, JSON.stringify(preview));
      assert.equal((await f.execute(preview.id)).status, 200);
    } finally {
      await f.close();
    }
  }
});

test('新建和已有档案均在预览前汇总所有真实错误；有效草稿与原件保留、失败不留孤立记录', async () => {
  const data = minimal('USD');
  data.header.orderDate = field(null);
  data.header.deliveryDate = field(null);
  data.lines[0].quantity = field(null);
  data.lines[0].unitPrice = field(null);
  data.lines[0].unit = field(null);
  const f = await fixture(data);
  try {
    for (const existing of [false, true]) {
      let w = f.manager.get(f.w.id);
      if (existing) {
        const c = f.store.saveCustomer(customerSchema.parse({ name: '币种兼容客户（虚构）' }));
        const p = f.store.saveProduct(productSchema.parse({ name: '缺项纸箱A（虚构）' }));
        w = {
          ...w,
          mapping: {
            customer: { mode: 'existing', id: c.id, version: c.version },
            products: {
              [w.draft!.lines[0].id]: { mode: 'existing', id: p.id, version: p.version },
            },
            roundingPolicy: 'exact-cents',
          },
        };
      } else
        w = {
          ...w,
          mapping: {
            customer: { mode: 'new' },
            products: { [w.draft!.lines[0].id]: { mode: 'new' } },
            roundingPolicy: 'exact-cents',
          },
        };
      const projection = standardOrderDraft(f.store, w)!;
      const text = projection.issues.join('；');
      for (const label of ['币种', '订单日期', '交货日期', '数量', '单价', '数量单位'])
        assert.ok(text.includes(label), label + ':' + text);
      assert.equal(new Set(projection.issues).size, projection.issues.length);
    }
    const result = await f.preview();
    assert.equal(result.status, 400);
    assert.equal(f.store.orders().length, 0);
    assert.ok(f.manager.get(f.w.id).draft);
  } finally {
    await f.close();
  }
});

test('多明细独立税费与交期正确落库、重读及普通编辑保留；金额重算，错误原金额和超精度仍阻止导入', async () => {
  const data = minimal('RMB');
  data.lines[0] = {
    ...data.lines[0],
    taxRate: field('13%'),
    taxMode: field('含税'),
    deliveryDate: field('2026-11-01'),
    specification: field('产品A规格'),
    notes: field('防潮包装'),
  };
  data.lines.push({
    productName: field('缺项纸箱B（虚构）'),
    quantity: field('2000'),
    unit: field('只'),
    unitPrice: field('0.7300'),
    taxRate: field('13'),
    taxMode: field('含税'),
    deliveryDate: field('2026-11-03'),
    notes: field('分批交货'),
  });
  const f = await fixture(data);
  try {
    const res = await f.preview(),
      preview = await res.json();
    assert.equal(res.status, 200, JSON.stringify(preview));
    const result = await f.execute(preview.id),
      receipt = await result.json();
    assert.equal(result.status, 200);
    let order = f.store.order(receipt.orderId)!;
    assert.equal(order.lines.length, 2);
    assert.equal(order.totalAmountExact, '2850.0000');
    assert.equal(order.lines[0].taxRate, '13%');
    assert.equal(order.lines[1].deliveryDate, '2026-11-03');
    assert.equal(order.lines[0].specification, '产品A规格');
    assert.equal(order.lines[1].specification, '');
    const input = orderSchema.parse({
      ...order,
      lines: order.lines.map((l) => {
        const { taxRate, taxMode, deliveryDate, ...rest } = l;
        return rest;
      }),
    });
    f.store.saveOrder(input, order.id, order.version);
    const reopened = new Store(f.file);
    try {
      order = reopened.order(order.id)!;
      assert.equal(order.lines[0].taxRate, '13%');
      assert.equal(order.lines[1].deliveryDate, '2026-11-03');
      assert.equal(order.lines[1].taxMode, '含税');
    } finally {
      reopened.close();
    }
    const wrong = structuredClone(f.w);
    wrong.draft!.lines[0].fields.statedAmount = field('2900');
    assert.ok(
      evaluateDraft(wrong.draft!).issues.some(
        (i) => i.severity === 'error' && i.path.endsWith('statedAmount'),
      ),
    );
  } finally {
    await f.close();
  }
  for (const patch of [
    { statedAmount: '999' },
    { unitPrice: '1.23456' },
    { statedAmount: 'ABC' },
  ]) {
    const bad = minimal('CNY');
    Object.assign(
      bad.lines[0],
      Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, field(v!)])),
    );
    const f = await fixture(bad);
    try {
      assert.equal((await f.preview()).status, 400);
      assert.equal(f.store.orders().length, 0);
      assert.equal(f.store.customers().length, 0);
    } finally {
      await f.close();
    }
  }
});
