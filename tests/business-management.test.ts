import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ImportManager } from '../server/import/manager.js';
import { findImport } from '../server/business/import-execution.js';
import { createApp } from '../server/app.js';
import { headerFields, lineFields, blankField } from '../shared/order-draft.js';
import { docxFixture } from './import-fixtures.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import BusinessRecords from '../src/BusinessRecords.js';
function analysis() {
  const header = Object.fromEntries(headerFields.map((k) => [k, blankField()])),
    line = Object.fromEntries(lineFields.map((k) => [k, blankField()]));
  for (const [k, value] of Object.entries({
    buyerName: '虚构测试买方',
    supplierName: '宁波甬勒包装制品有限公司',
    orderDate: '2026-10-25',
    deliveryDate: '2026-11-01',
    purchaseOrderNumber: 'FICTIONAL-PO-001',
    currency: 'CNY',
    taxRate: '13',
    taxMode: '含税',
    notes: '整单备注',
  }))
    header[k] = { ...blankField(), value };
  for (const [k, value] of Object.entries({
    productName: '原存货名A',
    specification: '300×200×150mm',
    notes: '每捆20只，防潮',
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
    requirements: '粘箱',
    quantity: '1000',
    unit: '只',
    unitPrice: '1.3900',
  }))
    line[k] = { ...blankField(), value };
  return { header, lines: [line], warnings: [] };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-formal-')),
    store = new Store(join(dir, 'business.sqlite')),
    auth = new AuthManager(join(dir, 'users.sqlite'));
  let gate: Promise<void> | null = null,
    entered: () => void = () => {};
  const settings = new AiSettingsManager({
    protector: { protect: () => 'opaque-test-cipher', unprotect: () => 'sk-fictional-formal-test' },
    transport: async () => {
      entered();
      if (gate) await gate;
      return {
        status: 200,
        body: {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(analysis()) }],
            },
          ],
        },
      };
    },
  });
  let v = settings.saveDraft({
    name: '虚构API',
    apiStyle: 'responses',
    endpoint: 'https://api.example.com/v1',
    model: 'test',
    apiKey: 'sk-fictional-formal-test',
    expectedRevision: 0,
  });
  settings.activate({ id: v.presets[0].id, expectedRevision: v.revision });
  const manager = new ImportManager({
      directory: join(dir, 'imports'),
      settings,
      findImport: (id, hash) => findImport(store, id, hash),
      validateMapping: (m) => {
        if (
          m.customer.mode === 'existing' &&
          store.customer(m.customer.id)?.version !== m.customer.version
        )
          throw new Error('客户选择失效');
        for (const p of Object.values(m.products))
          if (p.mode === 'existing' && store.product(p.id)?.version !== p.version)
            throw new Error('产品选择失效');
      },
    }),
    server = createApp(store, {
      aiSettings: settings,
      imports: manager,
      auth,
      enableReviewedImports: true,
      importArchiveDirectory: join(dir, 'source-archive'),
    }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  let cookie = '';
  const request = async (path: string, body?: unknown, anonymous = false) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ERP-AI-Token': settings.csrfToken,
        'X-ERP-Auth-Token': auth.csrf,
        ...(!anonymous && cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await request('/auth/setup', {
    name: '测试管理员',
    password: 'test-password-at-least-12',
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  return {
    dir,
    store,
    settings,
    auth,
    manager,
    request,
    put: (path: string, body: unknown) =>
      fetch(base + path, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-ERP-Auth-Token': auth.csrf,
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      }),
    setGate(p: Promise<void>, callback: () => void) {
      gate = p;
      entered = callback;
    },
    async draft(suffix = '') {
      let w = (
        await manager.upload(Buffer.concat([docxFixture(), Buffer.from(suffix)]), '虚构订单.docx')
      ).workspace;
      const p = settings.view().active!;
      w = manager.consent(w.id, {
        expectedRevision: w.revision,
        accepted: true,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: 'responses',
      });
      return manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      manager.close();
      settings.close();
      auth.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('正式导入需真实登录和绑定预览；字段、精度、来源、审计及幂等重试可靠保存', async () => {
  const f = await fixture();
  try {
    const w = await f.draft();
    assert.equal(
      (await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision }, true))
        .status,
      401,
    );
    let r = await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision });
    assert.equal(r.status, 200);
    const preview = await r.json();
    assert.equal(f.store.customers().length, 0);
    assert.equal(f.store.orders().length, 0);
    assert.equal(preview.plan.order.lines[0].notes, '每捆20只，防潮');
    assert.equal(
      (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: false,
        })
      ).status,
      400,
    );
    r = await f.request('/ai/imports/' + w.id + '/execute', {
      previewId: preview.id,
      acknowledged: true,
      actor: { id: 'forged' },
    });
    assert.equal(r.status, 400);
    r = await f.request('/ai/imports/' + w.id + '/execute', {
      previewId: preview.id,
      acknowledged: true,
    });
    assert.equal(r.status, 200);
    const receipt = await r.json(),
      order = f.store.order(receipt.orderId)!;
    assert.equal(order.lines[0].productName, '原存货名A');
    assert.equal(order.lines[0].specification, '300×200×150mm');
    assert.equal(order.lines[0].notes, '每捆20只，防潮');
    assert.equal(order.lines[0].unit, '只');
    assert.equal(order.lines[0].unitPriceExact, '1.3900');
    assert.equal(order.totalAmountExact, '1390.0000');
    assert.equal(order.externalPurchaseOrder, 'FICTIONAL-PO-001');
    assert.equal(order.importSource!.actorName, '测试管理员');
    assert.ok(readFileSync(receipt.sourcePath).equals(docxFixture()));
    assert.ok(Number(f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n) >= 3);
    const replay = await (
      await f.request('/ai/imports/' + w.id + '/execute', {
        previewId: preview.id,
        acknowledged: true,
      })
    ).json();
    assert.equal(replay.orderId, receipt.orderId);
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.manager.get(w.id).imported!.orderId, order.id);
    assert.throws(() => f.manager.edit(w.id, { expectedRevision: w.revision, operations: [] }));
    const removed = await f.manager.removeMany({
      acknowledged: true,
      items: [{ id: w.id, expectedRevision: w.revision }],
    });
    assert.equal(removed.results[0].removed, true);
    assert.equal(f.store.orders().length, 1);
    assert.ok(existsSync(receipt.sourcePath));
    const reopened = new ImportManager({ directory: join(f.dir, 'imports'), settings: f.settings });
    assert.equal(reopened.status().workspaces.length, 0);
    reopened.close();
    const second = await f.manager.upload(docxFixture(), '再次上传.docx');
    // 已导入过的原件再次上传会建立独立任务；历史订单只作提示，不阻断识别。
    assert.equal(second.duplicate, false);
    assert.equal(second.workspace.imported, undefined);
    assert.equal(second.workspace.historyImport!.orderId, order.id);
    assert.equal(
      (
        await f.request('/ai/imports/' + second.workspace.id + '/preview', {
          expectedRevision: second.workspace.revision,
        })
      ).status,
      409,
    );
    const persisted = new Store(join(f.dir, 'business.sqlite'));
    assert.equal(persisted.orders()[0].lines[0].notes, '每捆20只，防潮');
    assert.equal(
      Number(persisted.db.prepare('SELECT COUNT(*) n FROM import_executions').get()!.n),
      1,
    );
    persisted.close();
  } finally {
    await f.close();
  }
});
test('事务中订单保存失败时新客户/产品/审计一起回滚，修复后同一预览可重试', async () => {
  const f = await fixture();
  try {
    const w = await f.draft(),
      preview = await (
        await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
      ).json();
    f.store.db.exec(
      "CREATE TRIGGER fail_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    const failed = await f.request('/ai/imports/' + w.id + '/execute', {
      previewId: preview.id,
      acknowledged: true,
    });
    assert.equal(failed.status, 500);
    assert.equal(f.store.customers().length, 0);
    assert.equal(f.store.products().length, 0);
    assert.equal(f.store.orders().length, 0);
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n), 0);
    f.store.db.exec('DROP TRIGGER fail_order');
    assert.equal(
      (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});
test('预览过期、改草稿、权限撤销、同名客户歧义和重复采购单均明确拦截', async () => {
  const f = await fixture();
  try {
    let w = await f.draft();
    let preview = await (
      await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
    ).json();
    f.store.db
      .prepare("UPDATE import_previews SET expires_at='2000-01-01' WHERE id=?")
      .run(preview.id);
    assert.equal(
      (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      409,
    );
    preview = await (
      await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
    ).json();
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-header', field: 'notes', value: '新的核对内容', reason: '人工修改' }],
    });
    assert.equal(
      (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      409,
    );
    const { DatabaseSync } = await import('node:sqlite'),
      users = new DatabaseSync(join(f.dir, 'users.sqlite'));
    users.prepare('UPDATE users SET permissions=?').run(JSON.stringify(['business:edit']));
    assert.equal(
      (await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision }))
        .status,
      403,
    );
    users
      .prepare('UPDATE users SET permissions=?')
      .run(JSON.stringify(['business:edit', 'import:execute', 'import:restore']));
    users.close();
    preview = await (
      await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
    ).json();
    assert.equal(
      (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    const second = await f.draft('different-byte-source');
    assert.equal(
      (
        await f.request('/ai/imports/' + second.id + '/preview', {
          expectedRevision: second.revision,
        })
      ).status,
      409,
    );
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});
test('多文件删除一次请求返回部分成功，取消正在识别的文件且重启不复活', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const a = await f.draft(),
      b = await f.draft('other'),
      result = await f.manager.removeMany({
        acknowledged: true,
        items: [
          { id: a.id, expectedRevision: a.revision },
          { id: b.id, expectedRevision: b.revision - 1 },
        ],
      });
    assert.equal(result.results[0].removed, true);
    assert.equal(result.results[1].removed, false);
    assert.equal(f.manager.get(b.id).id, b.id);
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    f.setGate(new Promise<void>((r) => (release = r)), entered);
    const running = f.draft('pending');
    await started;
    const item = f.manager.status().workspaces.find((x) => x.id !== b.id)!;
    const snapshot = f.manager.get(item.id);
    await f.manager.removeMany({
      acknowledged: true,
      items: [{ id: item.id, expectedRevision: snapshot.revision }],
    });
    release();
    await assert.rejects(running);
    assert.ok(!f.manager.status().workspaces.some((x) => x.id === item.id));
    const reopened = new ImportManager({ directory: join(f.dir, 'imports'), settings: f.settings });
    assert.deepEqual(
      reopened.status().workspaces.map((x) => x.id),
      [b.id],
    );
    reopened.close();
  } finally {
    release?.();
    await f.close();
  }
});
test('客户/产品停用不级联历史，订单软删除与恢复带审计，生产及发货禁止删除', async () => {
  const f = await fixture();
  try {
    const w = await f.draft(),
      preview = await (
        await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
      ).json(),
      receipt = await (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).json();
    let order = f.store.order(receipt.orderId)!;
    const customer = f.store.customer(order.customerId)!,
      product = f.store.product(order.lines[0].productId)!;
    assert.equal(
      (
        await f.request(
          '/customers/batch',
          { action: 'archive', acknowledged: true, items: [customer] },
          true,
        )
      ).status,
      401,
    );
    for (const [entity, row] of [
      ['customers', customer],
      ['products', product],
    ] as const) {
      let r = await f.request('/' + entity + '/batch', {
        action: 'archive',
        acknowledged: true,
        items: [{ id: row.id, version: row.version }],
      });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).results[0].success, true);
      assert.equal(f.store.orders().length, 1);
      assert.equal(f.store.order(order.id)!.lines[0].productName, '原存货名A');
      r = await f.request('/' + entity + '/batch', {
        action: 'restore',
        acknowledged: true,
        items: [{ id: row.id, version: row.version }],
      });
      assert.equal((await r.json()).results[0].success, true);
    }
    let r = await f.request('/ai/imports/' + w.id + '/undo-import', { acknowledged: true });
    assert.equal(r.status, 200);
    assert.equal(f.store.orders().length, 0);
    assert.equal(f.store.orders(true).length, 1);
    r = await f.request('/orders/batch', {
      action: 'restore',
      acknowledged: true,
      items: [{ id: order.id, version: order.version }],
    });
    assert.equal((await r.json()).results[0].success, true);
    order = f.store.saveOrder({ ...order, status: '已发货' }, order.id, order.version);
    r = await f.request('/orders/batch', {
      action: 'archive',
      acknowledged: true,
      items: [{ id: order.id, version: order.version }],
    });
    assert.equal((await r.json()).results[0].success, false);
    assert.equal(f.store.orders().length, 1);
    assert.ok(Number(f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n) >= 9);
  } finally {
    await f.close();
  }
});

test('旧版数据兼容迁移保留原始业务行，已归档记录仍可审计和恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-v2-migration-')),
    file = join(dir, 'old.sqlite');
  let store = new Store(file);
  try {
    const c = store.saveCustomer({
        name: '旧客户（虚构）',
        contact: '',
        phone: '',
        address: '',
        notes: '',
      }),
      p = store.saveProduct({
        name: '旧产品',
        length: 1,
        width: 2,
        height: 3,
        material: '测试',
        flute: 'B',
        requirements: '',
        priceCents: 130,
      });
    store.saveOrder({
      customerId: c.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-02',
      status: '草稿',
      notes: '原始订单',
      costs: null,
      lines: [{ productId: p.id, specification: '旧规格保留', quantity: 10, unitPriceCents: 130 }],
    });
    const tables = ['customers', 'products', 'orders', 'order_lines'],
      snapshot = () =>
        JSON.stringify(
          tables.map((t) => store.db.prepare('SELECT * FROM ' + t + ' ORDER BY id').all()),
        ),
      before = snapshot();
    // 仅在新建临时库构造v2形状，禁止操作真实业务库。
    store.db.exec(
      'DROP TABLE import_executions; DROP TABLE import_previews; DROP TABLE business_audit; DROP TABLE record_lifecycle; DELETE FROM schema_migrations WHERE version=3',
    );
    store.close();
    store = new Store(file);
    assert.equal(snapshot(), before);
    assert.equal(
      Number(store.db.prepare('SELECT MAX(version) v FROM schema_migrations').get()!.v),
      10,
    );
    assert.equal(store.orders()[0].lines[0].specification, '旧规格保留');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同名客户必须人工选择，后端拒绝匿名手动写入；多明细表格完整显示独立字段', async () => {
  const f = await fixture();
  try {
    f.store.saveCustomer({
      name: '虚构测试买方',
      contact: '联系人甲',
      phone: '',
      address: '',
      notes: '',
    });
    f.store.saveCustomer({
      name: '虚构测试买方',
      contact: '联系人乙',
      phone: '',
      address: '',
      notes: '',
    });
    const w = await f.draft();
    const response = await f.request('/ai/imports/' + w.id + '/preview', {
      expectedRevision: w.revision,
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /歧义/);
    assert.equal(f.store.orders().length, 0);
    assert.equal(
      (
        await f.request(
          '/customers',
          { name: '越权客户', contact: '', phone: '', address: '', notes: '' },
          true,
        )
      ).status,
      401,
    );
    const line = {
        productName: '独立产品名',
        specification: '300×200mm',
        notes: '防潮包装',
        quantity: 10,
        unit: '只',
        unitPriceCents: 130,
        unitPriceExact: '1.3000',
      },
      row = {
        id: 1,
        version: 1,
        number: 'TEST-ORDER',
        customerName: '虚构客户',
        orderDate: '2026-10-25',
        deliveryDate: '2026-11-01',
        status: '草稿',
        totalCents: 2600,
        lines: [line, { ...line, productName: '第二产品名' }],
      };
    const html = renderToStaticMarkup(
      createElement(BusinessRecords, {
        entity: 'orders',
        rows: [row],
        archived: false,
        setArchived: () => {},
        edit: () => {},
        changed: () => {},
        search: '',
        setSearch: () => {},
      }),
    );
    assert.match(html, /产品名称/);
    assert.match(html, /规格型号/);
    assert.match(html, /备注/);
    assert.match(html, /第二产品名/);
    assert.match(html, /防潮包装/);
    assert.match(html, /1.3000/);
  } finally {
    await f.close();
  }
});

test('并发提交不重复写入；精确匹配复用档案，客户改名后同采购单仍按内部身份去重', async () => {
  const f = await fixture();
  try {
    const w = await f.draft(),
      preview = await (
        await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
      ).json();
    const replies = await Promise.all([
      f.request('/ai/imports/' + w.id + '/execute', { previewId: preview.id, acknowledged: true }),
      f.request('/ai/imports/' + w.id + '/execute', { previewId: preview.id, acknowledged: true }),
    ]);
    assert.ok(replies.every((r) => [200, 409].includes(r.status)));
    assert.equal(f.store.orders().length, 1);
    let second = await f.draft('second-order');
    second = f.manager.edit(second.id, {
      expectedRevision: second.revision,
      operations: [
        {
          op: 'set-header',
          field: 'purchaseOrderNumber',
          value: 'FICTIONAL-PO-002',
          reason: '另一张真实业务单号',
        },
      ],
    });
    let p = await (
      await f.request('/ai/imports/' + second.id + '/preview', {
        expectedRevision: second.revision,
      })
    ).json();
    assert.equal(p.plan.customer.mode, 'existing');
    assert.equal(p.plan.products[0].mode, 'existing');
    assert.equal(
      (
        await f.request('/ai/imports/' + second.id + '/execute', {
          previewId: p.id,
          acknowledged: true,
        })
      ).status,
      200,
    );
    assert.equal(f.store.orders().length, 2);
    assert.equal(f.store.customers().length, 1);
    assert.equal(f.store.products().length, 1);
    const customer = f.store.customers()[0],
      renamed = f.store.saveCustomer(
        { ...customer, name: '改名后的虚构买方' },
        customer.id,
        customer.version,
      ),
      product = f.store.products()[0];
    let third = await f.draft('third-order');
    third = f.manager.edit(third.id, {
      expectedRevision: third.revision,
      operations: [
        {
          op: 'set-header',
          field: 'purchaseOrderNumber',
          value: 'FICTIONAL-PO-002',
          reason: '重复编号测试',
        },
      ],
    });
    third = f.manager.mapping(third.id, {
      expectedRevision: third.revision,
      mapping: {
        customer: { mode: 'existing', id: renamed.id, version: renamed.version },
        products: {
          [third.draft!.lines[0].id]: {
            mode: 'existing',
            id: product.id,
            version: product.version,
          },
        },
        roundingPolicy: 'exact-cents',
      },
    });
    assert.equal(
      (
        await f.request('/ai/imports/' + third.id + '/preview', {
          expectedRevision: third.revision,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test('手工修改带真实操作者审计；已发货改回草稿仍不能删除或撤回', async () => {
  const f = await fixture();
  try {
    const w = await f.draft(),
      preview = await (
        await f.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
      ).json(),
      receipt = await (
        await f.request('/ai/imports/' + w.id + '/execute', {
          previewId: preview.id,
          acknowledged: true,
        })
      ).json();
    let order = f.store.order(receipt.orderId)!;
    let response = await f.put('/orders/' + order.id, { ...order, status: '已发货' });
    assert.equal(response.status, 200);
    order = await response.json();
    response = await f.put('/orders/' + order.id, { ...order, status: '草稿' });
    assert.equal(response.status, 200);
    order = await response.json();
    const audit = f.store.db
      .prepare("SELECT * FROM business_audit WHERE source='manual-ui' ORDER BY id DESC LIMIT 1")
      .get()!;
    assert.equal(audit.actor_name, '测试管理员');
    assert.equal(JSON.parse(String(audit.document)).before.status, '已发货');
    response = await f.request('/orders/batch', {
      action: 'archive',
      acknowledged: true,
      items: [{ id: order.id, version: order.version }],
    });
    assert.equal((await response.json()).results[0].success, false);
    assert.equal(
      (await f.request('/ai/imports/' + w.id + '/undo-import', { acknowledged: true })).status,
      409,
    );
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});
