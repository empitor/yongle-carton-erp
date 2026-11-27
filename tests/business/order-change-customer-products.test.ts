// 订单选错客户改回来（用户 2026-11-27 定）：产品属原客户、全部订单明细都在这张订单里，就和订单在同一个保存点里改归新客户，
// 写产品修改历史；别的订单也用过的照旧拦；改过去撞查重照现有说法拦（同名不同尺寸材质的不拦）。
// 判断在 shared/core/product-details.ts 的 productMovesWithOrder，保存在 server/orders/service.ts 的 saveOrderCommand。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sales } from '../../server/sales/index.js';
import { z } from 'zod';
import { localAdministratorActor, many, type Actor } from '../../server/core/index.js';
import { changeLifecycle } from '../../server/lifecycle/index.js';
import { DataManagementService } from '../../server/admin/index.js';
import { orderSchema, productCustomerIssue } from '../../shared/core/index.js';
import { actor as baseActor, pageActor, superActor } from '../support/actor-fixture.js';
import { businessBase, manualWrite } from '../support/business-base-fixture.js';
import { autoConfirmAssistant } from '../support/assistant-fixture.js';
import { listen, testProblems } from '../support/http-fixture.js';
import { createApp } from '../../server/app.js';

const editor = pageActor({ id: 'u1', name: '虚构业务员', permissions: ['business:edit'] });
const localAdmin = localAdministratorActor({ ...baseActor, role: 'super_admin' });
type Base = ReturnType<typeof businessBase>;

const orderInput = (customerId: number, lines: { id?: number; productId: number }[]) =>
  orderSchema.parse({
    customerId,
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-10',
    status: '已确认',
    lines: lines.map((l) => ({ ...l, quantity: 100, unitPriceCents: 200, unit: '只' })),
  });

/** 甲、乙两家客户，甲的一张订单（一行甲专用箱、一行没定客户的通用箱） */
function setup(base: Base) {
  const a = base.customer({ name: '虚构甲' }),
    b = base.customer({ name: '虚构乙' });
  const mine = base.product({ name: '甲专用箱', customerId: a.id, customerProductCode: 'JA-1', length: 300, width: 200, height: 100, dimensionUnit: 'mm', material: 'K=A' }),
    generic = base.product({ name: '通用周转箱' });
  const order = sales(base.store).saveOrder(orderInput(a.id, [{ productId: mine.id }, { productId: generic.id }]));
  return { a, b, mine, generic, order };
}
/** 把订单改给 customerId，明细原样带回（lines 给了就用它） */
const changeTo = (base: Base, orderId: number, customerId: number, who: Actor = editor, lines?: { id?: number; productId: number }[]) => {
  const o = sales(base.store).order(orderId, true);
  assert.ok(o);
  return manualWrite(base.store, { entity: 'orders', action: 'update', id: orderId, input: { ...orderInput(customerId, lines ?? o.lines), version: o.version } }, who);
};
const auditRow = z.object({ source: z.string(), document: z.string() });
const productAudits = (base: Base, id: number) =>
  many(base.store.db, auditRow, "SELECT source,document FROM business_audit WHERE entity='products' AND record_id=? ORDER BY id", id);
/** 订单换客户带过去的那条产品修改历史 */
const movedAudit = z.object({
  before: z.object({ customerId: z.number() }),
  after: z.object({ customerId: z.number() }),
  reason: z.string(),
  trigger: z.unknown(),
});

test('产品属甲、只在这张单里：换成乙成功，产品归属和订单在同一次保存里改过去、版本加一、留产品修改历史；没定客户的不动；再换回甲跟着回来', () => {
  const base = businessBase(editor);
  try {
    const { a, b, mine, generic, order } = setup(base);
    const saved = changeTo(base, order.id, b.id);
    assert.equal(saved.customerId, b.id);
    const moved = sales(base.store).product(mine.id);
    assert.deepEqual([moved?.customerId, moved?.customerName, moved?.version], [b.id, '虚构乙', mine.version + 1]);
    assert.equal(sales(base.store).product(generic.id)?.customerId, undefined);
    assert.deepEqual(productAudits(base, generic.id), []);
    const [entry] = productAudits(base, mine.id);
    const doc = movedAudit.parse(JSON.parse(entry.document));
    assert.deepEqual([entry.source, doc.before.customerId, doc.after.customerId], ['page', a.id, b.id]);
    assert.match(doc.reason, new RegExp('订单 ' + order.number + ' 换了客户'));
    assert.deepEqual(doc.trigger, { action: 'update', entity: 'orders', id: order.id, number: order.number });
    changeTo(base, order.id, a.id);
    assert.equal(sales(base.store).product(mine.id)?.customerId, a.id);
  } finally {
    base.store.close();
  }
});

test('产品也在甲别的订单里用过（那张已取消并归档）：照旧拒、原句不变，产品和订单都不动；删掉这一行再换客户，产品不动', () => {
  const base = businessBase(localAdmin);
  try {
    const { a, b, mine, generic, order } = setup(base);
    const other = sales(base.store).saveOrder({ ...orderInput(a.id, [{ productId: mine.id }]), status: '已取消' });
    changeLifecycle(base.store, 'orders', { action: 'archive', acknowledged: true, items: [{ id: other.id, version: other.version }] }, localAdmin);
    const issue = productCustomerIssue(sales(base.store).product(mine.id) ?? {}, b);
    assert.ok(issue);
    for (const who of [editor, localAdmin]) assert.throws(() => changeTo(base, order.id, b.id, who), (e: Error) => e.message === issue);
    assert.deepEqual([sales(base.store).product(mine.id)?.version, sales(base.store).order(order.id)?.customerId], [mine.version, a.id]);
    const lines = sales(base.store).order(order.id)?.lines.filter((l) => l.productId === generic.id) ?? [];
    changeTo(base, order.id, b.id, editor, lines);
    assert.equal(sales(base.store).product(mine.id)?.customerId, a.id);
  } finally {
    base.store.close();
  }
});

test('改过去撞上乙已有的产品：料号相同、同名同尺寸材质的拒，前面说清是哪个产品，后面是查重原句，全部回滚；同名不同尺寸的照样跟着走', () => {
  const base = businessBase(editor);
  try {
    const { a, b, mine, order } = setup(base);
    const prefix = '产品“甲专用箱”只在这张订单里下过单，要跟着订单改归 虚构乙：';
    const sameCode = base.product({ name: '乙的箱子', customerId: b.id, customerProductCode: 'ja-1' });
    assert.throws(() => changeTo(base, order.id, b.id), (e: Error & { status?: number; code?: string }) =>
      e.message.startsWith(prefix + '客户料号“JA-1”已经用在：乙的箱子') && e.status === 409 && e.code === 'duplicate-product');
    manualWrite(base.store, { entity: 'products', action: 'update', id: sameCode.id, input: { ...sameCode, customerProductCode: 'B-9' } }, editor);
    const twin = base.product({ name: '甲专用箱', customerId: b.id, length: 300, width: 200, height: 100, dimensionUnit: 'mm', material: 'K=A' });
    assert.throws(() => changeTo(base, order.id, b.id), (e: Error) => e.message.startsWith(prefix + '“甲专用箱”已有尺寸、材质都相同的产品'));
    assert.deepEqual([sales(base.store).product(mine.id)?.customerId, sales(base.store).order(order.id)?.customerId], [a.id, a.id]);
    assert.deepEqual(productAudits(base, mine.id), []);
    manualWrite(base.store, { entity: 'products', action: 'update', id: twin.id, input: { ...twin, length: 500, confirmDistinct: true } }, editor);
    changeTo(base, order.id, b.id);
    assert.equal(sales(base.store).product(mine.id)?.customerId, b.id);
  } finally {
    base.store.close();
  }
});

test('普通账号给有生产任务的订单换客户照旧被拦、产品不动；本机管理员、数据管理能换，产品跟着走', () => {
  const base = businessBase(localAdmin);
  try {
    const { b, mine, order } = setup(base);
    base.flow.save('task', { date: '2026-11-02', productId: mine.id, quantity: '100', unit: '只', orderIds: [order.id] }, localAdmin);
    assert.throws(() => changeTo(base, order.id, b.id), /订单已关联生产\/送货记录，不能改变客户/);
    assert.equal(sales(base.store).product(mine.id)?.version, mine.version);
    changeTo(base, order.id, b.id, localAdmin);
    assert.equal(sales(base.store).product(mine.id)?.customerId, b.id);
    const back = setup(base);
    const now = sales(base.store).order(back.order.id);
    assert.ok(now);
    new DataManagementService(base.store).execute(
      { module: 'orders', action: 'update', items: [{ id: now.id, version: now.version }], patch: { customerId: back.b.id }, reason: '虚构：选错客户', requestId: randomUUID() },
      localAdmin,
      's1',
    );
    assert.equal(sales(base.store).product(back.mine.id)?.customerId, back.b.id);
  } finally {
    base.store.close();
  }
});

test('编辑窗读“只在这张订单里下过单的产品”：别的订单也用过的不在里面；读得到读不到和读这张订单一样', async () => {
  const base = businessBase(editor);
  const server = await listen(createApp(base.store, { problems: testProblems() }));
  try {
    const { a, mine, generic, order } = setup(base);
    sales(base.store).saveOrder(orderInput(a.id, [{ productId: generic.id }]));
    const read = async (id: number) => {
      const r = await fetch(server.origin + '/api/orders/' + id + '/sole-products');
      return { status: r.status, body: z.unknown().parse(await r.json()) };
    };
    assert.deepEqual(await read(order.id), { status: 200, body: { productIds: [mine.id] } });
    changeLifecycle(base.store, 'orders', { action: 'archive', acknowledged: true, items: [{ id: order.id, version: order.version }] }, editor);
    for (const id of [order.id, 999])
      assert.equal((await read(id)).status, (await fetch(server.origin + '/api/orders/' + id)).status);
    assert.equal((await read(999)).status, 404);
  } finally {
    await server.close();
    base.store.close();
  }
});

test('助手改订单客户的卡片上写出产品一起改归新客户，确认后产品跟着走', () => {
  const f = autoConfirmAssistant();
  const admin = localAdministratorActor(superActor());
  const base = businessBase(admin, f.store);
  try {
    const { b, mine, order } = setup(base);
    const plan = f.manager.tools.prepare('records.propose_save', { module: 'orders', id: order.id, patch: { customerId: b.id } }, admin, 'card');
    const lines = z.array(z.object({ label: z.string(), value: z.string() })).parse(plan.summary).map((l) => l.label + '：' + l.value);
    assert.ok(lines.some((l) => l.includes('甲专用箱') && l.includes('虚构甲 → 虚构乙')), lines.join('\n'));
    assert.equal(sales(f.store).product(mine.id)?.customerId, mine.customerId, '出卡片时只是试，不落库');
    f.manager.tools.commit(plan, admin, 'card');
    assert.equal(sales(f.store).product(mine.id)?.customerId, b.id);
  } finally {
    f.close();
  }
});
