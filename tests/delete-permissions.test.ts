// 删除的权限：待核对的单据有编辑权限就能删，已核对的和档案要超级管理员（服务器上还要再输本人密码）；
// 库存怎么处理；同一请求重试原样返回。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthManager } from '../server/accounts/index.js';
import { localAdministratorActor, count } from '../server/core/index.js';
import { saveDoc } from './receive-fixture.js';
import { startHttp } from './http-fixture.js';
import { setup } from './delete-fixture.js';
import { z } from 'zod';
import { actor, superActor } from './actor-fixture.js';

/** 抛出的错带的状态码、类别和说明（不是带说明的对象就让断言失败） */
const errorOf = (e: unknown) => z.object({ status: z.number().optional(), code: z.string().optional(), message: z.string() }).parse(e);
/** 删除预览回答里的范围摘要 */
const digestOf = async (r: Response) => z.object({ digest: z.string() }).parse(await r.json()).digest;

test('草稿有编辑权限就能删：不用本机管理员，也不用超级管理员模式', () => {
  const f = setup();
  const plan = f.service.preview(f.selection(f.draft), actor);
  assert.equal(plan.hasIndependentImpact, false, '草稿没动库存，没有别的影响');
  f.service.delete({ ...f.selection(f.draft), requestId: randomUUID(), deletionDigest: plan.digest }, actor, 'test-binding');
  assert.equal(f.exists(f.draft.id), false);
});

test('已确认的单据：普通编辑账号删不了，提示没有权限（进不了超级管理员模式，不叫人去系统维护）；超级管理员模式在服务器上也能删', () => {
  const f = setup();
  assert.throws(() => f.service.preview(f.selection(f.live), actor), (thrown: unknown) => {
    const e = errorOf(thrown);
    assert.equal(e.status, 403);
    assert.equal(e.code, 'permission');
    assert.match(e.message, /要用超级管理员账号，当前账号没有这个权限/);
    assert.doesNotMatch(e.message, /系统维护/);
    return true;
  });
  // 混着草稿和已确认的一起删也不行
  assert.throws(
    () =>
      f.service.preview(
        { module: 'arrival', items: [f.draft, f.stocked].map((d) => ({ id: d.id, version: d.version })), inventoryPolicy: 'preserve' },
        actor,
      ),
    /要用超级管理员账号/,
  );
  // 超级管理员账号没进模式：叫他去系统维护进入
  assert.throws(
    () => f.service.preview(f.selection(f.live), { ...superActor(), superAdminMode: false }),
    (thrown: unknown) => {
      const e = errorOf(thrown);
      return e.code === 'super-mode' && /系统维护.*进入超级管理员模式/.test(e.message);
    },
  );
  const admin = superActor();
  const plan = f.service.preview(f.selection(f.live), admin);
  f.service.delete({ ...f.selection(f.live), requestId: randomUUID(), deletionDigest: plan.digest }, admin, 'test-binding');
  assert.equal(f.exists(f.live.id), false);
  assert.equal(count(f.store.db, "SELECT COUNT(*) FROM business_audit WHERE action='delete' AND entity='flow_task'"), 1, '删除留了审计');
});

test('没有编辑权限的账号连草稿也删不了：按实际原因说缺编辑权限，不说成“已核对的单据”', () => {
  const f = setup();
  assert.throws(
    () => f.service.preview(f.selection(f.draft), { ...actor, permissions: [] }),
    (thrown: unknown) => {
      const e = errorOf(thrown);
      return e.code === 'permission' && e.message === '删除还没核对的单据要有业务编辑权限，当前账号没有这个权限。';
    },
  );
});

test('服务器上从域名访问：草稿直接删；已确认的单据和档案要超级管理员模式并再输本人密码', async () => {
  const password = 'Fictional-delete-rule-pass-123',
    f = setup(),
    h = await startHttp(f.store, {
      auth: new AuthManager(':memory:', Date.now, { localAdministration: false }),
      admin: { name: '虚构服务器管理员', password },
    });
  try {
    const post = (path: string, body: unknown) => h.post(path, body);
    // 草稿：不用超级管理员模式，也不用密码
    let r = await post('/deletions/preview', f.selection(f.draft));
    assert.equal(r.status, 200);
    let digest = await digestOf(r);
    r = await post('/deletions/execute', { ...f.selection(f.draft), requestId: randomUUID(), deletionDigest: digest });
    assert.equal(r.status, 200);
    assert.equal(f.exists(f.draft.id), false);
    // 已确认：没进超级管理员模式先拒绝
    r = await post('/deletions/preview', f.selection(f.live));
    assert.equal(r.status, 403);
    r = await post('/auth/super-admin/enter', { password });
    assert.equal(r.status, 200);
    r = await post('/deletions/preview', f.selection(f.live));
    assert.equal(r.status, 200);
    digest = await digestOf(r);
    // 进了超级管理员模式，提交时还要再输一次密码
    r = await post('/deletions/execute', { ...f.selection(f.live), requestId: randomUUID(), deletionDigest: digest });
    assert.equal(r.status, 400);
    assert.equal(f.exists(f.live.id), true);
    r = await post('/deletions/execute', { ...f.selection(f.live), requestId: randomUUID(), deletionDigest: digest, password: 'wrong-password-123' });
    assert.notEqual(r.status, 200);
    assert.equal(f.exists(f.live.id), true);
    r = await post('/deletions/execute', { ...f.selection(f.live), requestId: randomUUID(), deletionDigest: digest, password });
    assert.equal(r.status, 200);
    assert.equal(f.exists(f.live.id), false);
    // 客户、产品等档案和本机一样能删（用户 2026-11-09 定放开），同样要密码
    const product = sales(f.store).products()[0];
    const selection = { module: 'products', items: [{ id: product.id, version: product.version }], inventoryPolicy: 'preserve' };
    r = await post('/deletions/preview', selection);
    assert.equal(r.status, 200);
    digest = await digestOf(r);
    r = await post('/deletions/execute', { ...selection, requestId: randomUUID(), deletionDigest: digest });
    assert.equal(r.status, 400, '没输密码不删');
    assert.ok(sales(f.store).products(true).some((p) => p.id === product.id));
    r = await post('/deletions/execute', { ...selection, requestId: randomUUID(), deletionDigest: digest, password });
    assert.equal(r.status, 200);
    assert.ok(!sales(f.store).products(true).some((p) => p.id === product.id));
    // 退出超级管理员模式后，档案又删不了
    await post('/auth/super-admin/exit', {});
    const other = f.base.product({ name: '虚构另一种纸箱' });
    r = await post('/deletions/preview', { module: 'products', items: [{ id: other.id, version: other.version }] });
    assert.equal(r.status, 403);
  } finally {
    await h.close();
  }
});

test('删除的库存处理：没动过库存的单据不用选；动过库存的默认库存一起改回，也能选库存数量不动', async () => {
  const owner = localAdministratorActor({ ...actor, role: 'super_admin' });
  const f = setup();
  // 已下达、没开工的生产任务没有出入库流水：不用选库存怎么处理
  const taskPlan = f.service.preview({ module: 'task', items: [{ id: f.live.id, version: f.live.version }] }, owner);
  assert.equal(taskPlan.inventoryChoice, 0);
  assert.match(taskPlan.inventoryEffect, /没有动过库存/);
  // 一张已出库的送货单：入库 1000，送出 300
  const { ops } = f.base;
  const product = sales(f.store).products()[0];
  const item = f.base.finished(product, { name: '虚构纸箱' }, { quantity: '1000', date: '2026-11-09' });
  const ship = () =>
    f.base.check(
      saveDoc(f.flow, 'delivery', { date: '2026-11-10', plannedDate: '2026-11-10', customerId: customer.id, address: '', contact: '', phone: '', lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: item.id, quantity: '300', notes: '' }], notes: '' }, actor),
    );
  const customer = f.base.customer({ name: '虚构客户' });
  const order = f.base.order(customer, [f.base.line(product, 1000, { productName: product.name, notes: '' })], {
    orderDate: '2026-11-09',
    deliveryDate: '2026-11-20',
    notes: '',
    costs: null,
  });
  const balance = () => ops.balance(item.id);
  const remove = (doc: { id: number; version: number }, inventoryPolicy?: 'preserve' | 'recalculate') => {
    const selection = { module: 'delivery', items: [{ id: doc.id, version: doc.version }], ...(inventoryPolicy ? { inventoryPolicy } : {}) };
    const plan = f.service.preview(selection, owner);
    assert.equal(plan.inventoryChoice, 1, '这张送货单有一笔出库流水要处理');
    f.service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test');
  };
  const a = ship();
  assert.equal(balance(), 700_000);
  remove(a);
  assert.equal(balance(), 1000_000, '默认：库存一起改回，当这张单子没发生过');
  const b = ship();
  assert.equal(balance(), 700_000);
  remove(b, 'preserve');
  assert.equal(balance(), 700_000, '选“库存数量不动”：只删单子');
});

test('同一删除请求重试原样返回上次结果：不按删完后的库重新判断权限；别的会话用同一请求编号不行，别人用同一编号各办各的', async () => {
  const f = setup();
  const selection = f.selection(f.draft),
    plan = f.service.preview(selection, actor),
    body = { ...selection, requestId: randomUUID(), deletionDigest: plan.digest };
  // 上次的结果存成 JSON，重放拿到的是同一份 JSON
  const first: unknown = JSON.parse(JSON.stringify(f.service.delete(body, actor, 'test-binding')));
  assert.equal(f.exists(f.draft.id), false);
  // 删完后这张还没核对的单据已经不在库里，以前按现在的库判断成“删已确认单据”，同一个人重试报 403
  assert.deepEqual(f.service.replay(body, actor, 'test-binding'), first);
  assert.deepEqual(f.service.delete(body, actor, 'test-binding'), first);
  assert.equal(f.service.replay({ ...body, requestId: randomUUID() }, actor, 'test-binding'), null, '没删过的照常走权限判断');
  // 请求编号按账号分开：别人拿同一个编号删另一张单据，是另一个请求，照常删；自己的重发还是自己那次的结果
  const other = { ...actor, id: 'fictional-other-user' },
    another = f.arrival('虚构送货单-另一张待核对'),
    otherBody = { ...f.selection(another), requestId: body.requestId, deletionDigest: f.service.preview(f.selection(another), other).digest };
  assert.equal(f.service.delete(otherBody, other, 'test-binding').deleted, true);
  assert.equal(f.exists(another.id), false);
  assert.deepEqual(f.service.replay(body, actor, 'test-binding'), first);
  assert.throws(() => f.service.delete(body, actor, 'other-binding'), (e: unknown) => errorOf(e).status === 409);
  assert.throws(() => f.service.delete(body, null, 'test-binding'), (e: unknown) => errorOf(e).status === 401);

  // 走 HTTP（服务器上从域名访问）：同一个人重试 /deletions/execute 拿到同一结果
  const password = 'Fictional-delete-replay-pass-123',
    g = setup(),
    h = await startHttp(g.store, {
      auth: new AuthManager(':memory:', Date.now, { localAdministration: false }),
      admin: { name: '虚构服务器管理员', password },
    });
  try {
    const post = (path: string, data: unknown) => h.post(path, data);
    let r = await post('/deletions/preview', g.selection(g.draft));
    const draftBody = { ...g.selection(g.draft), requestId: randomUUID(), deletionDigest: await digestOf(r) };
    r = await post('/deletions/execute', draftBody);
    assert.equal(r.status, 200);
    const once: unknown = await r.json();
    r = await post('/deletions/execute', draftBody);
    assert.equal(r.status, 200, '重试不再报 403');
    assert.deepEqual(await r.json(), once);
    // 已确认的单据：第一次要超级管理员模式和本人密码；同一请求重试（比如没收到回应）原样返回
    await post('/auth/super-admin/enter', { password });
    r = await post('/deletions/preview', g.selection(g.live));
    const liveBody = { ...g.selection(g.live), requestId: randomUUID(), deletionDigest: await digestOf(r) };
    r = await post('/deletions/execute', { ...liveBody, password });
    assert.equal(r.status, 200);
    const done: unknown = await r.json();
    await post('/auth/super-admin/exit', {});
    r = await post('/deletions/execute', { ...liveBody, password });
    assert.equal(r.status, 200, '退出超级管理员模式后重试同一请求也拿到原来的结果，不会再删别的');
    assert.deepEqual(await r.json(), done);
    assert.equal(g.exists(g.live.id), false);
  } finally {
    await h.close();
  }
});
