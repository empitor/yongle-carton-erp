import { pageActor } from './actor-fixture.js';
// 产品改了成品库存要跟着改（server/core/db.ts 的 registerProductStockSync），由采购库存模块登记，正式服务启动时一定会加载
import '../server/operations/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { productSchema } from '../shared/core/domain.js';
import { descendantIds, nestByFamily } from '../shared/business/product-family.js';

/** 产品附属关系（小箱套在大箱里）：只存一个“附属于哪个产品”，订单、价格、库存不受影响。全部虚构数据。 */
/** 不在本机的超级管理员模式；本机管理员是 localAdministratorActor(admin()) */
const admin = () => (pageActor({
  id: 'fictional-family-admin',
  name: '虚构管理员',
  permissions: ['business:edit'],
  role: 'super_admin' as const,
  superAdminMode: true,
  superAdminUntil: Date.now() + 600000,
}));
/** 本机管理员和不在本机的超级管理员模式各删一次：同一个删除引擎 */
const owners = () => [localAdministratorActor(admin()), admin()];
test('产品可以附属于另一个产品，能改能取消；不能附属自己，也不能绕成一圈', () => {
  const store = new Store(':memory:');
  const big = store.saveProduct(productSchema.parse({ name: '虚构大箱', priceExact: '5.0000' })),
    small = store.saveProduct(productSchema.parse({ name: '虚构小箱', parentProductId: big.id, priceExact: '1.2000' }));
  const saved = store.product(small.id);
  assert.ok(saved);
  assert.equal(saved.parentProductId, big.id);
  assert.equal(saved.priceExact, '1.2000', '价格各自独立');
  // 只改名称，不传附属关系时保留原来的
  const renamed = store.saveProduct(productSchema.parse({ name: '虚构小箱改名' }), small.id, small.version);
  assert.equal(renamed.parentProductId, big.id);
  assert.throws(
    () => store.saveProduct(productSchema.parse({ name: '虚构大箱', parentProductId: big.id }), big.id, big.version),
    /不能附属于自己/,
  );
  assert.throws(
    () => store.saveProduct(productSchema.parse({ name: '虚构大箱', parentProductId: small.id }), big.id, big.version),
    /绕成一圈/,
  );
  const cleared = store.saveProduct(
    productSchema.parse({ name: '虚构小箱改名', parentProductId: null }),
    small.id,
    renamed.version,
  );
  assert.equal(cleared.parentProductId ?? null, null, '取消附属');
});

test('列表按附属关系排：附属品紧跟在它附属的产品后面，原来的先后不变；附属的产品不在这一页时标出来', () => {
  const products = [
    { id: 1, name: '大箱' },
    { id: 2, name: '小箱甲', parentProductId: 1 },
    { id: 3, name: '别的箱' },
    { id: 4, name: '小箱乙', parentProductId: 1 },
    { id: 5, name: '小小箱', parentProductId: 2 },
  ];
  const parentOf = (id: number) => products.find((p) => p.id === id)?.parentProductId ?? null;
  const rows = [products[4], products[2], products[1], products[0], products[3]];
  const nested = nestByFamily(rows, (r) => r.id, parentOf);
  assert.deepEqual(
    nested.map((n) => [n.row.name, n.depth, n.last]),
    [
      ['别的箱', 0, false],
      ['大箱', 0, false],
      ['小箱甲', 1, false],
      ['小小箱', 2, true],
      ['小箱乙', 1, true],
    ],
  );
  const filtered = nestByFamily([products[1], products[2]], (r) => r.id, parentOf);
  assert.equal(filtered[0].parentOutside, 1, '大箱被筛掉了，小箱甲标“附属于 大箱”');
  assert.deepEqual([...descendantIds(products, 1)].sort(), [2, 4, 5], '编辑大箱时不能选它下面的产品');
});

test('删除被附属的产品：附属品去掉附属关系、照常能保存；本机和不在本机的超级管理员模式一样', () => {
  const family = () => {
    const store = new Store(':memory:');
    const big = store.saveProduct(productSchema.parse({ name: '虚构大箱' })),
      small = store.saveProduct(productSchema.parse({ name: '虚构小箱', parentProductId: big.id, priceExact: '1.2000' }));
    return { store, big, small };
  };
  const stillSavable = (store: Store, small: { id: number; version: number }, stale: number) => {
    const child = store.product(small.id);
    assert.ok(child);
    assert.equal(child.parentProductId, undefined, '附属关系去掉了');
    assert.equal(child.priceExact, '1.2000', '别的资料没动');
    assert.ok(child.version > stale, '附属品版本加一，删除前打开的编辑窗保存时提示刷新');
    assert.throws(
      () => store.saveProduct(productSchema.parse({ name: '虚构小箱', parentProductId: stale }), small.id, small.version),
      /已被其他页面修改/,
    );
    const renamed = store.saveProduct(productSchema.parse({ name: '虚构小箱改名' }), child.id, child.version);
    assert.equal(renamed.name, '虚构小箱改名');
    assert.equal(renamed.parentProductId ?? null, null);
    // 刷新以后编辑窗还带着已经删掉的附属编号：不拦，存成没有附属；从来没有过的编号照样拦下
    const again = store.saveProduct(
      productSchema.parse({ name: '虚构小箱改名', parentProductId: stale }),
      renamed.id,
      renamed.version,
    );
    assert.equal(again.parentProductId ?? null, null);
    assert.throws(
      () => store.saveProduct(productSchema.parse({ name: '虚构小箱', parentProductId: 99999 }), again.id, again.version),
      /附属的产品不存在/,
    );
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  };

  // 本机管理员、不在本机的超级管理员模式走同一个删除引擎：影响清单列出附属品“去掉附属关系”
  for (const owner of owners()) {
    const { store, big, small } = family(),
      service = new DatabaseMaintenanceService(store),
      selection = { module: 'products', items: [{ id: big.id, version: big.version }] },
      plan = service.preview(selection, owner);
    const entry = plan.impact.find((r) => r.table === 'products' && r.action === 'detach');
    assert.ok(entry);
    assert.deepEqual([entry.id, entry.name, entry.fields], [small.id, '虚构小箱', ['parent_product_id']]);
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test-binding');
    stillSavable(store, small, big.id);
  }
});

test('附属关系是真外键：被附属的产品不能直接删；大箱和附属品一起删，本机和不在本机的超级管理员模式都能删干净', () => {
  const family = () => {
    const store = new Store(':memory:');
    const big = store.saveProduct(productSchema.parse({ name: '虚构大箱' })),
      small = store.saveProduct(productSchema.parse({ name: '虚构小箱', parentProductId: big.id })),
      tiny = store.saveProduct(productSchema.parse({ name: '虚构小小箱', parentProductId: small.id })),
      other = store.saveProduct(productSchema.parse({ name: '虚构别的箱' }));
    return { store, big, small, tiny, other };
  };
  const left = (store: Store) =>
    store.db.prepare('SELECT name,parent_product_id AS parent FROM products ORDER BY id').all().map((r) => ({ ...r }));
  {
    const { store, big, small } = family();
    // 直接写库：删被附属的产品、附属自己、附属不存在的产品，都被库拦下
    assert.throws(() => store.db.prepare('DELETE FROM products WHERE id=?').run(big.id), /FOREIGN KEY/);
    assert.throws(() => store.db.prepare('UPDATE products SET parent_product_id=id WHERE id=?').run(small.id), /CHECK/);
    assert.throws(() => store.db.prepare('UPDATE products SET parent_product_id=99999 WHERE id=?').run(small.id), /FOREIGN KEY/);
    store.close();
  }
  // 本机管理员、不在本机的超级管理员模式走同一个删除引擎：大箱、小箱一起选，小小箱去掉附属关系
  for (const owner of owners()) {
    const { store, big, small, tiny } = family(),
      service = new DatabaseMaintenanceService(store),
      selection = { module: 'products', items: [big, small].map((p) => ({ id: p.id, version: p.version })) },
      plan = service.preview(selection, owner);
    assert.deepEqual(
      plan.impact.filter((r) => r.action === 'detach').map((r) => [r.table, r.id, r.fields]),
      [['products', tiny.id, ['parent_product_id']]],
    );
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test-binding');
    assert.deepEqual(left(store), [
      { name: '虚构小小箱', parent: null },
      { name: '虚构别的箱', parent: null },
    ]);
    const detached = store.product(tiny.id);
    assert.ok(detached);
    assert.ok(detached.version > tiny.version, '解除附属的产品版本加一');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    store.close();
  }
});
