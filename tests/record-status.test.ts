// 订单、采购单的状态动作（确认、退回、取消、恢复）：各是一个动作，和单据的取消一样要权限、版本、防重复、审计，
// 取消必填原因；整张保存不改状态（server/orders/order-status.ts、server/flow/stock/stock-entries.ts）。
import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import '../server/flow/index.js';
import { Store, count, InputError } from '../server/core/index.js';
import { AuthManager } from '../server/accounts/index.js';
import { z } from 'zod';
import { cookieOf, startHttp } from './http-fixture.js';
import { OrderBatchService } from '../server/operations/index.js';
import { changeOrderStatus, assertOrderStatusKept } from '../server/orders/order-status.js';
import { recordContext } from '../server/overview/record-context.js';
import { historyView, statusActionFor } from '../shared/business/index.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { flowFixture, clerk } from './flow-fixture.js';
import { readAs, must } from './read-result.js';
import { businessBase } from './business-base-fixture.js';

const actor = pageActor({ id: 'fictional-status-user', name: '虚构状态操作员', permissions: ['business:edit'], role: 'admin' as const });
const reader = pageActor({ id: 'fictional-reader', name: '虚构只读', permissions: [], role: 'admin' as const });

function fixture() {
  const base = businessBase(actor),
    { store, ops, flow } = base;
  const customer = base.customer({ name: '虚构状态客户' }),
    product = base.product({ name: '虚构状态纸箱' });
  const order = base.order(customer, [base.line(product, 100)], { orderDate: '2026-11-01', deliveryDate: '2026-11-30', status: '待确认' });
  const supplier = base.supplier({ name: '虚构状态供应商' }),
    raw = base.raw({ name: '虚构状态纸板' });
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      orderDate: '2026-11-01',
      status: '待订货',
      lines: [{ stockItemId: raw.id, name: raw.name, quantity: '100', unit: '张', priceBasis: 'quantity' }],
    },
    actor,
  );
  const audits = (entity: string, id: number) =>
    store.db
      .prepare('SELECT action,document FROM business_audit WHERE entity=? AND record_id=? ORDER BY id')
      .all(entity, id)
      .map((r) => ({ action: String(r.action), document: auditDocument.parse(JSON.parse(String(r.document))) }));
  return { store, ops, flow, order, purchase, audits };
}
/** 状态动作的审计内容里测试要看的：原因、改前改后的状态 */
const withStatus = z.looseObject({ status: z.string() }).nullish();
const auditDocument = z.looseObject({ reason: z.string().optional(), before: withStatus, after: withStatus });
const input = (row: { version: number }, reason?: string) => ({
  expectedVersion: row.version,
  requestId: randomUUID(),
  ...(reason ? { reason } : {}),
});
/** 抛出的错带这个状态码（是几个之一），给了 message 时说明也要对得上 */
const failsWith =
  (codes: number | readonly number[], message?: RegExp) =>
  (e: unknown) =>
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    typeof e.status === 'number' &&
    (typeof codes === 'number' ? [codes] : codes).includes(e.status) &&
    (!message || (e instanceof Error && message.test(e.message)));

test('订单的确认、退回、取消、恢复各是一个动作：取消必填原因，原因记进审计、修改历史里看得到', () => {
  const f = fixture();
  try {
    let o = changeOrderStatus(f.store, f.order.id, 'confirm', input(f.order), actor);
    assert.equal(o.status, '已确认');
    o = changeOrderStatus(f.store, o.id, 'revert', input(o), actor);
    assert.equal(o.status, '待确认');
    assert.throws(() => changeOrderStatus(f.store, o.id, 'cancel', input(o), actor), /请填写取消原因/);
    assert.throws(() => changeOrderStatus(f.store, o.id, 'cancel', input(o, '   '), actor), /请填写取消原因/);
    o = changeOrderStatus(f.store, o.id, 'cancel', input(o, '客户改单，虚构原因'), actor);
    assert.equal(o.status, '已取消');
    o = changeOrderStatus(f.store, o.id, 'reinstate', input(o), actor);
    assert.equal(o.status, '待确认');
    const rows = f.audits('orders', o.id);
    assert.deepEqual(rows.map((r) => r.action), ['confirm', 'revert', 'cancel', 'reinstate']);
    assert.equal(rows[2].document.reason, '客户改单，虚构原因');
    assert.equal(rows[2].document.before?.status, '待确认');
    assert.equal(rows[2].document.after?.status, '已取消');
    // 修改历史：动作有中文名，原因单独一行
    const ctx = recordContext(f.store, 'orders', o.id, actor);
    const cancel = must(ctx.history.find((h) => h.action === 'cancel'), '取消的修改历史');
    const view = historyView({ module: 'orders', action: 'cancel', detail: cancel.detail, recordId: o.id }, ctx.historyRefs);
    assert.ok(view.items.some((i) => i.label === '原因' && i.value === '客户改单，虚构原因'), JSON.stringify(view));
  } finally {
    f.store.close();
  }
});

test('订单状态动作：没权限、版本对不上、当前状态不对都拒绝；同一请求号重试原样返回、不重复办，换了内容拒绝', () => {
  const f = fixture();
  try {
    assert.throws(() => changeOrderStatus(f.store, f.order.id, 'confirm', input(f.order), reader), failsWith(403));
    assert.throws(() => changeOrderStatus(f.store, f.order.id, 'confirm', input(f.order), null), failsWith([401, 403]));
    assert.throws(
      () => changeOrderStatus(f.store, f.order.id, 'confirm', { ...input(f.order), expectedVersion: f.order.version + 1 }, actor),
      failsWith(409, /已被修改/),
    );
    assert.throws(() => changeOrderStatus(f.store, f.order.id, 'revert', input(f.order), actor), failsWith(409, /待确认/));
    assert.throws(() => changeOrderStatus(f.store, f.order.id, 'reinstate', input(f.order), actor), failsWith(409));
    const once = input(f.order);
    const first = changeOrderStatus(f.store, f.order.id, 'confirm', once, actor);
    const again = changeOrderStatus(f.store, f.order.id, 'confirm', once, actor);
    assert.deepEqual(again, first);
    assert.equal(f.audits('orders', f.order.id).length, 1, '重试不再记审计');
    assert.throws(() => changeOrderStatus(f.store, f.order.id, 'cancel', { ...once, reason: '换了内容' }, actor), failsWith(409));
    // 没有动作能把订单改成生产中、待发货、已发货（由单据派生）
    for (const to of ['生产中', '待发货', '已发货'])
      for (const from of ['待确认', '已确认', '已取消']) assert.equal(statusActionFor('orders', from, to), null);
  } finally {
    f.store.close();
  }
});

test('已有出库送货单的订单：状态动作被拒（接口回 400），不记审计、不记请求号，同一请求号再交还是被拒', () => {
  const f = flowFixture(clerk);
  try {
    const order = f.order(100);
    f.stockIn('50');
    f.confirm('delivery', { customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '50' }] });
    const now = must(sales(f.store).order(order.id), '订单'),
      once = input(now, '虚构：客户不要了'),
      audits = () => count(f.store.db, "SELECT count(*) FROM business_audit WHERE entity='orders'");
    const before = [audits(), now.status];
    const rejected = (e: unknown) => e instanceof InputError && /已产生送货记录的订单状态由实际交付进度维护/.test(e.message);
    assert.throws(() => changeOrderStatus(f.store, order.id, 'cancel', once, clerk), rejected);
    assert.throws(() => changeOrderStatus(f.store, order.id, 'cancel', once, clerk), rejected, '没被当成已办的请求');
    assert.deepEqual([audits(), sales(f.store).order(order.id)?.status], before);
    assert.equal(f.store.db.prepare("SELECT 1 FROM operation_requests WHERE request_id=?").get(once.requestId), undefined);
  } finally {
    f.store.close();
  }
});

test('归档：归档客户、产品不连带订单；没发完货的订单不能归档；已发完的能归档、恢复，都记审计', () => {
  const f = fixture();
  try {
    const items = (row: { id: number; version: number }) => ({ action: 'archive', acknowledged: true, items: [{ id: row.id, version: row.version }] });
    const change = (entity: Parameters<typeof changeLifecycle>[1], row: { id: number; version: number }, action = 'archive') =>
      changeLifecycle(f.store, entity, { ...items(row), action }, actor).results[0];
    const customer = must(sales(f.store).customer(f.order.customerId), '客户'),
      product = must(sales(f.store).product(f.order.lines[0].productId), '产品');
    for (const [entity, row] of [['customers', customer], ['products', product]] as const) {
      assert.equal(change(entity, row).success, true);
      assert.equal(sales(f.store).orders().length, 1, '订单不跟着归档');
      assert.equal(sales(f.store).order(f.order.id)?.lines[0].productName, '虚构状态纸箱');
      assert.equal(change(entity, row, 'restore').success, true);
    }
    const confirmed = changeOrderStatus(f.store, f.order.id, 'confirm', input(f.order), actor);
    assert.equal(change('orders', confirmed).success, false, '已确认、没发完货');
    const shipped = sales(f.store).saveOrder({ ...confirmed, status: '已发货' }, confirmed.id, confirmed.version);
    assert.equal(change('orders', shipped).success, true);
    assert.deepEqual([sales(f.store).orders().length, sales(f.store).orders(true).length], [0, 1]);
    assert.equal(change('orders', shipped, 'restore').success, true);
    assert.equal(sales(f.store).orders().length, 1);
    assert.deepEqual(
      f.audits('orders', f.order.id).map((r) => r.action).slice(-2),
      ['archive', 'restore'],
    );
  } finally {
    f.store.close();
  }
});

test('整张保存订单不改状态：带了不一样的状态拒绝并指到详情里的按钮；状态不变照常保存', () => {
  const f = fixture();
  try {
    assert.throws(
      () => assertOrderStatusKept(f.store, f.order.id, { ...f.order, status: '已取消' }),
      failsWith(409, /取消要写原因/),
    );
    assert.doesNotThrow(() => assertOrderStatusKept(f.store, f.order.id, { ...f.order, notes: '只改备注' }));
  } finally {
    f.store.close();
  }
});

test('采购单的改成待到货、退回、取消、恢复：改成待到货自动建订货单；取消必填原因；整张保存改状态被拒', () => {
  const f = fixture();
  try {
    const batches = new OrderBatchService(f.store);
    let p = f.flow.stock.changePurchaseStatus(f.purchase.id, 'confirm', input(f.purchase), actor);
    assert.equal(p.baseStatus, '已订货');
    assert.notEqual(batches.batchIdOf(p.id), null, '改成已订货自动建订货单，和整张保存时一样');
    p = f.flow.stock.changePurchaseStatus(p.id, 'revert', input(p), actor);
    assert.equal(p.baseStatus, '待订货');
    assert.throws(() => f.flow.stock.changePurchaseStatus(p.id, 'cancel', input(p), actor), /请填写取消原因/);
    p = f.flow.stock.changePurchaseStatus(p.id, 'cancel', input(p, '供应商停产，虚构原因'), actor);
    assert.equal(p.baseStatus, '已取消');
    p = f.flow.stock.changePurchaseStatus(p.id, 'reinstate', input(p), actor);
    assert.equal(p.baseStatus, '待订货', '没到过货的恢复为待订货');
    const rows = f.audits('purchases', p.id).slice(1);
    assert.deepEqual(rows.map((r) => r.action), ['confirm', 'revert', 'cancel', 'reinstate']);
    assert.equal(rows[2].document.reason, '供应商停产，虚构原因');
    // 整张保存（PUT 走 keepStatus）不改状态
    assert.throws(
      () => f.flow.stock.savePurchase({ ...p, status: '已取消', version: p.version }, actor, p.id, { keepStatus: true }),
      failsWith(409, /采购单详情/),
    );
    const kept = f.flow.stock.savePurchase({ ...p, status: p.baseStatus, notes: '只改备注', version: p.version }, actor, p.id, { keepStatus: true });
    assert.equal(kept.notes, '只改备注');
  } finally {
    f.store.close();
  }
});

test('采购单状态动作：没权限、版本对不上、当前状态不对拒绝；同一请求号重试原样返回', () => {
  const f = fixture();
  try {
    assert.throws(() => f.flow.stock.changePurchaseStatus(f.purchase.id, 'confirm', input(f.purchase), reader), failsWith(403));
    assert.throws(
      () => f.flow.stock.changePurchaseStatus(f.purchase.id, 'confirm', { ...input(f.purchase), expectedVersion: 99 }, actor),
      failsWith(409),
    );
    assert.throws(() => f.flow.stock.changePurchaseStatus(f.purchase.id, 'revert', input(f.purchase), actor), failsWith(409));
    const once = input(f.purchase);
    const first = f.flow.stock.changePurchaseStatus(f.purchase.id, 'confirm', once, actor);
    assert.deepEqual(f.flow.stock.changePurchaseStatus(f.purchase.id, 'confirm', once, actor), first);
    assert.equal(f.audits('purchases', f.purchase.id).filter((r) => r.action === 'confirm').length, 1);
    assert.throws(() => f.flow.stock.changePurchaseStatus(f.purchase.id, 'cancel', { ...once, reason: '换了' }, actor), failsWith(409));
  } finally {
    f.store.close();
  }
});

/** 在账号库里加一个没有业务编辑权限的“虚构只读”账号，口令和第一个账号（管理员）一样 */
function addReader(authFile: string) {
  const db = new DatabaseSync(authFile),
    row = must(db.prepare('SELECT * FROM users LIMIT 1').get(), '管理员账号');
  db.prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)').run(
    randomUUID(),
    '虚构只读',
    row.salt,
    row.password_hash,
    '[]',
    'admin',
  );
  db.close();
}

test('HTTP：POST /orders/:id/cancel 要原因；PUT 改状态被拒；/purchases/:id/confirm 走同一个动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-record-status-')),
    store = new Store(':memory:'),
    authFile = join(dir, 'users.sqlite'),
    h = await startHttp(store, {
      auth: new AuthManager(authFile),
      admin: { name: '虚构状态管理员', password: 'Fictional-status-password-123' },
    });
  try {
    let cookie = h.cookie;
    const req = (path: string, body?: unknown, method?: string) => h.send(path, body, cookie, { method });
    // 回答按 shape 读（记录整份留着，要原样交回整张保存）
    const json = async <T extends z.ZodRawShape>(r: Response, shape: T) => {
      const body: unknown = await r.json();
      return { status: r.status, body: readAs(body, shape) };
    };
    const record = { id: z.number(), version: z.number() };
    const customer = (await json(await req('/customers', { name: '虚构接口客户' }), record)).body,
      product = (await json(await req('/products', { name: '虚构接口纸箱' }), record)).body;
    const order = (
      await json(
        await req('/orders', {
          customerId: customer.id,
          orderDate: '2026-11-01',
          deliveryDate: '2026-11-30',
          status: '已确认',
          lines: [{ productId: product.id, quantity: 10, unit: '只', unitPriceCents: 100 }],
        }),
        record,
      )
    ).body;
    const noReason = await json(await req('/orders/' + order.id + '/cancel', { expectedVersion: order.version, requestId: randomUUID() }), { message: z.string() });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.message, /请填写取消原因/);
    const put = await req('/orders/' + order.id, { ...order, status: '已取消' }, 'PUT');
    assert.equal(put.status, 409);
    const cancelled = await json(
      await req('/orders/' + order.id + '/cancel', { expectedVersion: order.version, requestId: randomUUID(), reason: '虚构接口原因' }),
      { status: z.string(), version: z.number() },
    );
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, '已取消');
    // 只读账号（没有业务编辑权限）不能改状态
    addReader(authFile);
    const login = await req('/auth/login', { name: '虚构只读', password: 'Fictional-status-password-123' });
    const owner = cookie;
    cookie = cookieOf(login);
    const denied = await req('/orders/' + order.id + '/reinstate', { expectedVersion: cancelled.body.version, requestId: randomUUID() });
    assert.equal(denied.status, 403);
    cookie = owner;
    const supplier = (await json(await req('/suppliers', { name: '虚构接口供应商' }), record)).body;
    const purchase = (
      await json(
        await req('/purchases', {
          supplierId: supplier.id,
          orderDate: '2026-11-01',
          status: '待订货',
          notes: '',
          lines: [{ name: '虚构接口纸板', length: 1000, width: 800, dimensionUnit: 'mm', quantity: '10', unit: '张', priceBasis: 'quantity' }],
        }),
        record,
      )
    ).body;
    const putPurchase = await req('/purchases/' + purchase.id, { ...purchase, status: '已订货' }, 'PUT');
    assert.equal(putPurchase.status, 409);
    const confirmed = await json(
      await req('/purchases/' + purchase.id + '/confirm', { expectedVersion: purchase.version, requestId: randomUUID() }),
      { baseStatus: z.string() },
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.baseStatus, '已订货');
  } finally {
    await h.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
