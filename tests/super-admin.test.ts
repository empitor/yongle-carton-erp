// 超级管理员模式：谁能进、密码和页面凭证、按会话绑定、超时、退出；模式里能改归档记录、删客户产品订单；
// 验密码的限流。识别导入和永久删除的几条在 import-permanent-deletion.test.ts。虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AuthManager } from '../server/accounts/index.js';
import { count } from '../server/core/sql.js';
import { startHttp, userList } from './http-fixture.js';
import { HashQueue } from '../server/accounts/hash-queue.js';
import { hashGate } from './hash-gate.js';
import { customerSchema, productSchema, orderSchema } from '../shared/core/domain.js';
import { impactRowSchema } from '../shared/business/index.js';
import BusinessRecords from '../src/records/BusinessRecords.js';
import { CustomerDetail } from '../src/records/PartyProductDetails.js';
const password = 'Fictional-admin-password-123';

/** 删除预览的回答：成功时有范围摘要和影响清单，被拒时只有提示，两项都没有 */
const previewAnswer = z.object({ digest: z.string(), impact: z.array(impactRowSchema) }).partial();
/** 归档、恢复（/<记录>/batch）回答里第一条成没成 */
const batchAnswer = z.object({ results: z.array(z.object({ success: z.boolean() })).nonempty() });
const firstSucceeded = async (r: Response) => batchAnswer.parse(await r.json()).results[0].success;

/** 三个账号直接写进账号库：超级管理员、业务账号、只读账号，密码都是 password */
function seedAccounts(authFile: string) {
  const salt = 'fictional-salt',
    passwordHash = scryptSync(password, salt, 64).toString('hex'),
    permissions = JSON.stringify(['business:edit', 'import:execute', 'import:restore']);
  const adminDb = new DatabaseSync(authFile);
  const addUser = adminDb.prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)');
  addUser.run(randomUUID(), '原管理员', salt, passwordHash, permissions, 'super_admin');
  addUser.run(randomUUID(), '普通管理员', salt, passwordHash, permissions, 'admin');
  addUser.run(randomUUID(), '只读账号', salt, passwordHash, '[]', 'admin');
  adminDb.close();
}

/** 业务库是文件（要另开一份核对落盘）；账号见 seedAccounts */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-super-')),
    file = join(dir, 'erp.sqlite'),
    authFile = join(dir, 'users.sqlite'),
    store = new Store(file);
  let now = Date.now();
  // 先开账号库（建表），再往里写账号
  const auth = new AuthManager(authFile, () => now);
  seedAccounts(authFile);
  const h = await startHttp(store, { auth, admin: false });
  /** 一个账号的客户端：第一次发请求时才登录（登录要算一次哈希，用不到的账号不登） */
  function client(name?: string) {
    let cookie: Promise<string> | undefined;
    const request = async (path: string, body?: unknown, method = 'POST', csrf = true) =>
      h.send(path, body, await (cookie ??= name ? h.login(name, password) : Promise.resolve('')), {
        method: body === undefined ? 'GET' : method,
        ...(csrf ? {} : { csrf: null }),
      });
    return {
      request,
      enter: () => request('/auth/super-admin/enter', { password }),
      exit: () => request('/auth/super-admin/exit', {}),
    };
  }
  const owner = client('原管理员'),
    admin = client('普通管理员'),
    reader = client('只读账号'),
    anonymous = client();
  const customer = store.saveCustomer(customerSchema.parse({ name: '已有客户（虚构）' })),
    product = store.saveProduct(productSchema.parse({ name: '已有纸箱（虚构）' }));
  const addOrder = (status: '待确认' | '已发货' = '待确认') =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-25',
        deliveryDate: '2026-11-01',
        status,
        lines: [
          { productId: product.id, productName: product.name, specification: '独立规格', notes: '独立备注', unit: '只', quantity: 1000, unitPriceCents: 139, unitPriceExact: '1.3900' },
        ],
      }),
    );
  const order = addOrder();
  type Client = typeof owner;
  const lifecycle = (c: Client, entity: string, row: { id: number; version: number }, action = 'archive') =>
    c.request('/' + entity + '/batch', { action, acknowledged: true, items: [{ id: row.id, version: row.version }] });
  // 页面上的删除（删除引擎 /api/deletions）：先看影响清单，再带着清单的范围摘要和本人密码提交
  const preview = async (c: Client, module: string, rows: { id: number; version: number }[]) => {
    const selection = { module, items: rows.map(({ id, version }) => ({ id, version })) };
    const r = await c.request('/deletions/preview', selection);
    return { status: r.status, data: previewAnswer.parse(await r.json()), selection };
  };
  const execute = (c: Client, p: Awaited<ReturnType<typeof preview>>, extra: Record<string, unknown> = {}) =>
    c.request('/deletions/execute', { ...p.selection, requestId: randomUUID(), deletionDigest: p.data.digest, password, ...extra });
  return {
    file,
    authFile,
    store,
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
      await h.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('各权限层级、密码验证、CSRF、会话绑定和模式超时由后端强制，不能通过请求伪造提权', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.anonymous.request('/customers', customerSchema.parse({ name: '不允许' }))).status, 401);
    assert.equal((await f.reader.request('/customers', customerSchema.parse({ name: '不允许' }))).status, 403);
    assert.equal((await f.admin.enter()).status, 403);
    assert.equal((await f.owner.request('/customers?archived=all')).status, 403);
    assert.equal((await f.owner.request('/auth/super-admin/enter', { password: 'Wrong-password' })).status, 401);
    assert.equal((await f.owner.request('/auth/super-admin/enter', { password }, 'POST', false)).status, 403);
    assert.equal((await f.owner.enter()).status, 200);
    assert.equal((await f.owner.request('/customers?archived=all')).status, 200);
    const other = f.client('原管理员');
    assert.equal((await other.request('/customers?archived=all')).status, 403);
    const p = await f.preview(f.owner, 'orders', [f.order]);
    assert.equal(p.status, 200);
    // 同一个账号在别处的登录没进超级管理员模式：拿着这份影响清单也删不了
    assert.equal((await f.execute(other, p)).status, 403);
    const forged = await f.admin.request('/deletions/preview', {
      module: 'orders',
      items: [{ id: f.order.id, version: 1 }],
      superAdminMode: true,
      role: 'super_admin',
    });
    assert.equal(forged.status, 403);
    await f.owner.exit();
    assert.equal((await f.execute(f.owner, p)).status, 403);
    await f.owner.enter();
    f.advance(16 * 60000);
    assert.equal((await f.execute(f.owner, p)).status, 403);
    assert.equal(f.store.orders().length, 1);
  } finally {
    await f.close();
  }
});

test('普通管理员不能编辑已归档的记录；超级管理员模式里能改客户、产品、订单并落盘，退出后又被拦', async () => {
  const f = await fixture();
  const rows = [
    ['customers', f.customer],
    ['products', f.product],
    ['orders', f.order],
  ] as const;
  try {
    for (const [e, row] of rows) {
      assert.equal(await firstSucceeded(await f.lifecycle(f.admin, e, row)), true);
      const r = await f.admin.request('/' + e + '/' + row.id, { ...row, notes: '越权修改', superAdminMode: true }, 'PUT');
      assert.equal(r.status, 404);
    }
    await f.owner.enter();
    for (const [e, row] of rows) {
      const r = await f.owner.request('/' + e + '/' + row.id, { ...row, notes: '超级管理员已核对并修改' }, 'PUT');
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal(z.object({ version: z.number() }).parse(await r.json()).version, row.version + 1);
      assert.equal(f.store.archived(e, row.id), true);
    }
    assert.equal(f.store.order(f.order.id, true)?.totalAmountExact, '1390.0000');
    const copy = new Store(f.file);
    assert.equal(copy.customer(f.customer.id, true)?.notes, '超级管理员已核对并修改');
    assert.equal(copy.order(f.order.id, true)?.notes, '超级管理员已核对并修改');
    copy.close();
    const row = f.store.product(f.product.id, true);
    assert.ok(row, '产品还在');
    await f.owner.exit();
    assert.equal((await f.owner.request('/products/' + row.id, row, 'PUT')).status, 404);
  } finally {
    await f.close();
  }
});

test('已发货订单的归档和恢复按业务条件走，和永久删除无关，归档后引用照样完整', async () => {
  const f = await fixture();
  try {
    const shipped = f.addOrder('已发货');
    assert.equal(await firstSucceeded(await f.lifecycle(f.admin, 'orders', shipped)), true);
    await f.owner.enter();
    assert.equal(await firstSucceeded(await f.lifecycle(f.owner, 'orders', shipped)), true);
    await f.lifecycle(f.owner, 'customers', f.customer);
    await f.lifecycle(f.owner, 'products', f.product);
    assert.equal(await firstSucceeded(await f.lifecycle(f.admin, 'orders', shipped, 'restore')), true);
    assert.equal(await firstSucceeded(await f.lifecycle(f.owner, 'orders', shipped, 'restore')), true);
    assert.equal(f.store.order(shipped.id)?.lines[0].productName, f.product.name);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('删除客户连带它的订单：影响清单列出整张订单；没带这份范围、密码不对都不删，执行只删清单里的、记审计', async () => {
  const f = await fixture();
  try {
    await f.owner.enter();
    const p = await f.preview(f.owner, 'customers', [f.customer]);
    assert.equal(p.status, 200);
    const impact = p.data.impact;
    assert.ok(impact, '预览带影响清单');
    const listed = (table: string) => impact.filter((r) => r.table === table && r.action === 'delete').length;
    assert.deepEqual(
      { customers: listed('customers'), products: listed('products'), orders: listed('orders'), lines: listed('order_lines') },
      { customers: 1, products: 0, orders: 1, lines: 1 },
    );
    // 连带删订单时必须带着影响清单的范围摘要提交；密码不对也不删
    assert.equal((await f.execute(f.owner, p, { deletionDigest: undefined })).status, 409);
    assert.equal((await f.execute(f.owner, p, { password: 'Incorrect' })).status, 401);
    assert.equal((await f.execute(f.owner, p, { password: undefined })).status, 400);
    assert.equal(f.store.customers().length, 1);
    assert.equal(f.store.orders().length, 1);
    const r = await f.execute(f.owner, p);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(f.store.customers(true).length, 0);
    assert.equal(f.store.orders(true).length, 0);
    assert.equal(f.store.products(true).length, 1);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) FROM order_lines'), 0);
    const audits = count(f.store.db, "SELECT COUNT(*) FROM business_audit WHERE source='page' AND action='delete'");
    assert.equal(audits, 2);
    assert.equal(await firstSucceeded(await f.lifecycle(f.owner, 'customers', f.customer, 'restore')), false);
    // 删掉的编号不复用
    const newCustomer = f.store.saveCustomer(customerSchema.parse({ name: '删除后新客户' }));
    assert.ok(newCustomer.id > f.customer.id);
    const lines = f.order.lines.map(({ id: _oldLineId, ...line }) => line);
    assert.ok(f.store.saveOrder(orderSchema.parse({ ...f.order, customerId: newCustomer.id, lines })).id > f.order.id);
    const copy = new Store(f.file);
    assert.equal(copy.customer(f.customer.id, true), undefined);
    assert.equal(copy.order(f.order.id, true), undefined);
    assert.deepEqual(copy.db.prepare('PRAGMA foreign_key_check').all(), []);
    copy.close();
  } finally {
    await f.close();
  }
});

test('单条和批量删除客户、产品、订单（含已归档的）；看过影响清单后范围变了就拒绝、一条不删', async () => {
  const f = await fixture();
  try {
    await f.owner.enter();
    let p = await f.preview(f.owner, 'customers', [f.customer]);
    // 看过清单以后这个客户又多了一张订单：范围变了，拒绝
    const second = f.addOrder();
    assert.equal((await f.execute(f.owner, p)).status, 409);
    assert.equal(f.store.customers(true).length, 1);
    assert.equal(f.store.orders(true).length, 2);
    p = await f.preview(f.owner, 'orders', [f.order, second]);
    assert.equal((await f.execute(f.owner, p)).status, 200);
    assert.equal(f.store.orders(true).length, 0);
    const extra = f.store.saveProduct(productSchema.parse({ name: '额外产品' }));
    await f.lifecycle(f.owner, 'products', extra);
    p = await f.preview(f.owner, 'products', [f.product, extra]);
    assert.equal((await f.execute(f.owner, p)).status, 200);
    assert.equal(f.store.products(true).length, 0);
    p = await f.preview(f.owner, 'customers', [f.customer]);
    assert.equal((await f.execute(f.owner, p)).status, 200);
    assert.equal(f.store.customers(true).length, 0);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('删除确认排队验密码的空当里账号被降级：这次删除不执行', async () => {
  const gate = hashGate(),
    store = new Store(':memory:'),
    h = await startHttp(store, { auth: new AuthManager(':memory:', Date.now, { hashes: new HashQueue(gate.hash) }) });
  try {
    await h.enterSuperMode();
    const other = { name: '虚构第二管理员', password: 'Fictional-second-123' };
    const made = await h.send('/auth/users', { ...other, level: 'admin' }, h.cookie);
    const account = userList(z.record(z.string(), z.unknown()).parse(await made.json())).find((u) => u.name === other.name);
    assert.ok(account, '建出了第二管理员');
    const id = account.id;
    const cookie = await h.login(other.name, other.password);
    await h.enterSuperMode(cookie, other.password);
    const customer = store.saveCustomer(customerSchema.parse({ name: '虚构待删客户' }));
    const selection = { module: 'customers', items: [{ id: customer.id, version: customer.version }] };
    const digest = previewAnswer.parse(await (await h.send('/deletions/preview', selection, cookie)).json()).digest;
    const before = gate.calls;
    gate.hold(1);
    const deleting = h.send('/deletions/execute', { ...selection, requestId: randomUUID(), deletionDigest: digest, password: other.password }, cookie);
    await gate.reached(before + 1);
    assert.equal((await h.send('/auth/users/' + id, { level: 'staff' }, h.cookie, { method: 'PUT' })).status, 200);
    gate.release();
    assert.equal((await deleting).status, 403);
    assert.ok(store.customer(customer.id), '客户还在');
  } finally {
    gate.release();
    await h.close();
    store.close();
  }
});

test('进超级管理员模式输错 5 次就锁 5 分钟，过了能再进；登录记录里没有密码原文', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal((await f.owner.request('/auth/super-admin/enter', { password: 'Wrong-test-password' })).status, 401);
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

// 拿不准、等界面流程那一路确认：列表行上没有删除（删除在详情面板的“更多”里）这一点界面流程有没有看过；
// 后半段扫源码守“登录和删除的代码不碰浏览器存储”（密码不存浏览器），排查报告建议搬到 frontend。
test('客户列表行上只有查看、没有删除，详情显示全部字段；登录和删除的代码不碰浏览器存储', () => {
  const row = { id: 1, name: '虚构客户', contact: '联系人', phone: '123', address: '地址', notes: '备注', version: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  const html = renderToStaticMarkup(
    createElement(BusinessRecords, { entity: 'customers', rows: [row], archived: false, edit: () => {}, changed: () => {} }),
  );
  assert.match(html, /查看/);
  assert.doesNotMatch(html, /删除/);
  const detail = renderToStaticMarkup(createElement(CustomerDetail, { row }));
  assert.match(detail, /虚构客户/);
  assert.match(detail, /联系人/);
  for (const file of ['src/ui/auth-state.ts', 'src/ui/http.ts', 'src/AuthPanel.tsx', 'src/recordkit/DatabaseDeleteDialog.tsx'])
    assert.doesNotMatch(readFileSync(file, 'utf8'), /localStorage|sessionStorage/);
});
