// 订货单的服务（server/operations/batches.ts）：合并导出建批次、到货分几次登记、改到货安排、换供应商移出、删采购单时批次跟着改。
// 合行、到货安排这些纯规则在 order-batch-rules.test.ts；合并导出和取号在 order-batch-export.test.ts。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AppError, count, one as oneRow, parseStoredJson, rows } from '../server/core/index.js';
import { storedScheduleEntrySchema } from '../shared/business/index.js';
import { OperationsService, OrderBatchService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/index.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { purchaseNextSteps } from '../shared/business/order-next-step.js';
import { quantityUnits } from '../shared/core/quantity.js';
import { flowFixture, clerk } from './flow-fixture.js';
import { registerArrival } from '../server/flow/index.js';
import { actor, superActor } from './actor-fixture.js';

/** 移出订货单那条审计的内容：这里要看的几项（版本号前后原样取，整个对象比） */
const detachAudit = z.object({
  purchaseId: z.number(),
  purchaseNumber: z.string(),
  deleted: z.boolean(),
  before: z.array(z.object({ rowKey: z.string() })),
  after: z.array(z.object({ rowKey: z.string() })),
  version: z.unknown(),
  reason: z.string(),
});

function setup() {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store),
    docs = new BusinessDocuments(store, async () => Buffer.from('虚构订货单文件')),
    batches = new OrderBatchService(store);
  const supplier = ops.saveSupplier({ name: '虚构春芳纸板厂', contact: '虚构联系人', phone: '000', address: '' }, actor);
  const other = ops.saveSupplier({ name: '虚构另一家纸板厂', contact: '', phone: '', address: '' }, actor);
  const item = ops.saveItem(
    { name: '虚构纸板A', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm', specification: 'K=A B楞' },
    actor,
  );
  const purchase = (quantity: string, orderDate: string, supplierId = supplier.id) =>
    ops.savePurchase(
      { supplierId, orderDate, expectedDate: null, status: '待订货', notes: '', lines: [{ ...item, stockItemId: item.id, quantity, unitPrice: '1.2', priceBasis: 'quantity' }] },
      actor,
    );
  /** 把采购单改成已订货；skipBatch 时不自动建订货单（测试自己合并建） */
  const ordered = (ids: number[], options: { skipBatch?: boolean } = {}) => {
    for (const id of ids) {
      const cur = flow.views.purchases(true, id)[0];
      flow.stock.savePurchase({ ...cur, status: '已订货', version: cur.version }, actor, id, options);
    }
  };
  const stock = () => quantityUnits(ops.items(true, item.id)[0].quantity);
  return { store, ops, flow, docs, batches, supplier, other, item, purchase, ordered, stock };
}

/** 两张采购单（1000 张、500 张）合并导出一份订货单并交付完成：订货批次建好了 */
async function mergedBatch() {
  const f = setup();
  const a = f.purchase('1000', '2026-11-01'),
    b = f.purchase('500', '2026-11-02');
  const draft = f.batches.draft([a.id, b.id], actor);
  const key = draft.rows[0].key;
  // 不写到货日期也能导出；这里给 1000 张写了截止日期，其余日期待定
  const file = await f.docs.generate(
    {
      kind: 'purchase',
      id: a.id,
      format: 'xlsx',
      markOrdered: true,
      expectedVersion: a.version,
      purchases: [
        { id: a.id, version: a.version },
        { id: b.id, version: b.version },
      ],
      schedule: [{ rowKey: key, quantity: '1000', dueDate: '2026-11-12' }],
      requestId: randomUUID(),
    },
    actor,
  );
  f.docs.delivered(file.exportId, actor);
  f.docs.complete(file.exportId, file.sha256, actor);
  const batchId = f.batches.batchIdOf(a.id);
  assert.ok(batchId, '交付完成后建了订货批次');
  return { ...f, a, b, draft, key, file, batchId };
}

test('几张采购单合并导出一份订货单：同种纸板合一行，交付完成后全部已订货，建一个订货批次进待到货', async () => {
  const f = await mergedBatch();
  assert.equal(f.draft.rows.length, 1, '同种纸板合成一行');
  assert.equal(f.draft.rows[0].orderedUnits, 1500_000);
  assert.match(f.file.filename, /^DG-\d{8}-01-采购订货单/);
  const purchases = f.flow.views.purchases(true, [f.a.id, f.b.id]).sort((x, y) => x.id - y.id);
  assert.deepEqual(purchases.map((p) => p.businessStatus), ['已订货', '已订货']);
  assert.equal(f.batches.batchIdOf(f.b.id), f.batchId);
  const batch = f.batches.view(f.batchId);
  assert.match(batch.number, /^DG-/);
  assert.deepEqual(batch.rows[0].schedule.map((s) => [s.dueDate, s.remainingUnits]), [
    ['2026-11-12', 1000_000],
    [null, 500_000],
  ]);
  assert.equal(f.batches.open().length, 1, '待到货里有它');
  assert.deepEqual(purchaseNextSteps(purchases[0]).steps.map((s) => s.kind), ['arrival'], '已订货后到货安排在订货单上，下一步就是等到货');
});

test('合并订货单的到货可以分几次登记：先分给早下单的采购单，合格的直接入库，送齐后不再待到货，多送的拒收', async () => {
  const f = await mergedBatch();
  const { a, b, key, batchId } = f;
  const batch = f.batches.view(batchId);
  // 第一张送货单到 1200 张，其中 100 张不合格
  const first = registerArrival(f.batches.store,
    { batchId },
    {
      expectedVersion: batch.version,
      requestId: randomUUID(),
      date: '2026-11-10',
      reference: '虚构送货单-001',
      rows: [{ key, quantity: '1200', rejectedQuantity: '100' }],
    },
    actor,
  );
  assert.equal(first.arrival.status, 'confirmed');
  assert.equal(f.stock(), 1100_000, '合格的直接入库');
  const after = f.flow.views.purchases(true, [a.id, b.id]).sort((x, y) => x.id - y.id);
  assert.deepEqual(after.map((p) => p.lines[0].receivedUnits), [1000_000, 200_000], '先分给早下单的采购单');
  assert.equal(first.batch.progress.state, '部分到货');
  assert.deepEqual(first.batch.rows[0].schedule.map((s) => [s.dueDate, s.remainingUnits]), [
    ['2026-11-12', 0],
    [null, 300_000],
  ]);
  // 第二张送货单把剩下的送齐
  const second = registerArrival(f.batches.store, 
    { batchId },
    {
      expectedVersion: first.batch.version,
      requestId: randomUUID(),
      date: '2026-11-10',
      reference: '虚构送货单-002',
      rows: [{ key, quantity: '300' }],
    },
    actor,
  );
  assert.equal(second.batch.progress.state, '已到齐');
  assert.equal(second.batch.arrivals.length, 2, '一份订货单对应两张到货单');
  assert.equal(f.batches.open().length, 0);
  assert.throws(
    () =>
      registerArrival(f.batches.store, 
        { batchId },
        { expectedVersion: second.batch.version, requestId: randomUUID(), date: '2026-11-10', rows: [{ key, quantity: '1' }] },
        actor,
      ),
    /比还没到的/,
  );
});

test('手工改成已订货也自动进待到货；不同供应商、已在别的订货单里的不能合并', () => {
  const f = setup();
  const a = f.purchase('100', '2026-11-01');
  const current = f.flow.views.purchases(true, a.id)[0];
  f.ordered([a.id]);
  const batchId = f.batches.batchIdOf(a.id);
  assert.ok(batchId);
  assert.equal(f.batches.view(batchId).number, current.number, '只有一张采购单时订货单号就是采购单号');
  const b = f.purchase('100', '2026-11-02');
  assert.throws(() => f.batches.draft([a.id, b.id], actor), /别的订货单/);
  const c = f.purchase('100', '2026-11-02', f.other.id);
  assert.throws(() => f.batches.draft([b.id, c.id], actor), /同一家供应商/);
});

test('改到货安排：数量合计不能超过订货数量；同样的请求再交一次原样返回，内容不同的旧版本拒绝', () => {
  const f = setup();
  const a = f.purchase('100', '2026-11-01');
  f.ordered([a.id]);
  const batchId = f.batches.batchIdOf(a.id);
  assert.ok(batchId, '已订货后自动建了订货批次');
  const batch = f.batches.view(batchId);
  const key = batch.rows[0].key;
  assert.throws(
    () => f.batches.saveSchedule(batch.id, { expectedVersion: batch.version, schedule: [{ rowKey: key, quantity: '101', dueDate: null }] }, actor),
    /比订货的/,
  );
  const body = {
    expectedVersion: batch.version,
    schedule: [
      { rowKey: key, quantity: '60', dueDate: '2026-11-05' },
      { rowKey: key, quantity: '40', dueDate: '2026-11-09' },
    ],
  };
  const saved = f.batches.saveSchedule(batch.id, body, actor);
  assert.deepEqual(saved.rows[0].schedule.map((s) => s.dueDate), ['2026-11-05', '2026-11-09']);
  assert.equal(f.batches.saveSchedule(batch.id, body, actor).version, saved.version, '重交原样返回');
  assert.throws(
    () => f.batches.saveSchedule(batch.id, { expectedVersion: batch.version, schedule: [] }, actor),
    /已更新/,
  );
});

test('一次登记到货里同规格同名的新纸板只建一个库存品', async () => {
  const f = flowFixture();
  const sheet = { name: '虚构五层板', unit: '张', length: 1200, width: 800, dimensionUnit: 'mm', material: 'K', flute: 'BC', quantity: '100', priceBasis: 'quantity', unitPrice: '2.5' };
  const p1 = f.ops.savePurchase({ supplierId: f.supplier.id, orderDate: '2026-10-01', status: '待订货', lines: [sheet] }, clerk);
  const p2 = f.ops.savePurchase({ supplierId: f.supplier.id, orderDate: '2026-10-02', status: '待订货', lines: [sheet] }, clerk);
  for (const p of [p1, p2]) {
    const cur = f.flow.views.purchases(true, p.id)[0];
    f.flow.stock.savePurchase({ ...cur, status: '已订货', version: cur.version }, clerk, p.id, { skipBatch: true });
  }
  const batches = new OrderBatchService(f.store);
  const b = batches.create([p1.id, p2.id], clerk);
  registerArrival(batches.store, { batchId: b.id }, { expectedVersion: b.version, requestId: randomUUID(), date: '2026-10-27', rows: [{ key: b.rows[0].key, quantity: '150' }] }, clerk);
  assert.equal(count(f.store.db, "SELECT COUNT(*) AS n FROM stock_items WHERE kind='raw' AND name='虚构五层板'"), 1);
});

test('采购单换供应商：移出原来那家的合并订货单、按新供应商另建；到货安排里只属于它的行一起去掉，版本号加一，打开着的安排窗口保存时提示刷新', async () => {
  const f = flowFixture();
  const other = f.ops.saveSupplier({ name: '虚构供应商三' }, clerk);
  const buy = (name: string, date: string) =>
    f.ops.savePurchase(
      { supplierId: f.supplier.id, orderDate: date, status: '待订货', lines: [{ name, unit: '张', stockItemId: f.raw.id, quantity: '100', priceBasis: 'quantity', unitPrice: '1' }] },
      clerk,
    );
  const pa = buy('虚构移出纸板A', '2026-10-01'),
    pb = buy('虚构移出纸板B', '2026-10-02');
  for (const p of [pa, pb]) {
    const cur = f.flow.views.purchases(true, p.id)[0];
    f.flow.stock.savePurchase({ ...cur, status: '已订货', version: cur.version }, clerk, p.id, { skipBatch: true });
  }
  const batches = new OrderBatchService(f.store);
  let b = batches.create([pa.id, pb.id], clerk);
  const keyOf = (name: string) => {
    const row = b.rows.find((r) => r.name === name);
    assert.ok(row, '订货单上有“' + name + '”这一行');
    return row.key;
  };
  const keyA = keyOf('虚构移出纸板A'),
    keyB = keyOf('虚构移出纸板B');
  b = batches.saveSchedule(
    b.id,
    {
      expectedVersion: b.version,
      schedule: [
        { rowKey: keyA, quantity: '100', dueDate: '2026-11-20' },
        { rowKey: keyB, quantity: '100', dueDate: '2026-11-22' },
      ],
    },
    clerk,
  );
  const opened = b;
  const cur = f.flow.views.purchases(true, pb.id)[0];
  f.flow.stock.savePurchase({ ...cur, supplierId: other.id, version: cur.version }, clerk, pb.id);
  const after = batches.view(b.id);
  assert.notEqual(batches.batchIdOf(pb.id), b.id);
  const moved = batches.batchIdOf(pb.id);
  assert.ok(moved, '移出后按新供应商建了订货批次');
  assert.equal(batches.view(moved).supplierId, other.id, '按新供应商另建');
  assert.deepEqual(after.purchases.map((p) => p.id), [pa.id]);
  assert.equal(after.version, opened.version + 1);
  // 以前移出后 B 的安排行留在库里（详情里看不到），打开着的窗口一保存就报“有一行不在这份订货单里”
  assert.deepEqual(after.schedule.map((e) => [e.rowKey, e.dueDate]), [[keyA, '2026-11-20']]);
  const kept = oneRow(f.store.db, rows.order_batches.pick({ schedule: true }), 'SELECT schedule FROM order_batches WHERE id=?', b.id);
  assert.ok(kept, '原来的订货单还在');
  const stored = parseStoredJson(z.array(storedScheduleEntrySchema), kept.schedule, 'order_batches.schedule');
  assert.deepEqual(stored.map((e) => e.rowKey), [keyA], '库里也没有孤立的安排行');
  assert.throws(
    () =>
      batches.saveSchedule(
        b.id,
        { expectedVersion: opened.version, schedule: [{ rowKey: keyA, quantity: '100', dueDate: '2026-11-21' }] },
        clerk,
      ),
    (e: unknown) => e instanceof AppError && e.status === 409 && e.message === '订货单已更新，请刷新后再改。',
  );
  // 审计记下到货安排前后和版本号前后，和删除采购单时那条（auditBatchDetach）同一种写法
  const detached = oneRow(
    f.store.db,
    rows.business_audit.pick({ document: true }),
    "SELECT document FROM business_audit WHERE entity='order_batches' AND record_id=? AND action='detach' ORDER BY rowid DESC LIMIT 1",
    b.id,
  );
  assert.ok(detached, '记了移出订货单的审计');
  const detail = detachAudit.parse(JSON.parse(detached.document));
  assert.equal(detail.purchaseId, pb.id);
  assert.equal(detail.purchaseNumber, cur.number);
  assert.equal(detail.deleted, false);
  assert.deepEqual(detail.before.map((e) => e.rowKey), [keyA, keyB]);
  assert.deepEqual(detail.after.map((e) => e.rowKey), [keyA]);
  assert.deepEqual(detail.version, { before: opened.version, after: opened.version + 1 });
  assert.match(detail.reason, /换了供应商，移出订货单 .*到货安排去掉只属于它的 1 行，版本号加一/);
  // 刷新后按新版本保存照常
  batches.saveSchedule(b.id, { expectedVersion: after.version, schedule: [{ rowKey: keyA, quantity: '100', dueDate: '2026-11-21' }] }, clerk);
});

/** 两张采购单合在一份订货单里，已经按订货单登记过一次到货 */
function orderedWithArrival() {
  const f = setup();
  const a = f.purchase('100', '2026-11-01'),
    b = f.purchase('100', '2026-11-02');
  f.ordered([a.id, b.id], { skipBatch: true });
  const batch = f.batches.create([a.id, b.id], actor);
  const received = registerArrival(f.batches.store,
    { batchId: batch.id },
    { expectedVersion: batch.version, requestId: randomUUID(), date: '2026-11-10', reference: '虚构送货单-删批次', rows: [{ key: batch.rows[0].key, quantity: '50' }] },
    actor,
  );
  const batchCount = () => count(f.store.db, 'SELECT COUNT(*) AS n FROM order_batches');
  return { ...f, a, b, batch, arrivalId: received.arrival.id, batchCount };
}
/** 删除时选中的那张采购单：编号和现在的版本号 */
const currentPurchase = (f: ReturnType<typeof setup>, id: number) => {
  const p = f.flow.views.purchases(true, id)[0];
  return { id: p.id, version: p.version };
};

test('删除采购单（本机维护）：从订货批次里去掉，批次空了一起删并列进影响清单，按批次登记的到货单留着、去掉批次编号，之后供应商也能删', () => {
  // 先删一张，批次还在；再删另一张，批次空了一起删
  const f = orderedWithArrival(),
    owner = localAdministratorActor({ ...actor, role: 'super_admin' }),
    service = new DatabaseMaintenanceService(f.store);
  const del = (id: number) => {
    const selection = { module: 'purchases', items: [currentPurchase(f, id)] },
      plan = service.preview(selection, owner);
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test-binding');
    return plan;
  };
  const versionBefore = f.batches.view(f.batch.id).version;
  const first = del(f.a.id);
  assert.ok(first.impact.some((r) => r.table === 'order_batch_purchases' && r.action === 'delete'));
  assert.equal(first.impact.some((r) => r.table === 'order_batches' && r.action === 'delete'), false, '批次里还有别的采购单，不删批次');
  // 批次留着：到货安排去掉只属于删掉那张的行，版本号加一（打开着的安排窗口保存时提示刷新）
  assert.deepEqual(
    first.impact.filter((r) => r.table === 'order_batches').map((r) => [r.action, r.fields, r.keptBatch]),
    [['detach', ['schedule'], f.batch.number]],
  );
  assert.equal(f.batches.view(f.batch.id).version, versionBefore + 1);
  assert.deepEqual(f.batches.view(f.batch.id).purchases.map((p) => p.id), [f.b.id]);
  const second = del(f.b.id);
  assert.ok(
    second.impact.some((r) => r.table === 'order_batches' && r.action === 'delete' && r.name === f.batch.number),
    '影响清单列出一起删的空批次',
  );
  assert.ok(
    second.impact.some((r) => r.table === 'flow_documents' && r.id === f.arrivalId && r.action === 'detach'),
    '按批次登记的到货单解除批次',
  );
  assert.equal(f.batchCount(), 0, '不留空批次');
  const extracted = oneRow(f.store.db, z.object({ b: z.unknown() }), "SELECT json_extract(document,'$.orderBatchId') AS b FROM flow_documents WHERE id=?", f.arrivalId);
  assert.ok(extracted, '到货单还在');
  assert.equal(extracted.b, null);
  // 批次是到货单上的外键列：列置空，单据内容里去掉这个键（不是写成 null，否则管理员再编辑这张到货单时校验不过）
  assert.deepEqual(
    { ...f.store.db.prepare("SELECT order_batch_id,json_type(document,'$.orderBatchId') AS inDocument FROM flow_documents WHERE id=?").get(f.arrivalId) },
    { order_batch_id: null, inDocument: null },
  );
  assert.deepEqual(
    second.impact.find((r) => r.table === 'flow_documents' && r.id === f.arrivalId)?.fields,
    ['order_batch_id'],
    '影响清单按“订货批次”显示',
  );
  assert.deepEqual(f.batches.open(), []);
  // 供应商名下没有采购单也没有批次了，能删
  const supplier = f.ops.suppliers(true, f.supplier.id)[0],
    selection = { module: 'suppliers', items: [{ id: supplier.id, version: supplier.version }] },
    plan = service.preview(selection, owner);
  service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test-binding');
  assert.equal(f.ops.suppliers(true, f.supplier.id).length, 0);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('删除采购单（不在本机的超级管理员模式）：和本机同一个删除引擎，去掉成员、空批次一起删并列进预览；供应商名下的空批次随供应商一起删', () => {
  const f = setup(),
    admin = superActor(),
    deletion = new DatabaseMaintenanceService(f.store);
  const a = f.purchase('100', '2026-11-01'),
    b = f.purchase('100', '2026-11-02');
  f.ordered([a.id, b.id], { skipBatch: true });
  const batch = f.batches.create([a.id, b.id], actor);
  const del = (module: 'purchases' | 'suppliers', item: { id: number; version: number }) => {
    const selection = { module, items: [item] },
      preview = deletion.preview(selection, admin);
    deletion.delete({ ...selection, requestId: randomUUID(), deletionDigest: preview.digest }, admin, 'test-binding');
    return preview;
  };
  const first = del('purchases', currentPurchase(f, a.id));
  // 批次留着，只是改一次（去掉只属于删掉那张的安排行、版本号加一），不删
  assert.equal(first.impact.some((r) => r.table === 'order_batches' && r.action === 'delete'), false);
  assert.ok(first.impact.some((r) => r.table === 'order_batches' && r.action === 'detach'));
  assert.deepEqual(f.batches.view(batch.id).purchases.map((p) => p.id), [b.id]);
  const second = del('purchases', currentPurchase(f, b.id));
  assert.ok(second.impact.some((r) => r.table === 'order_batches' && r.action === 'delete' && r.name === batch.number));
  assert.equal(f.store.db.prepare('SELECT 1 FROM order_batches').get(), undefined);
  // 名下留着空批次的供应商：删供应商时空批次一起删，不被它拦下
  const other = f.ops.suppliers(true, f.other.id)[0];
  f.store.db
    .prepare("INSERT INTO order_batches(number,supplier_id,order_date,actor_id,actor_name,created_at,updated_at) VALUES('虚构空批次',?,'2026-11-01','x','x','t','t')")
    .run(other.id);
  const supplierPlan = del('suppliers', { id: other.id, version: other.version });
  assert.ok(supplierPlan.impact.some((r) => r.table === 'order_batches' && r.name === '虚构空批次'));
  assert.equal(f.ops.suppliers(true, other.id).length, 0);
  assert.equal(f.store.db.prepare('SELECT 1 FROM order_batches').get(), undefined);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});
