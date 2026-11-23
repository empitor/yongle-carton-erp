// 产品属于客户（第 5 阶段批 F）的 7 条业务规则与回归测试：可选归属、下单跨客户拦截、按客户查重、
// 已下单产品改客户限制与归档客户拦截、成品库存带客户名、删客户置空并留产品修改历史、系统体检与识别导入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sales } from '../server/sales/index.js';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/index.js';
import { DatabaseMaintenanceService, changeLifecycle } from '../server/lifecycle/index.js';
import { ManagedRecords } from '../server/admin/managed-records.js';
import { DataManagementService } from '../server/admin/index.js';
import { auditTrail } from '../server/overview/index.js';
import { createApp } from '../server/app.js';
import { systemCheck } from '../server/assistant/tools/system.js';
import { customerSchema, nameWithCustomer, orderSchema, productSchema } from '../shared/core/index.js';
import { emptyImportMapping, type ImportWorkspaceView } from '../shared/import/index.js';
import { deletionImpactView } from '../src/recordkit/deletion-impact.js';
import { lockedReason } from '../src/admin/field-rules.js';
import { pageActor, actor as baseActor, grant, superActor } from './actor-fixture.js';
import { businessBase, manualWrite } from './business-base-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { listen, testProblems } from './http-fixture.js';
import { autoConfirmAssistant, systemDeps, toolsOf } from './assistant-fixture.js';
import { readAs } from './read-result.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';

const editor = pageActor({ id: 'u1', name: '虚构业务员', permissions: ['business:edit'] });
const localAdmin = localAdministratorActor({ ...baseActor, role: 'super_admin' });
const importActor = { ...baseActor, permissions: grant('business:edit', 'import:execute') };

const simpleOrder = (customerId: number, lines: { id?: number; productId: number }[], notes = '') =>
  orderSchema.parse({
    customerId,
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-10',
    status: '已确认',
    notes,
    lines: lines.map((l) => ({ ...l, quantity: 100, unitPriceCents: 200, unit: '只' })),
  });

function mustDraft(w: ImportWorkspaceView) {
  assert.ok(w.draft, '工作区已有识别草稿');
  return w.draft;
}

test('规则 1、3：没定客户的产品各家都能下单；选别家客户产品下单拦下，老订单未动明细不拦', () => {
  const base = businessBase(editor);
  const { store } = base;
  try {
    const a = base.customer({ name: '虚构甲公司' });
    const b = base.customer({ name: '虚构乙公司' });
    const pA = base.product({ name: '甲专用箱', customerId: a.id });
    const pB = base.product({ name: '乙专用箱', customerId: b.id });
    const generic = base.product({ name: '通用周转箱' });
    assert.equal(pA.customerId, a.id);
    assert.equal(pA.customerName, '虚构甲公司');
    assert.equal(generic.customerId, undefined);
    assert.ok(sales(store).saveOrder(simpleOrder(a.id, [{ productId: pA.id }])));
    assert.ok(sales(store).saveOrder(simpleOrder(a.id, [{ productId: generic.id }])));
    assert.ok(sales(store).saveOrder(simpleOrder(b.id, [{ productId: generic.id }])));
    assert.throws(() => sales(store).saveOrder(simpleOrder(b.id, [{ productId: pA.id }])), /这个产品是 虚构甲公司 的，要给 虚构乙公司 用请复制一份/);
    // 老订单先用未定客户产品，后来该产品定给甲客户：不动明细只改备注放行
    const legacy = base.product({ name: '历史未定箱' });
    const oldOrder = sales(store).saveOrder(simpleOrder(b.id, [{ productId: legacy.id }]));
    sales(store).updateProduct(productSchema.parse({ ...legacy, customerId: a.id }), legacy.id, legacy.version);
    const edited = sales(store).saveOrder(simpleOrder(b.id, [{ id: oldOrder.lines[0].id, productId: legacy.id }], '补充备注'), oldOrder.id, oldOrder.version);
    assert.equal(edited.notes, '补充备注');
    // 老订单新加甲产品行：拦下
    assert.throws(
      () => sales(store).saveOrder(simpleOrder(b.id, [{ id: edited.lines[0].id, productId: legacy.id }, { productId: pA.id }]), edited.id, edited.version),
      /这个产品是 虚构甲公司 的，要给 虚构乙公司 用请复制一份/,
    );
    // 换给乙自己产品允许；之后换客户保留乙产品、或把既有行直接换成甲产品均被拒
    const switched = sales(store).saveOrder(simpleOrder(b.id, [{ id: edited.lines[0].id, productId: pB.id }]), edited.id, edited.version);
    assert.throws(
      () => sales(store).saveOrder(simpleOrder(a.id, [{ id: switched.lines[0].id, productId: pB.id }]), switched.id, switched.version),
      /这个产品是 虚构乙公司 的，要给 虚构甲公司 用请复制一份/,
    );
    assert.throws(
      () => sales(store).saveOrder(simpleOrder(b.id, [{ id: switched.lines[0].id, productId: pA.id }]), switched.id, switched.version),
      /这个产品是 虚构甲公司 的，要给 虚构乙公司 用请复制一份/,
    );
  } finally {
    store.close();
  }
});

test('规则 6：没下过单的产品随时可改客户；下过单的只能从未定客户补定，不能从 A 改给 B 或清空', () => {
  const base = businessBase(editor);
  const { store } = base;
  try {
    const a = base.customer({ name: '虚构甲客户' });
    const b = base.customer({ name: '虚构乙客户' });
    const free = base.product({ name: '未下单箱', customerId: a.id });
    const moved = sales(store).updateProduct(productSchema.parse({ ...free, customerId: b.id }), free.id, free.version);
    assert.equal(moved.customerId, b.id);
    const cleared = sales(store).updateProduct(productSchema.parse({ ...moved, customerId: null }), moved.id, moved.version);
    assert.equal(cleared.customerId, undefined);
    const ordered = base.product({ name: '已下单箱' });
    sales(store).saveOrder(simpleOrder(a.id, [{ productId: ordered.id }]));
    const assigned = sales(store).updateProduct(productSchema.parse({ ...ordered, customerId: a.id }), ordered.id, ordered.version);
    assert.equal(assigned.customerId, a.id);
    assert.throws(() => sales(store).updateProduct(productSchema.parse({ ...assigned, customerId: b.id }), assigned.id, assigned.version), /已经下过单，不能更改所属客户/);
    assert.throws(() => sales(store).updateProduct(productSchema.parse({ ...assigned, customerId: null }), assigned.id, assigned.version), /已经下过单，不能更改所属客户/);
    const renamed = sales(store).updateProduct(productSchema.parse({ ...assigned, requirements: '加防水膜' }), assigned.id, assigned.version);
    assert.equal(renamed.requirements, '加防水膜');
    const row = new ManagedRecords(store, new FlowService(store)).list('products').find((r) => r.record.id === renamed.id);
    assert.equal(row?.record.ordered, true);
    assert.ok(lockedReason('customerId', {}, '', { module: 'products', record: row?.record ?? null, refs: null })?.includes('已经下过单'));
  } finally {
    store.close();
  }
});

test('规则 2、5、7：成品库存带客户名；删客户置空产品并标“变成没定客户”，归档不连带；体检列未定客户产品', async () => {
  const base = businessBase(editor);
  const { store } = base;
  const server = await listen(createApp(store, { problems: testProblems() }));
  try {
    const a = base.customer({ name: '虚构东海包装' });
    const b = base.customer({ name: '虚构明远食品' });
    const owned = base.product({ name: '标准纸箱', customerId: a.id });
    const multi = base.product({ name: '公用外箱' });
    const fin = base.finished(owned, { name: owned.name });
    const raw = base.raw({ name: 'BC五层纸板' });
    const items = new OperationsService(store).items();
    assert.equal(items.find((i) => i.id === fin.id)?.customerId, a.id);
    assert.equal(items.find((i) => i.id === fin.id)?.customerName, '虚构东海包装');
    assert.equal(items.find((i) => i.id === raw.id)?.customerName, undefined);
    for (const c of [a, b]) sales(store).saveOrder(simpleOrder(c.id, [{ productId: multi.id }]));
    const detail = readAs(await (await fetch(server.origin + '/api/products/' + multi.id)).json(), {
      ordered: z.boolean(),
      orderedCustomers: z.array(z.string()),
    });
    assert.equal(detail.ordered, true);
    assert.deepEqual(detail.orderedCustomers, ['虚构东海包装', '虚构明远食品']);
    const check = systemCheck(systemDeps(store, []));
    assert.equal(check.healthy, true);
    assert.equal(check.unassignedProducts.total, 1);
    assert.deepEqual(check.unassignedProducts.items[0].orderedCustomers, ['虚构东海包装', '虚构明远食品']);
    const archCust = base.customer({ name: '虚构待归档客户' });
    const archProd = base.product({ name: '待归档客户产品', customerId: archCust.id });
    changeLifecycle(store, 'customers', { action: 'archive', acknowledged: true, items: [{ id: archCust.id, version: archCust.version }] }, editor);
    assert.equal(store.archived('customers', archCust.id), true);
    assert.equal(store.archived('products', archProd.id), false);
    const delCust = base.customer({ name: '虚构待删客户' });
    const delProd = base.product({ name: '待删客户产品', customerId: delCust.id });
    const maint = new DatabaseMaintenanceService(store);
    const preview = maint.preview({ module: 'customers', items: [{ id: delCust.id, version: delCust.version }] }, localAdmin);
    assert.ok(deletionImpactView(preview).kept.some((k) => k.name === '待删客户产品' && k.note.includes('变成没定客户')));
    maint.delete({ module: 'customers', items: [{ id: delCust.id, version: delCust.version }], deletionDigest: preview.digest, requestId: randomUUID() }, localAdmin, 'test-session');
    const afterProd = sales(store).product(delProd.id);
    assert.equal(afterProd?.customerId, undefined);
    assert.equal(afterProd?.version, delProd.version + 1);
  } finally {
    await server.close();
    store.close();
  }
});

test('回归⑥：永久删客户（含产品曾下过单场景）时产品保留、归属置空、版本加一且留有产品修改历史审计', () => {
  const base = businessBase(localAdmin);
  const { store } = base;
  try {
    const cust = base.customer({ name: '虚构有单待删客户' });
    const prod = base.product({ name: '有单待删客户箱', customerId: cust.id });
    sales(store).saveOrder(simpleOrder(cust.id, [{ productId: prod.id }]));
    const maint = new DatabaseMaintenanceService(store);
    const preview = maint.preview({ module: 'customers', items: [{ id: cust.id, version: cust.version }] }, localAdmin);
    const requestId = randomUUID();
    maint.delete({ module: 'customers', items: [{ id: cust.id, version: cust.version }], deletionDigest: preview.digest, requestId }, localAdmin, 'del-session');
    const afterProd = sales(store).product(prod.id);
    assert.ok(afterProd);
    assert.equal(afterProd.customerId, undefined);
    assert.equal(afterProd.version, prod.version + 1);
    const trail = auditTrail(store, { from: '2000-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z' }, { limit: 50, offset: 0 });
    const entry = trail.history.find((h) => h.entity === 'products' && h.recordId === prod.id && h.action === 'update');
    assert.ok(entry, '产品留下修改历史审计');
    const detail = z
      .object({
        before: z.looseObject({ customerId: z.number(), customerName: z.string() }),
        after: z.looseObject({ version: z.number() }),
        trigger: z.object({ action: z.literal('delete'), entity: z.literal('customers'), id: z.number(), name: z.string() }),
        requestId: z.string(),
      })
      .parse(entry.detail);
    assert.equal(detail.before.customerId, cust.id);
    assert.equal(detail.before.customerName, '虚构有单待删客户');
    assert.equal(detail.after.customerId, undefined);
    assert.equal(detail.trigger.id, cust.id);
    assert.equal(detail.requestId, requestId);
  } finally {
    store.close();
  }
});

test('回归③：超管、数据管理单条/批量与助手均拒绝新指派归档客户，沿用原归档归属放行', () => {
  const f = autoConfirmAssistant();
  const { store } = f;
  const admin = localAdministratorActor(superActor());
  const base = businessBase(admin, store);
  const dm = new DataManagementService(store);
  try {
    const a = base.customer({ name: '虚构在用甲' });
    const archivedCust = base.customer({ name: '虚构归档丙' });
    const owned = base.product({ name: '原属归档箱', customerId: archivedCust.id });
    changeLifecycle(store, 'customers', { action: 'archive', acknowledged: true, items: [{ id: archivedCust.id, version: archivedCust.version }] }, admin);
    const kept = manualWrite(store, { entity: 'products', action: 'update', id: owned.id, input: { ...owned, requirements: '加防水' } }, admin);
    assert.equal(kept.customerId, archivedCust.id);
    const free = base.product({ name: '未下单自由箱', customerId: a.id });
    const free2 = base.product({ name: '未下单自由箱2' });
    assert.throws(() => manualWrite(store, { entity: 'products', action: 'update', id: free.id, input: { ...free, customerId: archivedCust.id } }, admin), /客户不存在或已归档/);
    assert.throws(() => dm.execute({ module: 'products', action: 'update', items: [{ id: free.id, version: free.version }], patch: { customerId: archivedCust.id }, reason: '单条', requestId: randomUUID() }, admin, 's1'), /客户不存在或已归档/);
    assert.throws(
      () => dm.execute({ module: 'products', action: 'update', items: [{ id: free.id, version: free.version }, { id: free2.id, version: free2.version }], patch: { customerId: archivedCust.id }, reason: '批量', requestId: randomUUID() }, admin, 's1'),
      /客户不存在或已归档/,
    );
    assert.throws(() => f.manager.tools.prepare('records.propose_save', { module: 'products', id: free.id, patch: { customerId: archivedCust.id } }, admin, 'card'), /客户不存在或已归档/);
    // 卡片准备时客户仍有效，确认执行前客户被归档：确认执行时必须重新拦截
    const activeLaterArchived = base.customer({ name: '虚构出卡后归档' });
    const delayedPlan = f.manager.tools.prepare('records.propose_save', { module: 'products', id: free.id, patch: { customerId: activeLaterArchived.id } }, admin, 'card');
    changeLifecycle(store, 'customers', { action: 'archive', acknowledged: true, items: [{ id: activeLaterArchived.id, version: activeLaterArchived.version }] }, admin);
    assert.throws(() => f.manager.tools.commit(delayedPlan, admin, 'card'), /客户不存在或已归档/);
    const found = readAs(toolsOf(store).read('records.search', { module: 'products', filters: { unassigned: true } }, admin), {
      results: z.array(z.object({ record: z.looseObject({ id: z.number() }) })),
    });
    assert.deepEqual(found.results.map((r) => r.record.id), [free2.id]);
  } finally {
    f.close();
  }
});

test('回归③：数据管理单条/批量与助手写入拒绝修改已锁定产品归属，且产品修改卡片标题带客户名', () => {
  const f = autoConfirmAssistant();
  const { store } = f;
  const admin = localAdministratorActor(superActor());
  const base = businessBase(admin, store);
  const dm = new DataManagementService(store);
  try {
    const a = base.customer({ name: '虚构锁定甲' });
    const b = base.customer({ name: '虚构锁定乙' });
    const free = base.product({ name: '未下单伴随箱', customerId: a.id });
    const locked = base.product({ name: '已下单锁箱', customerId: a.id });
    sales(store).saveOrder(simpleOrder(a.id, [{ productId: locked.id }]));
    for (const nextCustomerId of [b.id, null]) {
      assert.throws(() => dm.execute({ module: 'products', action: 'update', items: [{ id: locked.id, version: locked.version }], patch: { customerId: nextCustomerId }, reason: '单条', requestId: randomUUID() }, admin, 's1'), /已经下过单，不能更改所属客户/);
      assert.throws(
        () => dm.execute({ module: 'products', action: 'update', items: [{ id: locked.id, version: locked.version }, { id: free.id, version: free.version }], patch: { customerId: nextCustomerId }, reason: '批量', requestId: randomUUID() }, admin, 's1'),
        /已经下过单，不能更改所属客户/,
      );
      assert.throws(() => f.manager.tools.prepare('records.propose_save', { module: 'products', id: locked.id, patch: { customerId: nextCustomerId } }, admin, 'card'), /已经下过单，不能更改所属客户/);
    }
    const plan = f.manager.tools.prepare('records.propose_save', { module: 'products', id: locked.id, patch: { requirements: '加印字' } }, admin, 'card');
    assert.equal(plan.label, '修改产品：产品 ' + nameWithCustomer('已下单锁箱', '虚构锁定甲'));
    // 卡片准备时未下单，确认执行前被下了单：确认执行时必须拦截修改所属客户
    const delayedLockPlan = f.manager.tools.prepare('records.propose_save', { module: 'products', id: free.id, patch: { customerId: b.id } }, admin, 'card');
    sales(store).saveOrder(simpleOrder(a.id, [{ productId: free.id }]));
    assert.throws(() => f.manager.tools.commit(delayedLockPlan, admin, 'card'), /已经下过单，不能更改所属客户/);
  } finally {
    f.close();
  }
});

test('回归④：产品编辑改归属或查重字段撞重被拒；超 50 条同名不漏硬冲突；数据管理与助手支持同名不同规格确认', () => {
  const f = autoConfirmAssistant();
  const { store } = f;
  const admin = localAdministratorActor(superActor());
  const base = businessBase(admin, store);
  const dm = new DataManagementService(store);
  try {
    const a = base.customer({ name: '虚构查重甲' });
    const b = base.customer({ name: '虚构查重乙' });
    const spec = { name: '标准箱', length: 300, width: 200, height: 150, dimensionUnit: 'mm' as const, material: 'K=A', flute: 'B', customerProductCode: 'CODE-1' };
    const pA = manualWrite(store, { entity: 'products', action: 'create', input: { ...spec, customerId: a.id } }, editor);
    const pB = manualWrite(store, { entity: 'products', action: 'create', input: { ...spec, customerId: b.id } }, editor);
    assert.throws(() => manualWrite(store, { entity: 'products', action: 'update', id: pB.id, input: { ...pB, customerId: a.id } }, editor), /客户料号“CODE-1”已经用在/);
    const pA2 = manualWrite(store, { entity: 'products', action: 'create', input: { name: '另一款箱', length: 400, width: 300, height: 200, dimensionUnit: 'mm', material: 'K=A', flute: 'B', customerId: a.id } }, editor);
    assert.throws(() => manualWrite(store, { entity: 'products', action: 'update', id: pA2.id, input: { ...pA2, customerProductCode: 'CODE-1' } }, editor), /客户料号“CODE-1”已经用在/);
    assert.throws(() => manualWrite(store, { entity: 'products', action: 'update', id: pA2.id, input: { ...pA2, name: '标准箱', length: 300, width: 200, height: 150 } }, editor), /已有尺寸、材质都相同的产品/);
    assert.equal(manualWrite(store, { entity: 'products', action: 'update', id: pA.id, input: { ...pA, requirements: '加防水' } }, editor).requirements, '加防水');

    // 同名不同规格编辑：数据管理与助手不带 confirmDistinct 拦，带 confirmDistinct 放行；硬冲突带 confirmDistinct 仍拒
    assert.throws(() => dm.execute({ module: 'products', action: 'update', items: [{ id: pA2.id, version: pA2.version }], patch: { name: '标准箱' }, reason: '改名', requestId: randomUUID() }, admin, 's1'), /已有同名产品/);
    const dmUpdated = dm.execute({ module: 'products', action: 'update', items: [{ id: pA2.id, version: pA2.version }], patch: { name: '标准箱' }, confirmDistinct: true, reason: '确认不同规格', requestId: randomUUID() }, admin, 's1');
    assert.equal(dmUpdated.count, 1);
    const pA2After = sales(store).product(pA2.id);
    assert.ok(pA2After);
    assert.throws(
      () => dm.execute({ module: 'products', action: 'update', items: [{ id: pA2After.id, version: pA2After.version }], patch: { customerProductCode: 'CODE-1' }, confirmDistinct: true, reason: '硬冲突', requestId: randomUUID() }, admin, 's1'),
      /客户料号“CODE-1”已经用在/,
    );
    const pA3 = manualWrite(store, { entity: 'products', action: 'create', input: { name: '第三款箱', length: 500, width: 400, height: 300, dimensionUnit: 'mm', material: 'K=A', flute: 'B', customerId: a.id } }, editor);
    assert.throws(() => f.manager.tools.prepare('records.propose_save', { module: 'products', id: pA3.id, patch: { name: '标准箱' } }, admin, 'card'), /已有同名产品/);
    const distinctPlan = f.manager.tools.prepare('records.propose_save', { module: 'products', id: pA3.id, patch: { name: '标准箱' }, confirmDistinct: true }, admin, 'card');
    f.manager.tools.commit(distinctPlan, admin, 'card');
    assert.equal(sales(store).product(pA3.id)?.name, '标准箱');
    assert.throws(() => f.manager.tools.prepare('records.propose_save', { module: 'products', id: pA3.id, patch: { customerProductCode: 'CODE-1' }, confirmDistinct: true }, admin, 'card'), /客户料号“CODE-1”已经用在/);

    // 超过 50 条排在前面的同名产品时，第 51 条占用的料号不能漏查
    const big = base.customer({ name: '虚构多品客户' });
    for (let i = 1; i <= 50; i++)
      sales(store).createProduct(productSchema.parse({ name: '海量同名箱', length: 100 + i, width: 100, height: 100, dimensionUnit: 'mm', material: 'K=A', customerId: big.id }));
    sales(store).createProduct(productSchema.parse({ name: '海量同名箱', length: 999, width: 100, height: 100, dimensionUnit: 'mm', material: 'K=A', customerProductCode: 'TAIL-51', customerId: big.id }));
    assert.throws(
      () => manualWrite(store, { entity: 'products', action: 'create', input: { name: '海量同名箱', length: 888, width: 100, height: 100, dimensionUnit: 'mm', material: 'K=A', customerProductCode: 'TAIL-51', customerId: big.id, confirmDistinct: true } }, editor),
      /客户料号“TAIL-51”已经用在/,
    );
    const mover = sales(store).createProduct(productSchema.parse({ name: '待迁入产品', customerProductCode: 'TAIL-51', customerId: b.id }));
    assert.throws(
      () => manualWrite(store, { entity: 'products', action: 'update', id: mover.id, input: { ...mover, name: '海量同名箱', customerId: big.id, confirmDistinct: true } }, editor),
      /客户料号“TAIL-51”已经用在/,
    );
  } finally {
    f.close();
  }
});

test('识别导入新建客户和产品：不用假编号占位、同事务归属新客户；同单新建撞重被拒、预览后改归属确认失败', async () => {
  const f = createOrderWorkflowFixture();
  const base = businessBase(editor, f.store);
  try {
    // 1. 新客户 + 新产品同事务写入
    const w = (await f.imports.upload(imageFixture(), '虚构新客订单.png')).workspace;
    let analyzed = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, importActor);
    analyzed = f.imports.edit(analyzed.id, { expectedRevision: analyzed.revision, operations: [{ op: 'set-header', field: 'buyerName', value: '虚构全新客户有限公司', reason: '测试' }] }, 'manual', importActor);
    const preview = await f.execution.preview(analyzed.id, { expectedRevision: analyzed.revision }, importActor);
    assert.equal(preview.plan.order.customerId, null);
    assert.ok(preview.plan.order.lines.every((l) => l.productId === null));
    const receipt = await f.execution.execute(analyzed.id, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true }, importActor);
    const order = sales(f.store).order(receipt.orderId);
    assert.ok(order);
    const createdProducts = receipt.created.filter((c) => c.entity === 'products');
    for (const c of createdProducts) assert.equal(sales(f.store).product(c.id)?.customerId, order.customerId);
    // 不同客户允许同名同规格
    const other = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构另家客户' }));
    const first = sales(f.store).product(createdProducts[0].id);
    assert.ok(first);
    assert.equal(manualWrite(f.store, { entity: 'products', action: 'create', input: { ...first, customerId: other.id } }, editor).customerId, other.id);

    // 2. 同单导入两行新建不同产品却同料号：拦下（用不同文件字节，避免触发“同一原件已导入”）
    const wDup = (await f.imports.upload(imageFixture(true), '同单撞料号.jpg')).workspace;
    let aDup = await f.imports.analyze(wDup.id, { expectedRevision: wDup.revision }, undefined, importActor);
    const dupDraft = mustDraft(aDup);
    aDup = f.imports.edit(
      aDup.id,
      {
        expectedRevision: aDup.revision,
        operations: [
          { op: 'set-header', field: 'buyerName', value: '宁波虚构大洋食品厂', reason: '测试' },
          { op: 'set-line', lineId: dupDraft.lines[0].id, field: 'productCode', value: 'DUP-88', reason: '测试' },
          { op: 'set-line', lineId: dupDraft.lines[1].id, field: 'productCode', value: 'DUP-88', reason: '测试' },
        ],
      },
      'manual',
      importActor,
    );
    await assert.rejects(f.execution.preview(aDup.id, { expectedRevision: aDup.revision }, importActor), /客户料号“DUP-88”相同，不能同时新建两个产品/);

    // 3. 预览后产品被改归属给别家客户：正式导入确认失败
    const cA = base.customer({ name: '虚构预览甲' });
    const cB = base.customer({ name: '虚构预览乙' });
    const shared = base.product({ name: '预览时通用箱', length: 300, width: 200, height: 150, dimensionUnit: 'mm' });
    const w2 = (await f.imports.upload(Buffer.concat([imageFixture(), Buffer.from('preview-reassigned')]), '预览后改归属.png')).workspace;
    let a2 = await f.imports.analyze(w2.id, { expectedRevision: w2.revision }, undefined, importActor);
    const d2 = mustDraft(a2);
    const map = emptyImportMapping(d2);
    map.customer = { mode: 'existing', id: cA.id, version: cA.version };
    map.products[d2.lines[0].id] = { mode: 'existing', id: shared.id, version: shared.version };
    map.products[d2.lines[1].id] = { mode: 'new' };
    a2 = f.imports.mapping(a2.id, { expectedRevision: a2.revision, mapping: map }, importActor);
    const p2 = await f.execution.preview(a2.id, { expectedRevision: a2.revision }, importActor);
    sales(f.store).updateProduct(productSchema.parse({ ...shared, customerId: cB.id }), shared.id, shared.version);
    await assert.rejects(
      f.execution.execute(a2.id, { expectedRevision: p2.plan.source.revision, previewDigest: p2.previewDigest, acknowledged: true }, importActor),
      /产品已变化|请重新预览|这个产品是/,
    );
  } finally {
    f.close();
  }
});

test('同单导入新建产品：同名同尺寸材质冲突拦下，完全相同定义只建一条并由两行共用', async () => {
  const f = createOrderWorkflowFixture();
  const lineOps = (lineId: string, req: string) => [
    { op: 'set-line' as const, lineId, field: 'productName' as const, value: '同单撞规格箱', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'length' as const, value: '300', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'width' as const, value: '200', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'height' as const, value: '150', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'dimensionUnit' as const, value: 'mm', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'material' as const, value: 'K=A', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'flute' as const, value: 'B', reason: '测试' },
    { op: 'set-line' as const, lineId, field: 'requirements' as const, value: req, reason: '测试' },
  ];
  try {
    const wSm = (await f.imports.upload(Buffer.concat([imageFixture(), Buffer.from('same-size-mat')]), '同单同名同尺寸.png')).workspace;
    let aSm = await f.imports.analyze(wSm.id, { expectedRevision: wSm.revision }, undefined, importActor);
    const smDraft = mustDraft(aSm);
    aSm = f.imports.edit(
      aSm.id,
      {
        expectedRevision: aSm.revision,
        operations: [
          { op: 'set-header', field: 'buyerName', value: '宁波虚构同规客户', reason: '测试' },
          ...lineOps(smDraft.lines[0].id, '贴绿标'),
          ...lineOps(smDraft.lines[1].id, '贴红标'),
        ],
      },
      'manual',
      importActor,
    );
    await assert.rejects(f.execution.preview(aSm.id, { expectedRevision: aSm.revision }, importActor), /尺寸、材质相同，不能同时新建两个产品/);

    const wSame = (await f.imports.upload(Buffer.concat([imageFixture(), Buffer.from('identical-new')]), '同单完全相同.png')).workspace;
    let aSame = await f.imports.analyze(wSame.id, { expectedRevision: wSame.revision }, undefined, importActor);
    const sameDraft = mustDraft(aSame);
    aSame = f.imports.edit(
      aSame.id,
      {
        expectedRevision: aSame.revision,
        operations: [
          { op: 'set-header', field: 'buyerName', value: '宁波虚构复用新客', reason: '测试' },
          ...lineOps(sameDraft.lines[0].id, '同款无差异'),
          ...lineOps(sameDraft.lines[1].id, '同款无差异'),
        ],
      },
      'manual',
      importActor,
    );
    const samePreview = await f.execution.preview(aSame.id, { expectedRevision: aSame.revision }, importActor);
    const sameReceipt = await f.execution.execute(aSame.id, { expectedRevision: samePreview.plan.source.revision, previewDigest: samePreview.previewDigest, acknowledged: true }, importActor);
    const sameCreatedProducts = sameReceipt.created.filter((c) => c.entity === 'products');
    assert.equal(sameCreatedProducts.length, 1, '两行完全相同的新建产品只建一条');
    const sameOrder = sales(f.store).order(sameReceipt.orderId);
    assert.ok(sameOrder);
    assert.equal(sameOrder.lines[0].productId, sameCreatedProducts[0].id);
    assert.equal(sameOrder.lines[1].productId, sameCreatedProducts[0].id);
  } finally {
    f.close();
  }
});
