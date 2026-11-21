// 删除时各模块按登记的规则配合（server/core/deletion-rules.ts）：删除引擎只调登记的规则，表由它的主人写；
// 没登记的表宁可拒绝。编号、单号删了不复用；合并订货单删一张时订货单跟着改。删产品连带成品库存在 delete-product-stock.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { deletionImpactView } from '../src/recordkit/deletion-impact.js';
import { OrderBatchService } from '../server/operations/index.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { InboxService } from '../server/inbox/service.js';
import type { InboxIncoming } from '../shared/import/inbox.js';
import { requireRecordDeletionHook, resetClear, resetParticipants } from '../server/core/deletion-rules.js';
import { AppError } from '../server/core/errors.js';
import { listingFixture, mergeIntoBatch, orderWithImports, setup } from './delete-fixture.js';
import { z } from 'zod';
import { count, many, one, rows } from '../server/core/index.js';
import { actor, superActor } from './actor-fixture.js';
import { must } from './read-result.js';


for (const [where, actorOf] of [
  ['本机最高管理员', () => localAdministratorActor(superActor())],
  ['不在本机的超级管理员模式', superActor],
] as const)
  test(`${where}删订单：订单和明细删掉，识别导入按登记的规则给从它导入的记录打“已永久删除”标记并解除引用，别的订单的导入记录不动`, () => {
    const f = orderWithImports(),
      who = actorOf();
    try {
      const service = new DatabaseMaintenanceService(f.store),
        selection = { module: 'orders', items: [{ id: f.target.id, version: f.target.version }] },
        plan = service.preview(selection, who);
      assert.ok(plan.impact.some((r) => r.table === 'import_executions' && r.action === 'detach'), '影响清单列出解除引用的导入记录');
      const requestId = randomUUID();
      service.delete({ ...selection, requestId, deletionDigest: plan.digest }, who, 'test-binding');
      assert.ok(!f.store.db.prepare('SELECT 1 FROM orders WHERE id=?').get(f.target.id));
      assert.equal(count(f.store.db, 'SELECT COUNT(*) FROM order_lines WHERE order_id=?', f.target.id), 0);
      const linked = f.execution('linked');
      assert.equal(linked.orderId, null);
      assert.equal(linked.doc.permanentDeletion?.requestId, requestId, '记下是哪次删除');
      assert.equal(linked.doc.permanentDeletion?.actorId, who.id);
      const other = f.execution('other');
      assert.equal(other.orderId, f.other.id);
      assert.equal(other.doc.permanentDeletion, undefined);
    } finally {
      f.store.close();
    }
  });

test('删除影响清单里唛头、唛头原文件、订单明细叫看得懂的名字，不显示内部编号；执行后没有唛头再用的原文件一起删', () => {
  const f = orderWithImports();
  try {
    const product = must(f.store.product(f.target.lines[0].productId), '产品');
    // 虚构一张唛头原文件和挂在产品上的唛头（只是几个字节，不是真实文件）
    const content = Buffer.from('fictional-mark'),
      sha = createHash('sha256').update(content).digest('hex');
    f.store.db
      .prepare('INSERT INTO mark_files(sha256,size,mime,file_name,content) VALUES(?,?,?,?,?)')
      .run(sha, content.length, 'image/png', '虚构唛头.png', content);
    f.store.db
      .prepare("INSERT INTO product_marks(product_id,file_sha256,title,source_kind,created_by,created_at,updated_at) VALUES(?,?,'正面唛头','manual','tester','t','t')")
      .run(product.id, sha);
    // 另一张原文件这个产品和别的产品都在用：别的产品还用着，不删也不列
    const sharedContent = Buffer.from('fictional-shared-mark'),
      sharedSha = createHash('sha256').update(sharedContent).digest('hex'),
      otherProduct = f.store.saveProduct(productSchema.parse({ name: '虚构别的纸箱' }));
    f.store.db
      .prepare('INSERT INTO mark_files(sha256,size,mime,file_name,content) VALUES(?,?,?,?,?)')
      .run(sharedSha, sharedContent.length, 'image/png', '虚构共用唛头.png', sharedContent);
    for (const id of [product.id, otherProduct.id])
      f.store.db
        .prepare("INSERT INTO product_marks(product_id,file_sha256,title,source_kind,created_by,created_at,updated_at) VALUES(?,?,'共用唛头','manual','tester','t','t')")
        .run(id, sharedSha);
    const who = localAdministratorActor(superActor()),
      selection = { module: 'products', items: [{ id: product.id, version: product.version }] },
      plan = new DatabaseMaintenanceService(f.store).preview(selection, who);
    const named = (table: string) => plan.impact.filter((r) => r.table === table).map((r) => r.name);
    assert.deepEqual(named('product_marks').sort(), ['虚构纸箱 共用唛头', '虚构纸箱 正面唛头'].sort());
    assert.deepEqual(named('mark_files'), ['虚构唛头.png']);
    assert.deepEqual(named('order_lines').sort(), [f.target.number + ' 虚构纸箱', f.other.number + ' 虚构纸箱'].sort());
    // 执行后原文件确实删掉了，和清单一致
    new DatabaseMaintenanceService(f.store).delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, who, 'session');
    assert.equal(f.store.db.prepare('SELECT 1 FROM mark_files WHERE sha256=?').get(sha), undefined);
    assert.ok(f.store.db.prepare('SELECT 1 FROM mark_files WHERE sha256=?').get(sharedSha), '别的产品还在用的原文件留着');
  } finally {
    f.store.close();
  }
});

test('新加的表引用了要删的记录、却没登记删除规则：预览时就拒绝，不替它直接写', () => {
  const f = orderWithImports();
  try {
    // 模拟以后新模块加了一张引用客户的表，忘了登记删除规则
    f.store.db.exec('CREATE TABLE fictional_customer_notes(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id))');
    const lonely = f.store.saveCustomer(customerSchema.parse({ name: '虚构新客户' }));
    f.store.db.prepare('INSERT INTO fictional_customer_notes(id,customer_id) VALUES(1,?)').run(lonely.id);
    const service = new DatabaseMaintenanceService(f.store),
      who = localAdministratorActor(superActor()),
      selection = { module: 'customers', items: [{ id: lonely.id, version: lonely.version }] };
    assert.throws(() => service.preview(selection, who), /fictional_customer_notes.*没有登记删除规则/);
    assert.throws(
      () => service.delete({ ...selection, requestId: randomUUID() }, who, 'test-binding'),
      /fictional_customer_notes.*没有登记删除规则/,
    );
    assert.ok(f.store.db.prepare('SELECT 1 FROM customers WHERE id=?').get(lonely.id), '客户还在');
    assert.ok(f.store.db.prepare('SELECT 1 FROM fictional_customer_notes WHERE id=1').get(), '新表的行还在');
  } finally {
    f.store.close();
  }
});

/*
 * 编号不复用：编号是自增的，删掉的也算用过；单号里的序号就是记录编号。
 * 删掉最后一条以后，新记录接着往上编，不会接上被删记录的编号和单号。
 */
test('删掉最后一张单据后，新单据不复用单号和编号：单号里的序号就是编号', () => {
  const f = setup();
  try {
    // 用还没核对的到货单（业务账号就能删）
    const numberOf = (doc: { id: number }) => 'DH-20261109-' + String(doc.id).padStart(5, '0');
    const last = f.arrival('虚构-300');
    assert.equal(last.number, numberOf(last));
    const plan = f.service.preview(f.selection(last), actor);
    f.service.delete({ ...f.selection(last), requestId: randomUUID(), deletionDigest: plan.digest }, actor, 'test-binding');
    assert.equal(f.exists(last.id), false);
    const next = f.arrival('虚构-400');
    assert.equal(next.id, last.id + 1, '编号接着往上走，不回头用删掉的');
    assert.notEqual(next.number, last.number, '不接上被删单据的单号');
    assert.equal(next.number, numberOf(next), '单号里的序号等于编号');
    // 连着删两张也一样
    const again = f.arrival('虚构-500');
    for (const doc of [again, next]) {
      const p = f.service.preview(f.selection(doc), actor);
      f.service.delete({ ...f.selection(doc), requestId: randomUUID(), deletionDigest: p.digest }, actor, 'test-binding');
    }
    const third = f.arrival('虚构-600');
    assert.equal(third.id, again.id + 1);
    assert.equal(third.number, numberOf(third));
    const numbers = f.store.db.prepare('SELECT number FROM flow_documents').all().map((r) => String(r.number));
    assert.equal(new Set(numbers).size, numbers.length, '库里没有重复单号');
  } finally {
    f.store.close();
  }
});

test('删前要别的模块配合的记录：没有模块登记删前配合就报 500；识别导入加载后删订单的配合已登记', () => {
  assert.throws(
    () => requireRecordDeletionHook('虚构记录'),
    (e) => e instanceof AppError && e.status === 500 && /没有模块登记删前要做的事/.test(e.message),
  );
  // 本文件经 delete-fixture.ts 加载了识别导入（server/import/deletion.ts 登记删订单前给导入记录打标记）
  assert.doesNotThrow(() => requireRecordDeletionHook('orders'));
});

test('删掉最后一个客户、最后一张订单后，新编号和订单号不复用', () => {
  const f = orderWithImports();
  try {
    const admin = localAdministratorActor(superActor()),
      service = new DatabaseMaintenanceService(f.store);
    // 客户：建一个没有往来的，用删除引擎删掉，再建一个
    const lonely = f.store.saveCustomer(customerSchema.parse({ name: '虚构新客户' }));
    const selection = { module: 'customers', items: [{ id: lonely.id, version: lonely.version }] };
    const plan = service.preview(selection, admin);
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, admin, 'test-binding');
    assert.ok(!f.store.db.prepare('SELECT 1 FROM customers WHERE id=?').get(lonely.id), '客户删掉了');
    const fresh = f.store.saveCustomer(customerSchema.parse({ name: '虚构再建客户' }));
    assert.ok(fresh.id > lonely.id, '新客户不接上被删客户的编号');
    // 订单：不在本机的超级管理员模式删掉最后一张，再建一张
    const who = superActor(),
      orderSelection = { module: 'orders', items: [{ id: f.other.id, version: f.other.version }] },
      p = service.preview(orderSelection, who);
    service.delete({ ...orderSelection, requestId: randomUUID(), deletionDigest: p.digest }, who, 'session');
    assert.ok(!f.store.db.prepare('SELECT 1 FROM orders WHERE id=?').get(f.other.id), '订单删掉了');
    const product = must(one(f.store.db, rows.products.pick({ id: true }), 'SELECT id FROM products LIMIT 1'), '产品');
    const order = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-20',
        status: '已确认',
        lines: [{ productId: Number(product.id), quantity: 300, unit: '只', unitPriceCents: 100 }],
      }),
    );
    assert.ok(order.id > f.other.id, '新订单不接上被删订单的编号');
    assert.notEqual(order.number, f.other.number, '不接上被删订单的订单号');
    assert.equal(order.number, 'ZX-20261101-' + String(order.id).padStart(4, '0'), '订单号里的序号等于编号');
  } finally {
    f.store.close();
  }
});

test('收件箱清空以后，新消息的编号接着往上走，不回到 1', () => {
  const store = new Store(':memory:'),
    inbox = new InboxService(store);
  try {
    const incoming = (externalId: string): InboxIncoming => ({
      channel: 'manual',
      externalId,
      kind: 'text',
      text: '虚构消息',
      receivedAt: '2026-11-05T10:00:00Z',
    });
    inbox.ingest(incoming('a'));
    const second = inbox.ingest(incoming('b'));
    // 按识别导入登记的清空规则清（初始化用的就是它）；转单记录、审计里还留着旧消息的编号
    for (const rule of resetParticipants(['识别导入'], false).filter((r) => r.module === '识别导入')) resetClear(store, rule);
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM inbox_items'), 0, '收件箱清空了');
    const next = inbox.ingest(incoming('c'));
    assert.equal(Number(next.id), Number(second.id) + 1);
  } finally {
    store.close();
  }
});

/** 订货单“去掉采购单”的审计（detach）：来源、动作和审计内容里测试要看的几项 */
const detachDocument = z.looseObject({
  purchaseIds: z.array(z.number()),
  purchaseNumbers: z.array(z.string()),
  deleted: z.boolean(),
  version: z.unknown(),
  before: z.array(z.looseObject({ rowKey: z.string() })),
  after: z.array(z.looseObject({ rowKey: z.string() })),
  reason: z.string(),
});
const batchAudits = (store: Store, batchId: number) =>
  many(
    store.db,
    rows.business_audit.pick({ source: true, action: true, document: true }),
    "SELECT source,action,document FROM business_audit WHERE entity='order_batches' AND record_id=? AND action='detach' ORDER BY id",
    batchId,
  ).map((r) => ({ source: r.source, action: r.action, ...detachDocument.parse(JSON.parse(r.document)) }));

/**
 * 三张采购单合成一份订货单 DG-20261102-01：a 订纸板 A、b 订纸板 B、a2 再订纸板 A（和 a 合成一行），各 500 张；
 * 到货安排 A 两段（600、400）、B 一段（500）。opened 是排好安排后打开着的那一版；remove(采购单) 由本机管理员按库存一起改回删掉它。
 */
function mergedBatch() {
  const owner = localAdministratorActor({ ...actor, role: 'super_admin' });
  const f = listingFixture();
  try {
    // 两张采购单合成一份订货单：一张订纸板 A，一张订纸板 B（到货安排里是两行），再各补一张同样订 A 的（和第一张合成一行）
    const buy = (name: string) =>
      f.ops.savePurchase(
        { supplierId: f.supplier.id, status: '已订货', orderDate: '2026-11-01', lines: [{ stockItemId: f.raw.id, name, unit: '张', quantity: '500', unitPrice: '1', priceBasis: 'quantity' }] },
        actor,
      );
    const a = buy('虚构安排纸板A'),
      b = buy('虚构安排纸板B'),
      a2 = buy('虚构安排纸板A');
    const batchId = mergeIntoBatch(f.store, f.supplier.id, 'DG-20261102-01', [a, b, a2], '2026-11-02');
    const batches = new OrderBatchService(f.store);
    let batch = batches.view(batchId);
    assert.equal(batch.rows.length, 2, '纸板 A 两张合成一行，纸板 B 一行');
    const keyOf = (name: string) => must(batch.rows.find((r) => r.name === name), '订货单里的 ' + name).key;
    const keyA = keyOf('虚构安排纸板A'),
      keyB = keyOf('虚构安排纸板B');
    batch = batches.saveSchedule(
      batchId,
      {
        expectedVersion: batch.version,
        schedule: [
          { rowKey: keyA, quantity: '600', dueDate: '2026-11-20' },
          { rowKey: keyA, quantity: '400', dueDate: '2026-11-25' },
          { rowKey: keyB, quantity: '500', dueDate: '2026-11-22' },
        ],
      },
      owner,
    );
    const opened = batch; // 打开着的到货安排窗口拿到的是这一版
    const remove = (p: { id: number }) => {
      const row = f.flow.views.purchases(true, p.id)[0];
      const selection = { module: 'purchases' as const, items: [{ id: row.id, version: row.version }], inventoryPolicy: 'recalculate' as const };
      const plan = f.service.preview(selection, owner);
      f.service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 's');
      return plan;
    };
    return { f, owner, a, b, batchId, batches, opened, keyA, keyB, remove };
  } catch (error) {
    f.store.close(); // 造数据失败也关库，错误照样抛给测试
    throw error;
  }
}

test('删合并订货单里的一张采购单、订货单保留：版本号加一，到货安排里只属于它的行一起去掉；打开着的安排窗口保存时提示刷新', () => {
  const { f, owner, a, b, batchId, batches, opened, keyA, keyB, remove } = mergedBatch();
  try {
    // 删订纸板 B 的那张：订货单还在，版本号加一，安排里 B 那一行去掉，A 的照旧
    const plan = remove(b);
    const view = deletionImpactView(plan);
    assert.deepEqual(view.kept, [{ kind: '订货单', name: 'DG-20261102-01', note: '保留，去掉这张采购单（订货单里还有别的采购单）' }]);
    let batch = batches.view(batchId);
    assert.equal(batch.version, opened.version + 1);
    assert.deepEqual(
      batch.schedule.map((e) => [e.rowKey, e.dueDate]),
      [
        [keyA, '2026-11-20'],
        [keyA, '2026-11-25'],
      ],
    );
    assert.deepEqual(batch.rows.map((r) => r.name), ['虚构安排纸板A']);
    assert.ok(batch.rows.every((r) => r.schedule.every((e) => e.rowKey === r.key)), '详情里没有孤立的安排行');
    const stamped = must(one(f.store.db, rows.order_batches.pick({ updated_at: true }), 'SELECT updated_at FROM order_batches WHERE id=?', batchId), '订货单');
    assert.notEqual(stamped.updated_at, 't');
    // 订货单的这次改动单独记一条审计（和删采购单那条在同一个事务里）：去掉了哪张采购单、安排少了哪几行、版本号前后
    let audits = batchAudits(f.store, batchId);
    assert.equal(audits.length, 1, '删一次记一条');
    assert.equal(audits[0].action, 'detach');
    assert.deepEqual(audits[0].purchaseIds, [b.id]);
    assert.deepEqual(audits[0].purchaseNumbers, [b.number]);
    assert.equal(audits[0].deleted, false);
    assert.deepEqual(audits[0].version, { before: opened.version, after: opened.version + 1 });
    assert.deepEqual(audits[0].before.map((e) => e.rowKey), [keyA, keyA, keyB]);
    assert.deepEqual(audits[0].after.map((e) => e.rowKey), [keyA, keyA]);
    assert.equal(audits[0].reason, '删除采购单 ' + b.number + '，订货单 DG-20261102-01 保留：去掉这张采购单，到货安排去掉只属于它的 1 行，版本号加一');
    assert.equal(count(f.store.db, "SELECT COUNT(*) FROM business_audit WHERE entity='purchases' AND record_id=? AND action='delete'", b.id), 1, '删采购单那条照旧');
    // 打开着的安排窗口按旧版本保存：提示已更新、请刷新，不报“有一行不在这份订货单里”
    assert.throws(
      () =>
        batches.saveSchedule(
          batchId,
          { expectedVersion: opened.version, schedule: opened.schedule.map((e) => ({ rowKey: e.rowKey, quantity: String(e.quantityUnits / 1000), dueDate: e.dueDate })) },
          owner,
        ),
      (e: unknown) => e instanceof Error && 'status' in e && e.status === 409 && /已更新/.test(e.message),
    );

    // 再删一张订纸板 A 的：A 这一行还有另一张采购单在订，安排留着，订购数少了按订购数截掉多出来的
    remove(a);
    batch = batches.view(batchId);
    assert.equal(batch.version, opened.version + 2);
    audits = batchAudits(f.store, batchId);
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[1].purchaseIds, [a.id]);
    assert.equal(audits[1].reason, '删除采购单 ' + a.number + '，订货单 DG-20261102-01 保留：去掉这张采购单，版本号加一', '安排没少行就不写安排');
    assert.equal(batch.schedule.length, 2);
    assert.deepEqual(
      batch.rows[0].schedule.map((e) => [e.quantityUnits, e.dueDate]),
      [[500_000, '2026-11-20']],
    );
  } finally {
    f.store.close();
  }
});
