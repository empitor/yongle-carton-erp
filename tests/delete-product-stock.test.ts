// 删产品连带成品库存（server/core/deletion-rules.ts 登记的规则，经 /deletions 接口）：成品一定关联产品，不留没有产品的成品；
// 流水和引用它的单据按删库存品的规则处理；删客户不动成品库存；初始化照常清空。内存库、虚构数据，起真实服务。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AuthManager } from '../server/accounts/index.js';
import { count } from '../server/core/index.js';
import { BusinessReset } from '../server/admin/business-reset.js';
import { impactRowSchema } from '../shared/business/deletion-request.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { saveDoc } from './receive-fixture.js';
import { startHttp } from './http-fixture.js';
import './delete-fixture.js';
import { actor, superActor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';

/** 删除预览的回答里测试要看的几项（影响清单按共用结构读） */
const previewAnswer = z.looseObject({ digest: z.string(), inventoryChoice: z.number(), impact: z.array(impactRowSchema) });

/** 起一个不在本机管理（要进超级管理员模式）的服务；post 要求 200 并交回正文 */
async function deletionServer() {
  const password = 'Fictional-delete-finished-pass-123',
    store = new Store(':memory:'),
    h = await startHttp(store, {
      auth: new AuthManager(':memory:', Date.now, { localAdministration: false }),
      admin: { name: '虚构服务器管理员', password },
    });
  const post = async (path: string, body: unknown) => {
    const r = await h.post(path, body);
    const data: unknown = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    return data;
  };
  await post('/auth/super-admin/enter', { password });
  const base = businessBase(actor, store),
    { flow, ops } = base;
  const move = (item: { id: number }, action: string, quantity: string) =>
    flow.stock.move(
      item.id,
      { action, quantity, date: '2026-11-09', notes: '虚构', acknowledged: true, requestId: randomUUID(), expectedVersion: ops.items(true, item.id)[0].version },
      actor,
    );
  const preview = async (selection: unknown) => previewAnswer.parse(await post('/deletions/preview', selection));
  const execute = (selection: object, digest: string) => post('/deletions/execute', { ...selection, requestId: randomUUID(), deletionDigest: digest, password });
  return { store, flow, ops, base, move, preview, execute, close: () => h.close() };
}
type Server = Awaited<ReturnType<typeof deletionServer>>;

/**
 * 三个产品的成品库存：甲完工入库 100（领纸板 10 张）、送出 30，余 70；乙手工入 50 出 50，余 0；丙建了没用过。
 * 纸板期初 100 张。
 */
function productStocks(s: Server) {
  const { flow, base, move } = s;
  const confirm = (doc: { id: number }) => base.check(doc);
  const board = base.raw({ name: '虚构纸板' }, { quantity: '100', date: '2026-11-09', notes: '虚构' });
  const customer = base.customer({ name: '虚构客户' });
  const [busy, idle, fresh] = ['虚构成品甲', '虚构成品乙', '虚构成品丙'].map((name) => base.product({ name }));
  const order = base.order(customer, [base.line(busy, 100, { productName: busy.name, notes: '' })], {
    orderDate: '2026-11-09',
    deliveryDate: '2026-11-20',
    notes: '',
    costs: null,
  });
  const task = saveDoc(flow, 'task', { date: '2026-11-09', plannedDate: '2026-11-10', productId: busy.id, quantity: '100', unit: '只', orderIds: [order.id], notes: '' }, actor);
  const made = confirm(
    saveDoc(flow, 'production', { date: '2026-11-10', taskId: task.id, productId: busy.id, goodQuantity: '100', operator: '虚构机长', materials: [{ stockId: board.id, issued: '10', returned: '0' }] }, actor),
  );
  const busyStock = Number(flow.get(made.id, 'production').finishedStockId);
  confirm(saveDoc(flow, 'delivery', { date: '2026-11-10', plannedDate: '2026-11-10', customerId: customer.id, address: '', contact: '', phone: '', lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: busyStock, quantity: '30', notes: '' }], notes: '' }, actor));
  const idleStock = base.finished(idle, { name: '虚构成品乙' });
  move(idleStock, 'in', '50');
  move(idleStock, 'out', '50');
  const freshStock = base.finished(fresh, { name: '虚构成品丙' });
  return { board, busy, idle, fresh, busyStock, idleStock: idleStock.id, freshStock: freshStock.id };
}

/** 经接口删一个产品：核对影响清单里它的成品库存和流水的写法，删完库存品、流水都没了，删掉的流水留了修订记录；交回预览 */
async function removeProduct(s: Server, product: { id: number; name: string }, stockId: number, inventoryPolicy?: 'preserve' | 'recalculate') {
  const { store } = s;
  const exists = (table: string, id: number) => !!store.db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?').get(id);
  const movesOf = (id: number) => count(store.db, 'SELECT count(*) FROM stock_movements WHERE item_id=?', id);
  const revisionsOf = (id: number) => count(store.db, 'SELECT count(*) FROM stock_movement_revisions WHERE item_id=?', id);
  const current = sales(store).product(product.id, true);
  assert.ok(current, '要删的产品还在');
  const selection = { module: 'products', items: [{ id: product.id, version: current.version }], ...(inventoryPolicy ? { inventoryPolicy } : {}) };
  const plan = await s.preview(selection);
  const rows = plan.impact.filter((r) => r.table === 'stock_items');
  // 成品库存是删，不是“解除关联”；叫法是库存品的名称，流水用“哪种货 出/入 多少”，没有英文和内部编号
  assert.deepEqual(rows.map((r) => [r.id, r.action, r.name]), [[stockId, 'delete', product.name]]);
  for (const r of plan.impact.filter((r) => ['stock_items', 'stock_movements'].includes(r.table)))
    assert.doesNotMatch(String(r.name), /[A-Za-z#]/, JSON.stringify(r));
  const moves = movesOf(stockId),
    revisions = revisionsOf(stockId);
  assert.equal(plan.impact.filter((r) => r.table === 'stock_movements' && String(r.name).startsWith(product.name)).length, moves);
  await s.execute(selection, plan.digest);
  assert.equal(exists('products', product.id), false);
  assert.equal(exists('stock_items', stockId), false);
  assert.equal(movesOf(stockId), 0);
  assert.equal(revisionsOf(stockId), revisions + moves, '删掉的流水都留了修订记录');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  return plan;
}

test('删产品：它的成品库存跟着删（成品一定关联产品，不留没有产品的成品），流水和引用它的单据按删库存品的规则处理；影响清单列出这个库存品', async () => {
  const s = await deletionServer();
  try {
    const p = productStocks(s);
    assert.equal(s.ops.balance(p.busyStock), 70_000);
    assert.equal(s.ops.balance(p.board.id), 90_000);
    // 甲：完工、送货单跟着删，选“库存一起改回”时领的纸板退回去
    const plan = await removeProduct(s, p.busy, p.busyStock, 'recalculate');
    assert.ok(plan.inventoryChoice > 0, '有完工、送货的流水要选库存怎么处理');
    assert.ok(plan.impact.some((r) => r.table === 'flow_documents' && r.kind === 'production' && r.action === 'delete'));
    assert.equal(s.ops.balance(p.board.id), 100_000);
    assert.deepEqual(s.flow.list('production', true), []);
    // 乙：只有手工流水，不用选库存怎么处理
    assert.equal((await removeProduct(s, p.idle, p.idleStock)).inventoryChoice, 0);
    // 丙：从没用过，清单里只有产品和它的成品库存
    const plain = await removeProduct(s, p.fresh, p.freshStock);
    assert.deepEqual(plain.impact.map((r) => [r.table, r.action]).sort(), [['products', 'delete'], ['stock_items', 'delete']]);
    assert.equal(s.ops.balance(p.board.id), 100_000, '纸板不受影响');
  } finally {
    await s.close();
    s.store.close();
  }
});

test('删客户不动成品库存和它关联的产品；初始化（清空业务数据）成品库存先于产品清掉，不撞“成品一定关联产品”', async () => {
  const s = await deletionServer(),
    { store, ops } = s;
  try {
    productStocks(s);
    // 删客户：产品不挂客户，成品库存和它关联的产品都不动
    const keep = s.base.product({ name: '虚构成品丁' }),
      keepStock = s.base.finished(keep, { name: '虚构成品丁' }),
      buyer = s.base.customer({ name: '虚构要删的客户' });
    s.base.order(buyer, [s.base.line(keep, 10, { productName: keep.name, notes: '' })], {
      orderDate: '2026-11-09',
      deliveryDate: '2026-11-20',
      notes: '',
      costs: null,
    });
    const customerSelection = { module: 'customers', items: [{ id: buyer.id, version: buyer.version }] };
    const customerPlan = await s.preview(customerSelection);
    assert.ok(!customerPlan.impact.some((r) => ['products', 'stock_items'].includes(r.table)));
    await s.execute(customerSelection, customerPlan.digest);
    assert.equal(ops.items(true, keepStock.id)[0].productId, keep.id);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    // 初始化（清空业务数据）：成品库存先于产品清掉，不撞“成品一定关联产品”
    new BusinessReset(store).execute({ scope: 'business' }, localAdministratorActor(superActor()));
    for (const table of ['stock_items', 'products', 'stock_movements']) assert.equal(count(store.db, 'SELECT count(*) FROM ' + table), 0, table);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await s.close();
    s.store.close();
  }
});
