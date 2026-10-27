import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/db.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { ImportManager } from '../server/import/manager.js';
import { findImport } from '../server/business/import-execution.js';
import { ImportRepository } from '../server/import/repository.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { blankField } from '../shared/order-draft.js';
import { docxFixture } from './import-fixtures.js';
import BusinessRecords from '../src/BusinessRecords.js';
import RecordDetails from '../src/RecordDetails.js';
const password = 'fictional-admin-password-123';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-super-')),
    file = join(dir, 'erp.sqlite'),
    authFile = join(dir, 'users.sqlite'),
    store = new Store(file);
  const db = new DatabaseSync(authFile),
    ownerId = randomUUID(),
    salt = 'fictional-legacy-salt',
    passwordHash = scryptSync(password, salt, 64).toString('hex'),
    permissions = JSON.stringify(['business:edit', 'import:execute', 'import:restore']);
  db.exec(
    'CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,permissions TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(
    ownerId,
    '原管理员',
    salt,
    passwordHash,
    permissions,
  );
  db.close();
  let now = Date.now();
  const auth = new AuthManager(authFile, () => now),
    adminDb = new DatabaseSync(authFile);
  adminDb
    .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), '普通管理员', salt, passwordHash, permissions, 'admin');
  adminDb
    .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), '只读账号', salt, passwordHash, '[]', 'admin');
  adminDb.close();
  let aiSerial = 0;
  const settings = new AiSettingsManager({
    protector: { protect: () => 'opaque', unprotect: () => 'sk-fictional-super-test' },
    transport: async () => {
      // 每次识别返回唯一客户/产品名称，避免多次导入时同名档案要求人工选择映射。
      aiSerial += 1;
      const serial = String(aiSerial),
        buyerName = 'AI客户（虚构）' + serial,
        productName = 'AI纸箱（虚构）' + serial;
      return {
        status: 200,
        body: {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    header: {
                      buyerName: { ...blankField(), value: buyerName },
                      orderDate: { ...blankField(), value: '2026-10-25' },
                      deliveryDate: { ...blankField(), value: '2026-11-01' },
                    },
                    lines: [
                      {
                        productName: { ...blankField(), value: productName },
                        unit: { ...blankField(), value: '只' },
                        quantity: { ...blankField(), value: '1000' },
                        unitPrice: { ...blankField(), value: '1.3900' },
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        },
      };
    },
  });
  let state = settings.saveDraft({
    name: '虚构API',
    endpoint: 'https://api.example.com/v1',
    apiKey: 'sk-fictional-super-test',
    apiStyle: 'responses',
    model: 'test',
    expectedRevision: 0,
  });
  settings.activate({ id: state.presets[0].id, expectedRevision: state.revision });
  const manager = new ImportManager({
      directory: join(dir, 'imports'),
      settings,
      findImport: (id, hash) => findImport(store, id, hash),
    }),
    server = createApp(store, {
      auth,
      aiSettings: settings,
      imports: manager,
      enableReviewedImports: true,
      importArchiveDirectory: join(dir, 'archive'),
    }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  async function client(name?: string) {
    let cookie = '';
    const request = (path: string, body?: unknown, method = 'POST', csrf = true) =>
      fetch(base + path, {
        method: body === undefined ? 'GET' : method,
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-ERP-Auth-Token': auth.csrf } : {}),
          'X-ERP-AI-Token': settings.csrfToken,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    if (name) {
      const r = await request('/auth/login', { name, password });
      assert.equal(r.status, 200);
      cookie = r.headers.get('set-cookie')!.split(';')[0];
    }
    return {
      request,
      enter: () => request('/auth/super-admin/enter', { password }),
      exit: () => request('/auth/super-admin/exit', {}),
    };
  }
  const owner = await client('原管理员'),
    admin = await client('普通管理员'),
    reader = await client('只读账号'),
    anonymous = await client();
  const customer = store.saveCustomer(customerSchema.parse({ name: '已有客户（虚构）' })),
    product = store.saveProduct(productSchema.parse({ name: '已有纸箱（虚构）' }));
  const addOrder = (status: '草稿' | '已发货' = '草稿') =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-25',
        deliveryDate: '2026-11-01',
        status,
        lines: [
          {
            productId: product.id,
            productName: product.name,
            specification: '独立规格',
            notes: '独立备注',
            unit: '只',
            quantity: 1000,
            unitPriceCents: 139,
            unitPriceExact: '1.3900',
          },
        ],
      }),
    );
  const order = addOrder();
  const lifecycle = (
    c: typeof owner,
    entity: string,
    row: { id: number; version: number },
    action = 'archive',
  ) =>
    c.request('/' + entity + '/batch', {
      action,
      acknowledged: true,
      items: [{ id: row.id, version: row.version }],
    });
  const preview = async (
    c: typeof owner,
    entity: string,
    rows: { id: number; version: number }[],
    includeRelatedOrders = false,
  ) => {
    const r = await c.request('/admin/permanent-deletions/preview', {
      entity,
      items: rows.map(({ id, version }) => ({ id, version })),
      includeRelatedOrders,
    });
    const data = await r.json();
    return { status: r.status, data };
  };
  const execute = (c: typeof owner, id: string, extra: Record<string, unknown> = {}) =>
    c.request('/admin/permanent-deletions/execute', {
      previewId: id,
      acknowledged: true,
      confirmation: '永久删除',
      password,
      ...extra,
    });
  return {
    dir,
    file,
    authFile,
    ownerId,
    passwordHash,
    salt,
    permissions,
    store,
    auth,
    manager,
    settings,
    owner,
    admin,
    reader,
    anonymous,
    customer,
    product,
    order,
    client,
    addOrder,
    lifecycle,
    preview,
    execute,
    advance: (ms: number) => {
      now += ms;
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

test('旧唯一管理员原账号提升最高权限，凭据完全保留；普通账号不提升，重启保留角色但清空会话', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.authFile, { readOnly: true });
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(f.ownerId)!;
    assert.equal(row.role, 'super_admin');
    assert.equal(row.password_hash, f.passwordHash);
    assert.equal(row.salt, f.salt);
    assert.equal(row.permissions, f.permissions);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get()!.n, 3);
    db.close();
    const reopened = new AuthManager(f.authFile);
    assert.equal(
      reopened.actor({ headers: { cookie: 'erp_session=' + 'a'.repeat(64) } } as any),
      null,
    );
    reopened.close();
    assert.equal((await (await f.owner.request('/auth/state')).json()).actor.role, 'super_admin');
    assert.equal((await (await f.admin.request('/auth/state')).json()).actor.role, 'admin');
  } finally {
    await f.close();
  }
});

test('各权限层级、密码验证、CSRF、会话绑定和模式超时由后端强制，不能通过请求伪造提权', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.anonymous.request('/customers', customerSchema.parse({ name: '不允许' }))).status,
      401,
    );
    assert.equal(
      (await f.reader.request('/customers', customerSchema.parse({ name: '不允许' }))).status,
      403,
    );
    assert.equal((await f.admin.enter()).status, 403);
    assert.equal((await f.owner.request('/customers?archived=all')).status, 403);
    assert.equal(
      (await f.owner.request('/auth/super-admin/enter', { password: 'wrong-password' })).status,
      401,
    );
    assert.equal(
      (await f.owner.request('/auth/super-admin/enter', { password }, 'POST', false)).status,
      403,
    );
    assert.equal((await f.owner.enter()).status, 200);
    assert.equal((await f.owner.request('/customers?archived=all')).status, 200);
    const other = await f.client('原管理员');
    assert.equal((await other.request('/customers?archived=all')).status, 403);
    const p = await f.preview(f.owner, 'orders', [f.order]);
    await other.enter();
    assert.equal((await f.execute(other, p.data.id)).status, 403);
    const forged = await f.admin.request('/admin/permanent-deletions/preview', {
      entity: 'orders',
      items: [{ id: f.order.id, version: 1 }],
      superAdminMode: true,
      role: 'super_admin',
    });
    assert.equal(forged.status, 403);
    await f.owner.exit();
    assert.equal((await f.execute(f.owner, p.data.id)).status, 403);
    await f.owner.enter();
    f.advance(16 * 60000);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 403);
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});

test('普通管理员不能编辑停用归档；超级模式可真实保存三个模块和历史订单，退出后立即恢复原限制', async () => {
  const f = await fixture();
  try {
    for (const [e, row] of [
      ['customers', f.customer],
      ['products', f.product],
      ['orders', f.order],
    ] as const) {
      assert.equal((await (await f.lifecycle(f.admin, e, row)).json()).results[0].success, true);
      assert.equal(
        (
          await f.admin.request(
            '/' + e + '/' + row.id,
            { ...row, notes: '越权修改', superAdminMode: true },
            'PUT',
          )
        ).status,
        404,
      );
    }
    await f.owner.enter();
    for (const [e, row] of [
      ['customers', f.customer],
      ['products', f.product],
      ['orders', f.order],
    ] as const) {
      const r = await f.owner.request(
        '/' + e + '/' + row.id,
        { ...row, notes: '超级管理员已核对并修改' },
        'PUT',
      );
      assert.equal(r.status, 200, await r.clone().text());
      const saved = await r.json();
      assert.equal(saved.version, row.version + 1);
      assert.equal(f.store.archived(e, row.id), true);
    }
    assert.equal(f.store.order(f.order.id, true)!.notes, '超级管理员已核对并修改');
    assert.equal(f.store.order(f.order.id, true)!.totalAmountExact, '1390.0000');
    const copy = new Store(f.file);
    assert.equal(copy.customer(f.customer.id, true)!.notes, '超级管理员已核对并修改');
    assert.equal(copy.order(f.order.id, true)!.notes, '超级管理员已核对并修改');
    copy.close();
    const row = f.store.product(f.product.id, true)!;
    await f.owner.exit();
    assert.equal((await f.owner.request('/products/' + row.id, row, 'PUT')).status, 404);
  } finally {
    await f.close();
  }
});

test('已履行订单归档和恢复采用业务条件，与物理删除独立，归档订单引用仍完整', async () => {
  const f = await fixture();
  try {
    const shipped = f.addOrder('已发货');
    assert.equal(
      (await (await f.lifecycle(f.admin, 'orders', shipped)).json()).results[0].success,
      true,
    );
    await f.owner.enter();
    assert.equal(
      (await (await f.lifecycle(f.owner, 'orders', shipped)).json()).results[0].success,
      true,
    );
    await f.lifecycle(f.owner, 'customers', f.customer);
    await f.lifecycle(f.owner, 'products', f.product);
    assert.equal(
      (await (await f.lifecycle(f.admin, 'orders', shipped, 'restore')).json()).results[0].success,
      true,
    );
    const restored = await (await f.lifecycle(f.owner, 'orders', shipped, 'restore')).json();
    assert.equal(restored.results[0].success, true);
    assert.equal(f.store.order(shipped.id)!.lines[0].productName, f.product.name);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('永久删除关联默认拦截，展示整张订单影响；显式确认和当前密码必需，执行只删除确定范围', async () => {
  const f = await fixture();
  try {
    await f.owner.enter();
    const plain = await f.preview(f.owner, 'customers', [f.customer]);
    assert.equal(plain.status, 200);
    assert.equal(plain.data.plan.relatedOrders.length, 1);
    assert.ok(plain.data.plan.blockers.length);
    assert.equal((await f.execute(f.owner, plain.data.id)).status, 409);
    assert.equal(f.store.customers().length, 1);
    const p = await f.preview(f.owner, 'customers', [f.customer], true);
    assert.deepEqual(p.data.plan.counts, { customers: 1, products: 0, orders: 1, lines: 1 });
    assert.equal((await f.execute(f.owner, p.data.id, { password: 'incorrect' })).status, 401);
    assert.equal((await f.execute(f.owner, p.data.id, { acknowledged: false })).status, 400);
    assert.equal((await f.execute(f.owner, p.data.id, { confirmation: '确认' })).status, 400);
    assert.equal(f.store.orders().length, 1);
    const r = await f.execute(f.owner, p.data.id);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(f.store.customers(true).length, 0);
    assert.equal(f.store.orders(true).length, 0);
    assert.equal(f.store.products(true).length, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM order_lines').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM order_line_extensions').get()!.n, 0);
    const auditCount = f.store.db
      .prepare("SELECT COUNT(*) n FROM business_audit WHERE action='permanent-delete'")
      .get()!.n;
    assert.equal(auditCount, 2);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 200);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM business_audit WHERE action='permanent-delete'")
        .get()!.n,
      auditCount,
    );
    const row = await (await f.lifecycle(f.owner, 'customers', f.customer, 'restore')).json();
    assert.equal(row.results[0].success, false);
    const newCustomer = f.store.saveCustomer(customerSchema.parse({ name: '删除后新客户' }));
    assert.ok(newCustomer.id > f.customer.id);
    const replacement = f.store.saveOrder(
      orderSchema.parse({ ...f.order, customerId: newCustomer.id }),
    );
    assert.ok(replacement.id > f.order.id);
    const copy = new Store(f.file);
    assert.equal(copy.customer(f.customer.id, true), undefined);
    assert.equal(copy.order(f.order.id, true), undefined);
    assert.deepEqual(copy.db.prepare('PRAGMA foreign_key_check').all(), []);
    copy.close();
  } finally {
    await f.close();
  }
});

test('单条和批量永久删除客户产品订单；预览后版本、归档状态、关联及有效期变化均拒绝，未知关联整批回滚', async () => {
  const f = await fixture();
  try {
    await f.owner.enter();
    let p = await f.preview(f.owner, 'orders', [f.order]);
    await f.lifecycle(f.owner, 'orders', f.order);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 409);
    await f.lifecycle(f.owner, 'orders', f.order, 'restore');
    p = await f.preview(f.owner, 'customers', [f.customer], true);
    const second = f.addOrder();
    assert.equal((await f.execute(f.owner, p.data.id)).status, 409);
    p = await f.preview(f.owner, 'orders', [f.order, second]);
    f.store.db
      .prepare('UPDATE permanent_delete_previews SET expires_at=0 WHERE id=?')
      .run(p.data.id);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 409);
    f.store.db.exec(
      'CREATE TABLE future_shipments(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE)',
    );
    f.store.db.prepare('INSERT INTO future_shipments VALUES(1,?)').run(second.id);
    p = await f.preview(f.owner, 'orders', [f.order, second]);
    const blocked = await f.execute(f.owner, p.data.id);
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).message, /尚未纳入删除方案/);
    assert.equal(f.store.orders(true).length, 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM future_shipments').get()!.n, 1);
    f.store.db.exec('DROP TABLE future_shipments');
    assert.equal((await f.execute(f.owner, p.data.id)).status, 200);
    assert.equal(f.store.orders(true).length, 0);
    const extra = f.store.saveProduct(productSchema.parse({ name: '额外产品' }));
    await f.lifecycle(f.owner, 'products', extra);
    p = await f.preview(f.owner, 'products', [f.product, extra]);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 200);
    assert.equal(f.store.products(true).length, 0);
    assert.ok(f.store.saveProduct(productSchema.parse({ name: '新产品' })).id > extra.id);
    p = await f.preview(f.owner, 'customers', [f.customer]);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 200);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('永久删除正式导入订单保留来源、审计和幂等凭据，AI工作区显示已永久删除且不允许恢复或重复入库', async () => {
  const f = await fixture();
  try {
    let w = (await f.manager.upload(docxFixture(), '虚构AI订单.docx')).workspace;
    const preset = f.settings.view().active!;
    w = f.manager.consent(w.id, {
      accepted: true,
      expectedRevision: w.revision,
      presetId: preset.id,
      endpoint: preset.endpoint,
      model: preset.model,
      apiStyle: 'responses',
    });
    w = await f.manager.analyze(w.id, { expectedRevision: w.revision });
    const importPreview = await (
      await f.owner.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision })
    ).json();
    const receipt = await (
      await f.owner.request('/ai/imports/' + w.id + '/execute', {
        previewId: importPreview.id,
        acknowledged: true,
      })
    ).json();
    const order = f.store.order(receipt.orderId)!;
    assert.ok(order);
    await f.owner.enter();
    const p = await f.preview(f.owner, 'orders', [order]);
    assert.equal((await f.execute(f.owner, p.data.id)).status, 200);
    assert.equal(
      f.store.db
        .prepare('SELECT order_id FROM import_executions WHERE id=?')
        .get(receipt.executionId)!.order_id,
      null,
    );
    assert.ok(existsSync(receipt.sourcePath));
    assert.ok(f.manager.get(w.id).draft);
    assert.equal(f.manager.get(w.id).imported!.permanentlyDeleted, true);
    assert.equal(
      (await f.owner.request('/ai/imports/' + w.id + '/preview', { expectedRevision: w.revision }))
        .status,
      409,
    );
    assert.equal(
      (await f.owner.request('/ai/imports/' + w.id + '/undo-import', { acknowledged: true }))
        .status,
      409,
    );
    const copy = new Store(f.file);
    assert.equal(findImport(copy, w.id)!.permanentlyDeleted, true);
    copy.close();
    assert.equal(
      f.store.db
        .prepare('SELECT COUNT(*) n FROM business_audit WHERE record_id=? AND entity=?')
        .get(order.id, 'orders')!.n,
      2,
    );
  } finally {
    await f.close();
  }
});

test('旧版本4含正式导入台账的业务库兼容迁移，历史业务行和来源文档完全保留', async () => {
  const f = await fixture();
  try {
    const receipt = {
      orderId: f.order.id,
      orderNumber: f.order.number,
      fileName: '虚构旧来源.docx',
      at: '2026-10-25T02:00:00Z',
      actor: { id: f.ownerId, name: '原管理员' },
      original: '原来源文档保持',
    };
    f.store.db
      .prepare('INSERT INTO import_executions VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        'old-id',
        'old-preview',
        'old-source',
        'old-hash',
        'old-fingerprint',
        f.order.id,
        f.ownerId,
        new Date().toISOString(),
        JSON.stringify(receipt),
      );
    const before = JSON.stringify([
      f.store.customers(true),
      f.store.products(true),
      f.store.orders(true),
    ]);
    f.store.db.exec(
      'CREATE TABLE executions_legacy(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL UNIQUE,file_hash TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL UNIQUE,order_id INTEGER NOT NULL REFERENCES orders(id),actor_id TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL); INSERT INTO executions_legacy SELECT * FROM import_executions; DROP TABLE import_executions; ALTER TABLE executions_legacy RENAME TO import_executions; DELETE FROM schema_migrations WHERE version=5',
    );
    const migrated = new Store(f.file);
    try {
      assert.equal(
        JSON.stringify([migrated.customers(true), migrated.products(true), migrated.orders(true)]),
        before,
      );
      assert.equal(
        migrated.db.prepare('SELECT document FROM import_executions').get()!.document,
        JSON.stringify(receipt),
      );
      assert.equal(
        migrated.db
          .prepare('PRAGMA table_info(import_executions)')
          .all()
          .find((c) => c.name === 'order_id')!.notnull,
        0,
      );
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    await f.close();
  }
});

test('高风险密码错误有服务端限流，等待解锁后可继续，审计不保存明文密码', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await f.owner.request('/auth/super-admin/enter', { password: 'wrong-test-password' }))
          .status,
        401,
      );
    assert.equal((await f.owner.enter()).status, 429);
    f.advance(300001);
    assert.equal((await f.owner.enter()).status, 200);
    const db = new DatabaseSync(f.authFile, { readOnly: true });
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM auth_events').all()).includes(password));
    db.close();
  } finally {
    await f.close();
  }
});

test('操作区域常规查看编辑与危险更多菜单分离，详情字段完整，永久删除密码不存浏览器配置', () => {
  const row = {
    id: 1,
    name: '虚构客户',
    contact: '联系人',
    phone: '123',
    address: '地址',
    notes: '备注',
    version: 1,
  };
  const html = renderToStaticMarkup(
    createElement(BusinessRecords, {
      entity: 'customers',
      rows: [row],
      archived: false,
      setArchived: () => {},
      edit: () => {},
      changed: () => {},
      search: '',
      setSearch: () => {},
    }),
  );
  assert.match(html, /record-actions-main/);
  assert.match(html, /查看/);
  assert.match(html, /编辑/);
  assert.match(html, /归档/);
  assert.match(html, /删除/);
  assert.doesNotMatch(html, /查看 \/ 编辑/);
  const detail = renderToStaticMarkup(createElement(RecordDetails, { entity: 'customers', row }));
  assert.match(detail, /虚构客户/);
  assert.match(detail, /联系人/);
  for (const file of ['src/session.ts', 'src/AuthPanel.tsx', 'src/PermanentDeleteDialog.tsx'])
    assert.doesNotMatch(readFileSync(file, 'utf8'), /localStorage|sessionStorage/);
});

test('同一原件在有效订单/回收站/永久删除后均可重新识别，永久删除后可重新导入且不复用旧ID', async () => {
  const f = await fixture();
  try {
    const file = Buffer.from(docxFixture()),
      preset = f.settings.view().active!;
    const uploadAndRecognize = async (name: string) => {
      const up = await f.manager.upload(file, name);
      const id = up.workspace.id;
      let w = f.manager.consent(id, {
        accepted: true,
        expectedRevision: up.workspace.revision,
        presetId: preset.id,
        endpoint: preset.endpoint,
        model: preset.model,
        apiStyle: 'responses',
      });
      w = await f.manager.analyze(id, { expectedRevision: w.revision });
      return { up, id, w };
    };
    const importTask = async (id: string) => {
      const response = await f.owner.request('/ai/imports/' + id + '/preview', {
        expectedRevision: f.manager.get(id).revision,
      });
      const preview = await response.json();
      if (response.status !== 200) return { status: response.status, preview };
      const executed = await f.owner.request('/ai/imports/' + id + '/execute', {
        previewId: preview.id,
        acknowledged: true,
      });
      return { status: executed.status, receipt: await executed.json() };
    };
    const first = await uploadAndRecognize('同一订单照片.docx');
    const firstImport = await importTask(first.id);
    assert.equal(firstImport.status, 200);
    const order1 = f.store.order(firstImport.receipt.orderId)!,
      hash = first.up.workspace.fileHash;

    // 已识别/已导入的相同原件再次上传：新建独立任务，识别不被历史记录阻断
    const second = await uploadAndRecognize('同一订单照片.docx');
    assert.notEqual(second.id, first.id);
    assert.equal(second.up.duplicate, false);
    assert.equal(second.up.workspace.imported, undefined);
    assert.equal(second.up.workspace.historyImport!.orderNumber, order1.number);
    assert.ok(second.w.draft);

    // 原订单仍有效：入库提示潜在重复并给出订单号
    const effective = await importTask(second.id);
    assert.equal(effective.status, 409);
    assert.match(String(effective.preview.message), new RegExp(order1.number));

    // 原订单在回收站：提示先恢复原订单
    await f.lifecycle(f.owner, 'orders', { id: order1.id, version: order1.version }, 'archive');
    const archived = await importTask(second.id);
    assert.equal(archived.status, 409);
    assert.match(String(archived.preview.message), /归档|有效订单/);

    // 恢复后永久删除原订单
    const archivedRow = f.store.orders(true).find((o) => o.id === order1.id)!;
    await f.lifecycle(
      f.owner,
      'orders',
      { id: archivedRow.id, version: archivedRow.version },
      'restore',
    );
    await f.owner.enter();
    const restored = f.store.order(order1.id)!;
    const delete1 = await f.preview(f.owner, 'orders', [restored]);
    assert.equal(delete1.status, 200);
    assert.equal((await f.execute(f.owner, delete1.data.id)).status, 200);
    assert.equal(f.store.order(order1.id), undefined);

    // 永久删除后重新识别并重新导入：新订单ID/编号不复用
    const third = await uploadAndRecognize('同一订单照片.docx');
    assert.notEqual(third.id, second.id);
    assert.equal(third.up.workspace.historyImport!.permanentlyDeleted, true);
    const thirdImport = await importTask(third.id);
    assert.equal(thirdImport.status, 200);
    const order2 = f.store.order(thirdImport.receipt.orderId)!;
    assert.notEqual(order2.id, order1.id);
    assert.notEqual(order2.number, order1.number);

    // 再次永久删除并再次导入
    const delete2 = await f.preview(f.owner, 'orders', [order2]);
    assert.equal((await f.execute(f.owner, delete2.data.id)).status, 200);
    const fourth = await uploadAndRecognize('同一订单照片.docx');
    assert.notEqual(fourth.id, third.id);
    const fourthImport = await importTask(fourth.id);
    assert.equal(fourthImport.status, 200);
    const order3 = f.store.order(fourthImport.receipt.orderId)!;
    assert.notEqual(order3.id, order2.id);

    // 台账保留三条来源记录：两条已永久删除置空订单，一条指向新订单
    const rows = f.store.db
      .prepare('SELECT order_id FROM import_executions WHERE file_hash=?')
      .all(hash) as any[];
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.order_id === null).length, 2);
    assert.equal(rows.filter((r) => Number(r.order_id) === order3.id).length, 1);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    // 旧工作区保持只读且显示原正式订单已永久删除
    assert.equal(f.manager.get(first.id).imported!.permanentlyDeleted, true);
    assert.equal(
      (
        await f.owner.request('/ai/imports/' + first.id + '/preview', {
          expectedRevision: f.manager.get(first.id).revision,
        })
      ).status,
      409,
    );
    // 历史审计保留
    const auditRows = f.store.db
      .prepare("SELECT COUNT(*) n FROM business_audit WHERE source='reviewed-import'")
      .get() as any;
    assert.ok(Number(auditRows.n) >= 3);
  } finally {
    await f.close();
  }
});

test('旧工作区库的唯一哈希约束迁移后保留任务并允许同一原件建立多个导入任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-workspace-migrate-'));
  try {
    const file = join(dir, 'workspaces.sqlite'),
      db = new DatabaseSync(file);
    db.exec(
      `CREATE TABLE workspaces(id TEXT PRIMARY KEY,file_hash TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,document TEXT NOT NULL);
       CREATE TABLE workspace_trash(id TEXT PRIMARY KEY,document TEXT NOT NULL,removed_at TEXT NOT NULL);`,
    );
    db.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(
      'legacy-workspace',
      'same-hash',
      0,
      JSON.stringify({
        id: 'legacy-workspace',
        fileHash: 'same-hash',
        fileName: '旧任务',
        revision: 0,
        draft: null,
        history: [],
        audits: [],
        messages: [],
        changes: [],
      }),
    );
    db.close();
    const repo = new ImportRepository(file);
    try {
      assert.equal(repo.byHashAll('same-hash').length, 1);
      assert.equal(repo.get('legacy-workspace').fileName, '旧任务');
      repo.insert({
        id: 'new-workspace',
        fileHash: 'same-hash',
        revision: 0,
        document: JSON.stringify({ id: 'new-workspace', fileHash: 'same-hash' }),
      });
      assert.equal(repo.byHashAll('same-hash').length, 2);
    } finally {
      repo.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧导入台账的唯一哈希/指纹约束迁移后保留历史，并允许同一原件再次导入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-ledger-migrate-'));
  const file = join(dir, 'erp.sqlite');
  try {
    let store = new Store(file);
    const customer = store.saveCustomer(customerSchema.parse({ name: '迁移客户（虚构）' })),
      product = store.saveProduct(productSchema.parse({ name: '迁移纸箱（虚构）' })),
      order = store.saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-10-25',
          deliveryDate: '2026-11-01',
          status: '草稿',
          lines: [
            {
              productId: product.id,
              productName: product.name,
              specification: '',
              quantity: 10,
              unit: '只',
              unitPriceCents: 100,
            },
          ],
        }),
      );
    store.close();
    const db = new DatabaseSync(file);
    db.exec(
      `PRAGMA foreign_keys=OFF;
       CREATE TABLE import_executions_old(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL UNIQUE,file_hash TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL UNIQUE,order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL);`,
    );
    db.prepare('INSERT INTO import_executions_old VALUES(?,?,?,?,?,?,?,?,?)').run(
      'legacy-exec',
      'legacy-preview',
      'legacy-source',
      'legacy-hash',
      'legacy-fingerprint',
      order.id,
      'legacy-actor',
      '2026-10-25T00:00:00Z',
      JSON.stringify({ orderId: order.id, orderNumber: order.number }),
    );
    db.exec(
      `DROP TABLE import_executions; ALTER TABLE import_executions_old RENAME TO import_executions;
       CREATE INDEX import_order_lookup ON import_executions(order_id); PRAGMA foreign_keys=ON;`,
    );
    db.close();
    store = new Store(file);
    try {
      const rows = store.db.prepare('SELECT * FROM import_executions').all() as any[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].file_hash, 'legacy-hash');
      assert.equal(
        Number(
          store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=9').get()!.n,
        ),
        1,
      );
      // 同一 file_hash/fingerprint 不再全表唯一，允许永久删除后再次导入
      store.db
        .prepare('INSERT INTO import_executions VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          'new-exec',
          'new-preview',
          'new-source',
          'legacy-hash',
          'legacy-fingerprint',
          null,
          'actor',
          '2026-10-26T00:00:00Z',
          '{}',
        );
      assert.equal(
        Number(
          store.db
            .prepare('SELECT COUNT(*) n FROM import_executions WHERE file_hash=?')
            .get('legacy-hash')!.n,
        ),
        2,
      );
      assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
