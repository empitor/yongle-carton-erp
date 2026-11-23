// 删除、初始化、维护改写、删对话前的恢复快照：事务里也能拍、没写入时复用、改坏或删掉就重拍、保留策略；拍不成就整体不做。
// 初始化时各模块清自己的表、删除时各模块配合：要先加载识别导入、财务和单据导出模块让它们登记（server/core/deletion-rules.ts），正式服务启动时都会加载
import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import '../server/import/index.js';
import '../server/finance/index.js';
import '../server/documents/index.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/index.js';
import { createBusinessService } from '../server/orders/index.js';
import { manualWrite } from './business-base-fixture.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { BusinessReset } from '../server/admin/business-reset.js';
import { snapshotBeforeDestructive, pruneSnapshots, snapshotTime } from '../server/core/snapshots.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { DataManagementService } from '../server/admin/data-management-service.js';
import { AssistantManager } from '../server/assistant/manager.js';
import { assistantDeps } from './assistant-fixture.js';
import { fakeAiSettings } from './fake-deepseek.js';
import { orderBasics } from './stack-fixture.js';
import { fixture } from './maintenance-fixture.js';

const admin = (): Actor =>
  localAdministratorActor(pageActor({
    id: 'audit-admin',
    name: '虚构管理员',
    permissions: ['business:edit'],
    role: 'super_admin',
    superAdminMode: true,
    superAdminUntil: Date.now() + 60_000,
  }));

function tempStore(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new Store(join(dir, 'erp.sqlite'));
  return {
    dir,
    store,
    snapshots: () => (existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')).sort() : []),
    close() {
      try {
        store.close();
      } catch {
        // 测试中途出错时库可能停在打不开、关不上的状态；这里只管把临时目录删掉
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const read = <T>(file: string, sql: string, map: (row: Record<string, unknown>) => T) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all().map(map);
  } finally {
    db.close();
  }
};
const customerNames = (file: string) => read(file, 'SELECT name FROM customers ORDER BY id', (r) => String(r.name));
const quickCheck = (file: string) => read(file, 'PRAGMA quick_check', (r) => r.quick_check)[0];
/** 文件库拍一份快照：必须拍成，返回快照文件 */
const snapped = (store: Store, reason: string) => {
  const file = snapshotBeforeDestructive(store, reason);
  assert.ok(file, '文件库应当拍出快照：' + reason);
  return file;
};

/** 让拍快照最后一步（把 .partial 改名成正式文件）失败 */
function failSnapshots(t: TestContext) {
  const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[0]).endsWith('.partial')) throw new Error('虚构改名失败');
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => (t.mock.restoreAll(), syncBuiltinESMExports()));
}

test('初始化前自动生成可打开的恢复快照，里面是清空前的数据', () => {
  const f = tempStore('erp-snapshot-reset-');
  try {
    orderBasics(f.store);
    new BusinessReset(f.store).execute({ scope: 'business' }, admin());
    assert.equal(sales(f.store).customers(true).length, 0);
    assert.equal(f.snapshots().length, 1);
    assert.deepEqual(customerNames(join(f.dir, 'snapshots', f.snapshots()[0])), ['虚构客户']);
  } finally {
    f.close();
  }
});

test('恢复快照带着编号水位：清空过的编号在快照打开的库里也不复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-snapshot-seq-')),
    file = join(dir, 'erp.sqlite');
  try {
    const f = orderBasics(new Store(file));
    const order = f.order([f.line(f.pa)]);
    new BusinessReset(f.store).execute({ scope: 'business' }, admin());
    assert.equal(sales(f.store).customers(true).length, 0);
    // 清空以后再拍一份：表是空的，用过的最大编号只记在 sqlite_sequence 里
    const snapshot = snapped(f.store, 'after-reset');
    f.store.close();
    const copy = new Store(snapshot);
    try {
      const customer = sales(copy).createCustomer(customerSchema.parse({ name: '虚构恢复后客户' })),
        product = sales(copy).createProduct(productSchema.parse({ name: '虚构恢复后箱' }));
      assert.equal(customer.id, f.customer.id + 1);
      assert.equal(product.id, f.pb.id + 1);
      const next = sales(copy).saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-10-01',
          deliveryDate: '2026-10-30',
          status: '已确认',
          notes: '',
          costs: null,
          lines: [f.line(product)],
        }),
      );
      assert.equal(next.id, order.id + 1);
      assert.equal(next.number, 'ZX-20261001-' + String(next.id).padStart(4, '0'));
      assert.notEqual(next.number, order.number);
    } finally {
      copy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 事务内也要有快照 ----------

test('事务内也能拍快照，内容是事务开始前已提交的数据；内存库不拍', () => {
  assert.equal(snapshotBeforeDestructive(orderBasics().store, 'memory'), null);
  const f = tempStore('erp-snapshot-tx-');
  try {
    const customer = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构事务前客户' }));
    f.store.db.exec('SAVEPOINT outer_tx');
    f.store.db.prepare('DELETE FROM customers WHERE id=?').run(customer.id);
    f.store.db.prepare("INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES('虚构未提交客户','','','','',datetime('now'),datetime('now'))").run();
    const file = snapshotBeforeDestructive(f.store, 'in-tx');
    assert.ok(file && existsSync(file));
    assert.ok(f.store.db.isTransaction, '拍快照不影响调用方的事务');
    f.store.db.exec('ROLLBACK TO outer_tx; RELEASE outer_tx');
    assert.deepEqual(customerNames(file), ['虚构事务前客户']);
    assert.equal(quickCheck(file), 'ok');
    assert.equal(f.snapshots().some((n) => n.endsWith('.partial')), false);
    assert.notEqual(snapshotTime(f.snapshots()[0]), null);
  } finally {
    f.close();
  }
});

test('删除引擎删记录放在外层 SAVEPOINT 里（助手确认执行）也留下删之前的快照', () => {
  const f = tempStore('erp-snapshot-maint-');
  try {
    const customer = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构待删客户' }));
    f.store.db.exec('SAVEPOINT assistant_commit');
    new DatabaseMaintenanceService(f.store).delete(
      { module: 'customers', items: [{ id: customer.id, version: customer.version }], requestId: randomUUID() },
      admin(),
      'session',
    );
    f.store.db.exec('RELEASE assistant_commit');
    assert.equal(sales(f.store).customer(customer.id, true), undefined);
    const files = f.snapshots();
    assert.equal(files.length, 1);
    assert.deepEqual(customerNames(join(f.dir, 'snapshots', files[0])), ['虚构待删客户']);
  } finally {
    f.close();
  }
});

// 管理员改订单可能物理删除送货单，所以改前拍快照；普通改订单不删东西，不拍
for (const [who, viaAdmin] of [
  ['数据管理', true],
  ['业务页面', false],
] as const)
  test(`${who}改订单：${viaAdmin ? '改之前留下快照' : '不额外拍快照'}`, () => {
    const f = tempStore('erp-snapshot-order-');
    try {
      const customer = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构订单客户' })),
        product = sales(f.store).createProduct(productSchema.parse({ name: '虚构订单纸箱' }));
      const order = sales(f.store).saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-10-01',
          deliveryDate: '2026-10-27',
          status: '已确认',
          lines: [{ productId: product.id, quantity: 100, unitPriceCents: 123 }],
        }),
      );
      if (viaAdmin)
        new DataManagementService(f.store).execute(
          {
            requestId: randomUUID(),
            module: 'orders',
            action: 'update',
            items: [{ id: order.id, version: order.version }],
            patch: { notes: '虚构备注' },
            reason: '虚构维护改订单',
          },
          admin(),
          'session',
        );
      else
        createBusinessService(f.store).execute(
          { entity: 'orders', action: 'update', id: order.id, input: { ...order, notes: '虚构备注', version: order.version } },
          { source: 'manual-ui', operatorId: 'audit-user' },
        );
      assert.equal(sales(f.store).order(order.id, true)?.notes, '虚构备注');
      if (!viaAdmin) return assert.deepEqual(f.snapshots(), []);
      assert.equal(f.snapshots().length, 1);
      const notes = read(join(f.dir, 'snapshots', f.snapshots()[0]), 'SELECT notes FROM orders', (r) => r.notes);
      assert.deepEqual(notes, [''], '快照是改之前的订单');
    } finally {
      f.close();
    }
  });

// 页面上超级管理员模式改订单：本机管理员走连带改写单据的那条路，只留一份改之前的快照；
// 从域名进来的超级管理员走普通保存，不删不改单据，不拍
for (const [who, actor, kept] of [
  ['本机管理员', admin, 1],
  [
    '从域名进来的超级管理员',
    (): Actor =>
      (pageActor({
        id: 'audit-remote',
        name: '虚构超级管理员',
        permissions: ['business:edit'],
        role: 'super_admin',
        superAdminMode: true,
        superAdminUntil: Date.now() + 60_000,
      })),
    0,
  ],
] as const)
  test(`${who}在页面上用超级管理员模式改订单：${kept ? '改之前只留一份快照' : '不拍快照'}`, () => {
    const f = tempStore('erp-snapshot-manual-order-');
    try {
      const b = orderBasics(f.store),
        order = b.order([b.line(b.pa)]);
      manualWrite(f.store, { entity: 'orders', action: 'update', id: order.id, input: { ...order, notes: '虚构备注', version: order.version } }, actor());
      assert.equal(sales(f.store).order(order.id, true)?.notes, '虚构备注');
      assert.equal(f.snapshots().length, kept);
      if (!kept) return;
      const notes = read(join(f.dir, 'snapshots', f.snapshots()[0]), 'SELECT notes FROM orders', (r) => r.notes);
      assert.deepEqual(notes, [''], '快照是改之前的订单');
    } finally {
      f.close();
    }
  });

test('本机管理员改订单删掉一行、只挂这一行的送货单整张删掉：只留改订单前的一份快照', () => {
  const f = tempStore('erp-snapshot-order-cascade-');
  try {
    const m = fixture(f.store);
    const order = sales(f.store).saveOrder(
      orderSchema.parse({
        customerId: m.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: [100, 50].map((quantity) => ({ productId: m.product.id, quantity, unitPriceCents: 100 })),
      }),
    );
    const dropped = m.flow.save(
      'delivery',
      { date: '2026-10-27', customerId: m.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[1].id, stockId: m.finished.id, quantity: '10' }] },
      m.who,
    );
    manualWrite(f.store, { entity: 'orders', action: 'update', id: order.id, input: { ...order, lines: [order.lines[0]], version: order.version } }, m.who);
    assert.equal(f.store.db.prepare('SELECT 1 FROM flow_documents WHERE id=?').get(dropped.id), undefined, '送货单跟着删掉了');
    assert.equal(f.snapshots().length, 1);
  } finally {
    f.close();
  }
});

test('助手删对话前拍快照，快照里还有删掉的对话；没有要删的对话时不拍', () => {
  const f = tempStore('erp-snapshot-chat-');
  const settings = fakeAiSettings({}).settings,
    built = assistantDeps(f.store, settings),
    manager = new AssistantManager(built.deps);
  const who: Actor = pageActor({ id: 'fictional-chat-user', name: '虚构用户', permissions: ['business:edit'], role: 'admin' });
  try {
    const current = manager.create(who),
      old = manager.create(who);
    manager.conversations.deleteThreads({ threadIds: [current.id], includeCurrent: false }, current.id, who);
    assert.deepEqual(f.snapshots(), [], '只点了当前对话：没有要删的，不拍');
    manager.conversations.deleteThreads({ threadIds: [old.id], includeCurrent: false }, current.id, who);
    assert.equal(f.snapshots().length, 1);
    const kept = read(join(f.dir, 'snapshots', f.snapshots()[0]), 'SELECT id FROM assistant_threads', (r) => r.id);
    assert.ok(kept.includes(old.id), '快照里还有删掉的对话');
    assert.equal(f.store.db.prepare('SELECT 1 FROM assistant_threads WHERE id=?').get(old.id), undefined);
  } finally {
    manager.registry.close();
    built.close();
    settings.close();
    f.close();
  }
});

test('快照拍不成：删除和初始化整体不做，记录和数据都还在', (t) => {
  const f = tempStore('erp-snapshot-fail-');
  try {
    const customer = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构留下的客户' }));
    failSnapshots(t);
    const refused = /无法在操作前生成恢复快照，本次操作未执行/;
    assert.throws(
      () =>
        new DatabaseMaintenanceService(f.store).delete(
          { module: 'customers', items: [{ id: customer.id, version: customer.version }], requestId: randomUUID() },
          admin(),
          'session',
        ),
      refused,
    );
    assert.throws(() => new BusinessReset(f.store).execute({ scope: 'business' }, admin()), refused);
    assert.deepEqual(sales(f.store).customers(true).map((c) => c.name), ['虚构留下的客户']);
    assert.equal(f.store.db.isTransaction, false);
    assert.deepEqual(f.snapshots(), []);
  } finally {
    f.close();
  }
});

// ---------- 快照的复用、半截文件和保留 ----------

test('没有写入时复用上一份；有写入、其他连接写入后都重新拍', () => {
  const f = tempStore('erp-snapshot-reuse-');
  try {
    sales(f.store).createCustomer(customerSchema.parse({ name: '虚构客户甲' }));
    const first = snapped(f.store, 'first');
    assert.equal(snapshotBeforeDestructive(f.store, 'again'), first, '没有任何写入，复用');
    sales(f.store).createCustomer(customerSchema.parse({ name: '虚构客户乙' }));
    const second = snapped(f.store, 'after-write');
    assert.notEqual(second, first, '快照之后有写入，必须重新拍');
    assert.deepEqual(customerNames(second), ['虚构客户甲', '虚构客户乙']);
    assert.equal(snapshotBeforeDestructive(f.store, 'again'), second);
    const other = new DatabaseSync(f.store.path);
    other.exec("INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES('虚构其他连接客户','','','','',datetime('now'),datetime('now'))");
    other.close();
    const third = snapped(f.store, 'other-connection');
    assert.notEqual(third, second, '其他连接的提交也算写入');
    assert.ok(customerNames(third).includes('虚构其他连接客户'));
    assert.equal(f.snapshots().length, 3);
  } finally {
    f.close();
  }
});

test('事务里拍的快照不复用：事务提交后再拍一份包含提交内容的', () => {
  const f = tempStore('erp-snapshot-txreuse-');
  try {
    f.store.db.exec('SAVEPOINT outer_tx');
    sales(f.store).createCustomer(customerSchema.parse({ name: '虚构事务内客户' }));
    const inside = snapped(f.store, 'inside');
    f.store.db.exec('RELEASE outer_tx');
    const after = snapped(f.store, 'after');
    assert.notEqual(after, inside);
    assert.deepEqual(customerNames(inside), []);
    assert.deepEqual(customerNames(after), ['虚构事务内客户']);
  } finally {
    f.close();
  }
});

test('快照被改动或删掉就不复用；不是本程序命名的文件和 .partial 不会被当成快照', () => {
  const f = tempStore('erp-snapshot-files-');
  try {
    const dir = join(f.dir, 'snapshots');
    mkdirSync(dir);
    writeFileSync(join(dir, 'erp-old.sqlite'), '虚构的外来文件');
    writeFileSync(join(dir, `erp-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-abcdef-x.sqlite.partial`), '半截');
    const first = snapped(f.store, 'first');
    assert.ok(!first.endsWith('.partial') && !first.endsWith('erp-old.sqlite'));
    writeFileSync(first, '虚构的损坏内容');
    const second = snapped(f.store, 'second');
    assert.notEqual(second, first, '快照文件变了就重新拍');
    rmSync(second);
    const third = snapped(f.store, 'third');
    assert.notEqual(third, second);
    assert.equal(quickCheck(third), 'ok');
    assert.ok(existsSync(join(dir, 'erp-old.sqlite')), '外来文件不删');
  } finally {
    f.close();
  }
});

test('改名失败时删掉 .partial 并抛错，不留下半截快照', (t) => {
  const f = tempStore('erp-snapshot-partial-');
  try {
    failSnapshots(t);
    assert.throws(() => snapshotBeforeDestructive(f.store, 'fail'), /无法在操作前生成恢复快照，本次操作未执行.*虚构改名失败/);
    assert.deepEqual(f.snapshots(), []);
  } finally {
    f.close();
  }
});

test('保留策略：24 小时内全部保留，更早的按总数上限清理，外来文件不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-snapshot-prune-'));
  try {
    const now = Date.parse('2026-11-08T12:00:00.000Z');
    const name = (at: number, i: number, suffix = '') =>
      'erp-' + new Date(at).toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + i.toString(16).padStart(6, '0') + '-r.sqlite' + suffix;
    const recent = Array.from({ length: 25 }, (_, i) => name(now - (i + 1) * 60_000, i));
    for (const n of recent) writeFileSync(join(dir, n), 'x');
    writeFileSync(join(dir, 'erp-old.sqlite'), 'x');
    writeFileSync(join(dir, 'upgrade-2000-01-01T00-00-00-000Z-000000.sqlite'), 'x');
    assert.deepEqual(pruneSnapshots(dir, now), [], '一天内 25 份都保留，超过 20 份也不删');
    const old = Array.from({ length: 30 }, (_, i) => name(now - 2 * 86_400_000 - i * 60_000, 100 + i));
    for (const n of old) writeFileSync(join(dir, n), 'x');
    const stalePartial = name(now - 2 * 86_400_000, 999, '.partial'),
      freshPartial = name(now - 60_000, 998, '.partial');
    writeFileSync(join(dir, stalePartial), 'x');
    writeFileSync(join(dir, freshPartial), 'x');
    const removed = pruneSnapshots(dir, now);
    assert.deepEqual(new Set(removed), new Set([...old, stalePartial]), '总数已超上限，一天前的全部清掉');
    const left = readdirSync(dir);
    for (const n of [...recent, 'erp-old.sqlite', 'upgrade-2000-01-01T00-00-00-000Z-000000.sqlite', freshPartial])
      assert.ok(left.includes(n), n);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const few = Array.from({ length: 5 }, (_, i) => name(now - (i + 1) * 60_000, i));
    for (const n of [...few, ...old]) writeFileSync(join(dir, n), 'x');
    pruneSnapshots(dir, now);
    assert.equal(readdirSync(dir).length, 20, '最近 5 份 + 更早最新的 15 份');
    for (const n of [...few, ...old.slice(0, 15)]) assert.ok(existsSync(join(dir, n)), n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
