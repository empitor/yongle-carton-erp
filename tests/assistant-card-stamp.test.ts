// 出卡片以后相关数据变了，旧卡片确认时被拒（server/assistant/tools.ts 的 stamp、previews.ts 的 commit）：
// 档案改了或归档了、单据改了、库存品的库存变了，都说清是哪条变了；数据没变的照常执行。
// 版本绑定之外，改生产任务计划数的规则（不能少于已登记的完工数）由单据保存服务守着，两层不冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../server/core/errors.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { updateDocumentInfo } from '../server/flow/index.js';
import { planStamp } from '../server/assistant/card-stamp.js';
import { customerSchema, orderSchema } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import { autoConfirmAssistant } from './assistant-fixture.js';
import { superActor } from './actor-fixture.js';

const saved = z.looseObject({ id: z.number(), version: z.number(), name: z.string() });
const purchaseSaved = z.looseObject({ id: z.number(), lines: z.array(z.looseObject({ id: z.number() })) });
const CARD_LIFETIME_MS = 60_000;

function setup() {
  const f = autoConfirmAssistant(),
    who = localAdministratorActor(superActor()),
    tools = f.manager.tools;
  /** 出一张卡片存起来（和聊天里出卡片同一个存法），返回“人点确认” */
  const card = (tool: string, args: unknown) => {
    const plan = tools.prepare(tool, args, who, 'card'),
      id = randomUUID();
    f.manager.previews.save({ id, threadId: f.manager.create(who).id, actor: who, binding: 'card', expiresAt: Date.now() + CARD_LIFETIME_MS, plan, stamp: tools.stamp(plan, who) });
    return () => f.manager.execute(id, { acknowledged: true }, who, 'card');
  };
  const base = businessBase(who, f.store);
  const rawItem = (name: string) => saved.parse(base.raw({ name }));
  const stockIn = (id: number, quantity: string) => base.stockIn({ id }, { quantity, date: '2026-10-20', notes: '虚构入库' });
  return { f, who, tools, base, card, rawItem, stockIn };
}
/** 确认被拒：卡片过期，说出变了的那条 */
const stale = (name: string) => (e: unknown) => e instanceof AppError && e.code === 'card-stale' && e.message.includes(name) && e.message.includes(' 变了');

test('出卡片以后档案被改、被归档：旧卡片确认被拒，说清是哪位客户；没变的照常执行', () => {
  const { f, who, tools, base, card } = setup();
  try {
    const a = base.customer({ name: '虚构改过的客户' }),
      b = base.customer({ name: '虚构归档的客户' }),
      c = base.customer({ name: '虚构没变的客户' });
    // 没人动过：照常执行
    card('records.propose_save', { module: 'customers', id: c.id, patch: { phone: '333' } })();
    assert.equal(f.store.customer(c.id)?.phone, '333');
    const editA = card('records.propose_save', { module: 'customers', id: a.id, patch: { phone: '111' } });
    f.store.saveCustomer(customerSchema.parse({ name: '虚构改过的客户', notes: '页面上刚改过' }), a.id, a.version);
    assert.throws(editA, stale('虚构改过的客户'));
    assert.equal(f.store.customer(a.id)?.phone, '', '被拒的没有执行');
    const editB = card('records.propose_save', { module: 'customers', id: b.id, patch: { phone: '222' } });
    tools.commit(tools.prepare('records.propose_lifecycle', { module: 'customers', id: b.id, action: 'archive' }, who, 'other'), who, 'other');
    assert.throws(editB, stale('虚构归档的客户'));
  } finally {
    f.close();
  }
});

test('出卡片以后单据被改：旧卡片确认被拒，说清是哪张单据', () => {
  const { f, who, tools, base, card, rawItem } = setup();
  try {
    const supplier = saved.parse(base.supplier({ name: '虚构供应商' })),
      raw = rawItem('虚构纸板');
    const arrival = tools.flow.save('arrival', { date: '2026-10-20', supplierId: supplier.id, reference: '虚构样品', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '30' }] }, who);
    tools.commit(tools.prepare('flow.propose_confirmation', { id: arrival.id }, who, 'other'), who, 'other');
    const edit = card('flow.edit_info', { id: arrival.id, notes: '虚构：卡片上改的' });
    updateDocumentInfo(f.store, arrival.id, { notes: '虚构：页面上刚改的', expectedVersion: tools.flow.get(arrival.id).version }, who);
    assert.throws(edit, stale(arrival.number));
    assert.equal(tools.flow.get(arrival.id).notes, '虚构：页面上刚改的');
  } finally {
    f.close();
  }
});

test('出卡片以后库存品的库存变了：出入库卡片、改库存品的卡片都被拒，说清是哪个库存品', () => {
  const { f, tools, card, rawItem, stockIn } = setup();
  try {
    const raw = rawItem('虚构纸板乙');
    stockIn(raw.id, '30');
    const out = card('inventory.propose_movement', { id: raw.id, action: 'out', quantity: '5', date: '2026-10-21', notes: '虚构领用' }),
      rename = card('records.propose_save', { module: 'raw_inventory', id: raw.id, patch: { notes: '虚构备注' } });
    stockIn(raw.id, '10');
    assert.throws(out, stale('虚构纸板乙'));
    assert.throws(rename, stale('虚构纸板乙'));
    assert.equal(tools.ops.balance(raw.id), 40_000, '库存只有两次入库');
  } finally {
    f.close();
  }
});

/** 一张订单：客户、产品、一行 100 只 */
function orderSetup(base: ReturnType<typeof setup>['base']) {
  const c = base.customer({ name: '虚构订单客户' }),
    p = base.product({ name: '虚构订单纸箱' });
  const fields = { customerId: c.id, orderDate: '2026-10-01', deliveryDate: '2026-11-30', status: '已确认' };
  const o = base.order(c, [base.line(p, 100)], fields);
  return { o, fields };
}

test('出卡片以后订单明细被页面改了：改这张订单的卡片确认被拒，说清单号', () => {
  const s = setup();
  try {
    const { o, fields } = orderSetup(s.base);
    const edit = s.card('records.propose_save', { module: 'orders', id: o.id, patch: { notes: '虚构卡片上改的备注' } });
    s.f.store.saveOrder(orderSchema.parse({ ...fields, lines: [{ ...o.lines[0], quantity: 120 }] }), o.id, o.version);
    assert.throws(edit, stale(o.number));
    assert.equal(s.f.store.order(o.id)?.notes, '', '被拒的没有执行');
  } finally {
    s.f.close();
  }
});

test('出卡片以后只是采购单由单据算出的进度变了（登记了一张待入库的到货）：改这张采购单的卡片照常执行', () => {
  const s = setup();
  try {
    const { who, tools, card, rawItem } = s;
    const supplier = saved.parse(s.base.supplier({ name: '虚构采购供应商' })),
      raw = rawItem('虚构采购纸板');
    const purchase = purchaseSaved.parse(
      tools.ops.savePurchase({ supplierId: supplier.id, status: '已订货', orderDate: '2026-11-01', lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }] }, who),
    );
    const version = tools.flow.views.purchases(true, purchase.id)[0].version,
      seen = JSON.stringify(tools.read('records.get', { module: 'purchases', id: purchase.id }, who));
    const edit = card('records.propose_save', { module: 'purchases', id: purchase.id, patch: { notes: '虚构卡片上改的备注' } });
    tools.flow.save('arrival', { date: '2026-11-02', supplierId: supplier.id, reference: '虚构送货单', lines: [{ stockId: raw.id, purchaseLineId: purchase.lines[0].id, item: { name: raw.name, unit: '张' }, quantity: '300' }] }, who);
    assert.equal(tools.flow.views.purchases(true, purchase.id)[0].version, version, '采购单本身没改（版本号没动）');
    assert.notEqual(JSON.stringify(tools.read('records.get', { module: 'purchases', id: purchase.id }, who)), seen, '助手看到的到货进度变了');
    edit();
    assert.equal(tools.flow.views.purchases(true, purchase.id)[0].notes, '虚构卡片上改的备注');
  } finally {
    s.f.close();
  }
});

test('出卡片以后有人按这张生产任务登记了待入库的完工：把任务改少的卡片确认被拒，说清是哪张完工单', () => {
  const s = setup();
  try {
    const { who, tools, card, rawItem, stockIn } = s;
    const p = s.base.product({ name: '虚构任务纸箱' }),
      raw = rawItem('虚构任务纸板');
    stockIn(raw.id, '100');
    const task = tools.flow.save('task', { date: '2026-10-20', productId: p.id, quantity: '1000', unit: '只', orderIds: [], notes: '' }, who);
    const shrink = card('records.propose_save', { module: 'production_tasks', id: task.id, patch: { quantity: '500' } });
    const done = tools.flow.save('production', { date: '2026-10-21', taskId: task.id, productId: p.id, goodQuantity: '800', scrapQuantity: '0', operator: '虚构机长', materials: [{ stockId: raw.id, issued: '10', returned: '0' }] }, who);
    assert.equal(tools.flow.get(task.id).version, task.version, '登记待入库的完工不动任务的版本号');
    assert.throws(shrink, stale(done.number));
    assert.equal(tools.flow.get(task.id, 'task').quantity, '1000', '被拒的没有执行');
  } finally {
    s.f.close();
  }
});

test('卡片要把任务计划数改到已登记的完工数以下：出卡片时试执行就被服务拒绝；出卡片以后才登记的，卡片作废，绕过绑定直接执行也被服务拒绝', () => {
  const s = setup();
  try {
    const { who, tools, card, rawItem, stockIn } = s;
    const p = s.base.product({ name: '虚构计划纸箱' }),
      raw = rawItem('虚构计划纸板');
    stockIn(raw.id, '100');
    const task = tools.flow.save('task', { date: '2026-10-20', productId: p.id, quantity: '1000', unit: '只', orderIds: [], notes: '' }, who);
    const register = (goodQuantity: string) =>
      tools.flow.save('production', { date: '2026-10-21', taskId: task.id, productId: p.id, goodQuantity, scrapQuantity: '0', operator: '虚构机长', materials: [{ stockId: raw.id, issued: '10', returned: '0' }] }, who);
    const below = (waiting: string) => (e: unknown) =>
      e instanceof AppError && e.status === 422 && e.message === '计划数不能少于已登记的完工数（已入库 0 只，待核对入库 ' + waiting + ' 只）。';
    const shrink = { module: 'production_tasks', id: task.id, patch: { quantity: '900' } };
    register('800');
    assert.throws(() => card('records.propose_save', { ...shrink, patch: { quantity: '500' } }), below('800'));
    const plan = tools.prepare('records.propose_save', shrink, who, 'card'),
      confirmCard = card('records.propose_save', shrink);
    const late = register('200');
    assert.throws(confirmCard, stale(late.number));
    assert.throws(() => tools.commit(plan, who, 'card'), below('1000'));
    assert.equal(tools.flow.get(task.id, 'task').quantity, '1000', '被拒的没有执行');
  } finally {
    s.f.close();
  }
});

/** 只看数据版本（card-stamp.ts 的 planStamp）：按模块绑定的卡片，别的模块的数据变了不作废，本模块的变了才作废 */
test('按模块绑定的数据版本：原材料的不受成品出入库影响，成品的随成品库存变；客户的不受库存和单据影响', () => {
  const { f, who, tools, base, rawItem, stockIn } = setup();
  try {
    const p = base.product({ name: '虚构绑定纸箱' }),
      finished = saved.parse(base.finished(p, { name: '虚构绑定成品' })),
      raw = rawItem('虚构绑定纸板'),
      supplier = saved.parse(base.supplier({ name: '虚构绑定供应商' }));
    base.customer({ name: '虚构绑定客户' });
    const stampOf = (module?: string) => JSON.stringify(planStamp(f.store, { args: module ? { module } : {} }));
    const seen = { raw: stampOf('raw_inventory'), finished: stampOf('finished_inventory'), customers: stampOf('customers'), none: stampOf() };
    stockIn(finished.id, '10');
    tools.flow.save('arrival', { date: '2026-10-20', supplierId: supplier.id, reference: '虚构样品', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '3' }] }, who);
    assert.equal(stampOf('raw_inventory'), seen.raw, '成品入库、登记待入库的到货不动原材料的绑定');
    assert.equal(stampOf('customers'), seen.customers, '库存、单据变了不动客户的绑定');
    assert.notEqual(stampOf('finished_inventory'), seen.finished, '成品库存变了');
    assert.notEqual(stampOf(), seen.none, '不带模块的绑定看库存品和单据');
    assert.equal(stampOf('movements'), stampOf(), '流水没有自己的绑定，按不带模块的取');
  } finally {
    f.close();
  }
});

test('按模块绑定的数据版本：供应商改名、产品归档、生产任务改了，各自模块的绑定变，别的单据种类的不变', () => {
  const { f, who, tools, base } = setup();
  try {
    const supplier = saved.parse(base.supplier({ name: '虚构改名供应商' })),
      p = base.product({ name: '虚构归档纸箱' });
    const task = { date: '2026-10-20', productId: p.id, quantity: '100', unit: '只', orderIds: [], notes: '' };
    const issued = tools.flow.save('task', task, who);
    const stampOf = (module: string) => JSON.stringify(planStamp(f.store, { args: { module } }));
    const seen = { suppliers: stampOf('suppliers'), products: stampOf('products'), tasks: stampOf('production_tasks'), arrivals: stampOf('arrivals') };
    tools.ops.saveSupplier({ name: '虚构改名后的供应商', version: supplier.version }, who, supplier.id);
    tools.flow.save('task', { ...task, notes: '虚构改过', version: issued.version }, who, issued.id);
    assert.notEqual(stampOf('suppliers'), seen.suppliers);
    assert.notEqual(stampOf('production_tasks'), seen.tasks);
    assert.equal(stampOf('arrivals'), seen.arrivals, '供应商改名、生产任务改了不动到货的绑定');
    tools.commit(tools.prepare('records.propose_lifecycle', { module: 'products', id: p.id, action: 'archive' }, who, 'other'), who, 'other');
    assert.notEqual(stampOf('products'), seen.products);
  } finally {
    f.close();
  }
});
