// 库存品（server/operations/stock-items.ts、product-stock.ts、ledger.ts）：用过的不能改种类和关联产品，成品跟着产品，0 数量不记流水。
// 内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { count, many, one, rows as tableRows } from '../server/core/index.js';
import { orderSchema, productSchema, specification, type Product } from '../shared/core/domain.js';
import type { Order } from '../shared/core/order-view.js';
import { deliveryBlockers } from '../shared/business/warehouse-delivery.js';
import type { StockItemBaseView } from '../shared/business/index.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { createBusinessService } from '../server/business/service.js';
import { stockLedger } from '../server/operations/index.js';
import { businessFixture } from './flow-fixture.js';
import { saveDoc } from './receive-fixture.js';

/** businessFixture 加：item(编号) 读库存品，change(编号, 改的字段) 按现在的版本保存 */
function fixture() {
  const f = businessFixture();
  const items = (id?: number) => f.flow.views.items(true, id);
  const item = (id: number) => {
    const found = items(id).find((row) => row.id === id);
    assert.ok(found);
    return found;
  };
  const change = (id: number, patch: Record<string, unknown>) => {
    const now = item(id);
    return f.flow.stock.saveItem({ name: now.name, kind: now.kind, unit: now.unit, productId: now.productId, version: now.version, ...patch }, f.actor, id);
  };
  const productRow = (id: number): Product => {
    const found = f.store.product(id, true);
    assert.ok(found);
    return found;
  };
  const orderRow = (id: number): Order => {
    const found = f.store.order(id);
    assert.ok(found);
    return found;
  };
  const moves = () =>
    many(f.store.db, tableRows.stock_movements.pick({ id: true, item_id: true, delta_units: true, source_kind: true, source_id: true }), 'SELECT id,item_id,delta_units,source_kind,source_id FROM stock_movements ORDER BY seq');
  const revisions = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_movement_revisions');
  const lines = (doc: unknown) =>
    z
      .object({ lines: z.array(z.object({ stockId: z.number(), item: z.object({ unit: z.string() }), quantity: z.string() })) })
      .parse(doc).lines;
  return { ...f, item, items, change, productRow, orderRow, moves, revisions, lines };
}

const pick = (s: StockItemBaseView) => [s.name, s.length, s.width, s.height, s.dimensionUnit, s.material, s.flute, s.specification, s.notes];

test('已有出入库记录或被单据、采购明细引用的库存品不能改种类，本机管理员也不行；名称照常改，数量和流水不动', () => {
  const f = fixture();
  try {
    const { item, change, moves, revisions } = f;
    // 没用过的库存品：种类还能改，单位跟着种类
    const spare = f.ops.saveItem({ name: '虚构备用', kind: 'raw', unit: '张' }, f.actor);
    // 改成成品要挂一个还没有成品库存的产品（一个产品只有一个成品库存）
    const spareProduct = f.store.saveProduct(productSchema.parse({ name: '虚构备用纸箱' }));

    const turned = change(spare.id, { kind: 'finished', unit: '只', productId: spareProduct.id });
    assert.deepEqual([turned.kind, turned.unit], ['finished', '只']);

    // 原材料已有到货入库：改成成品等于把 3000 张当成 3000 只，拒绝
    const arrival = f.arrival('3000'), task = f.task('100');
    f.production(task.id, '100');
    const before = {
      raw: [item(f.raw.id).kind, item(f.raw.id).unit, item(f.raw.id).quantity],
      finished: [item(f.finished.id).kind, item(f.finished.id).unit, item(f.finished.id).quantity],
      moves: moves(),
      line: f.lines(f.flow.get(arrival.id, 'arrival')).map((l) => [l.stockId, l.item.unit, l.quantity]),
    };
    assert.deepEqual(before.raw, ['raw', '张', '2990']);
    assert.deepEqual(before.finished, ['finished', '只', '100']);
    assert.throws(
      () => change(f.raw.id, { kind: 'finished', unit: '只', productId: f.product.id }),
      /这个库存品已有出入库记录，不能改种类.*请新建一个库存品/,
    );
    // 成品已有完工入库：改成原材料同样拒绝
    assert.throws(
      () => change(f.finished.id, { kind: 'raw', unit: '张', productId: null }),
      /这个库存品已有出入库记录，不能改种类.*请新建一个库存品/,
    );
    assert.deepEqual(
      {
        raw: [item(f.raw.id).kind, item(f.raw.id).unit, item(f.raw.id).quantity],
        finished: [item(f.finished.id).kind, item(f.finished.id).unit, item(f.finished.id).quantity],
        moves: moves(),
        line: f.lines(f.flow.get(arrival.id, 'arrival')).map((l) => [l.stockId, l.item.unit, l.quantity]),
      },
      before,
      '被拒绝后库存品、流水和到货单明细都没变',
    );

    // 没有流水，只被采购明细引用
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-01',
        status: '已订货',
        lines: [{ stockItemId: f.glue.id, name: f.glue.name, quantity: '100', unit: '张', priceBasis: 'quantity' }],
      },
      f.actor,
    );
    assert.throws(
      () => change(f.glue.id, { kind: 'finished', unit: '只', productId: f.product.id }),
      /这个库存品已被单据或采购明细引用，不能改种类.*请新建一个库存品/,
    );
    assert.equal(f.flow.views.purchases(true, purchase.id)[0].lines[0].stockItemId, f.glue.id);

    // 没有流水，只被待入库的到货单引用
    const board = f.ops.saveItem({ name: '虚构待入库纸板', kind: 'raw', unit: '张' }, f.actor);
    const pending = saveDoc(f.flow, 
      'arrival',
      {
        date: '2026-10-27',
        supplierId: f.supplier.id,
        reference: '虚构待入库批次',
        lines: [{ stockId: board.id, item: { name: board.name, unit: '张' }, quantity: '500' }],
      },
      f.actor,
    );
    assert.throws(
      () => change(board.id, { kind: 'finished', unit: '只', productId: f.product.id }),
      /这个库存品已被单据或采购明细引用，不能改种类.*请新建一个库存品/,
    );
    assert.equal(f.flow.get(pending.id, 'arrival').lines[0].stockId, board.id);

    // 改名称不受影响：到货单明细和采购明细跟着改名，数量、流水不动，也不产生流水修订
    change(f.raw.id, { name: '虚构纸板改名' });
    change(f.glue.id, { name: '虚构衬板改名' });
    const line = f.flow.get(arrival.id, 'arrival').lines[0];
    assert.deepEqual([line.stockId, line.item.name, line.item.unit, line.quantity], [f.raw.id, '虚构纸板改名', '张', '3000']);
    assert.equal(f.flow.views.purchases(true, purchase.id)[0].lines[0].name, '虚构衬板改名');
    assert.deepEqual(moves(), before.moves);
    assert.equal(f.ops.balance(f.raw.id), 2990000);
    assert.equal(f.ops.balance(f.finished.id), 100000);
    assert.equal(revisions(), 0);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('成品已有出入库记录或被单据引用时不能改关联的产品，本机管理员也不行；没用过的照旧能改；成品不能不关联产品；这两条检查先于单位规则', () => {
  const f = fixture();
  try {
    const { item, change } = f;
    const other = f.store.saveProduct(productSchema.parse({ name: '虚构另一种纸箱' }));

    // 从没用过的成品：关联的产品照旧能改（改成的产品还没有成品库存），名称跟着新产品
    const third = f.store.saveProduct(productSchema.parse({ name: '虚构第三种纸箱' }));
    const spare = f.ops.saveItem({ name: '虚构备用成品', kind: 'finished', unit: '只', productId: third.id }, f.actor);
    const moved = change(spare.id, { productId: other.id });
    assert.deepEqual([moved.productId, moved.name], [other.id, '虚构另一种纸箱']);

    // 有完工入库的成品：换产品、去掉产品都拒绝；完工单、生产任务、订单状态一点没动
    f.arrival('3000');
    const task = f.task('100');
    const production = f.production(task.id, '100');
    const snapshot = () => ({
      productId: item(f.finished.id).productId,
      taskId: f.flow.get(production.id, 'production').taskId,
      completed: f.flow.get(task.id, 'task').completed,
      order: f.orderRow(f.order.id).status,
      revisions: count(f.store.db, 'SELECT count(*) AS n FROM stock_movement_revisions'),
    });
    const before = snapshot();
    assert.deepEqual([before.productId, before.taskId, before.completed], [f.product.id, task.id, '100']);
    const refused = /这个成品已有出入库记录，不能改关联的产品（以前的完工和出库都记在原来的产品上）；另一种产品的成品请新建一个库存品。/;
    assert.throws(() => change(f.finished.id, { productId: other.id }), refused);
    assert.throws(() => change(f.finished.id, { productId: null }), refused);
    assert.deepEqual(snapshot(), before, '被拒绝后完工单还挂着任务，订单状态不变');
    // 成品的名称、规格说明跟着产品，传别的不算数；备注照常能改
    const renamed = change(f.finished.id, { name: '虚构成品改名', specification: '虚构规格说明', notes: '虚构备注' });
    assert.deepEqual([renamed.name, renamed.specification, renamed.notes], ['虚构纸箱', specification(f.product), '虚构备注']);
    assert.deepEqual(snapshot(), before);

    // 没有流水、只被待送货的送货单引用的成品：同样拒绝（另一个产品、另一张订单，一个产品只有一个成品库存）
    const shipped = f.store.saveProduct(productSchema.parse({ name: '虚构待送货纸箱' })),
      free = f.store.saveProduct(productSchema.parse({ name: '虚构空着的纸箱' }));
    const shipOrder = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: [{ productId: shipped.id, quantity: 100, unit: '只', unitPriceCents: 100 }],
      }),
    );
    const waiting = f.ops.saveItem({ name: '虚构待送货成品', kind: 'finished', unit: '只', productId: shipped.id }, f.actor);
    const pending = saveDoc(f.flow, 
      'delivery',
      {
        date: '2026-10-27',
        customerId: f.customer.id,
        lines: [{ orderId: shipOrder.id, orderLineId: shipOrder.lines[0].id, stockId: waiting.id, quantity: '10' }],
      },
      f.actor,
    );
    assert.throws(
      () => change(waiting.id, { productId: free.id }),
      /这个成品已被单据或采购明细引用，不能改关联的产品.*请新建一个库存品。/,
    );
    assert.equal(f.flow.get(pending.id, 'delivery').lines[0].stockId, waiting.id);

    // 成品一定关联产品：不选产品不能建；改成别的已经有成品库存的产品也不行（就算这个成品没用过）
    assert.throws(
      () => f.ops.saveItem({ name: '虚构没关联产品的成品', kind: 'finished', unit: '只' }, f.actor),
      /成品库存要先选产品/,
    );
    const unused = f.ops.saveItem({ name: '虚构没用过的成品', kind: 'finished', unit: '只', productId: free.id }, f.actor);
    assert.throws(() => change(unused.id, { productId: f.product.id }), /产品“虚构纸箱”已经有成品库存“虚构纸箱”/);
    assert.equal(item(unused.id).productId, free.id);

    // 先后：用过的库存品，先说“不能改种类 / 不能改关联产品”，不用连单位一起改才看得到
    assert.throws(() => change(f.raw.id, { kind: 'finished', unit: '张', productId: f.product.id }), /这个库存品已有出入库记录，不能改种类/);
    assert.throws(() => change(f.finished.id, { productId: other.id, unit: '箱' }), refused);
    // 没用过的库存品照旧先过单位规则
    const blank = f.ops.saveItem({ name: '虚构没用过的纸板', kind: 'raw', unit: '张' }, f.actor);
    assert.throws(() => change(blank.id, { kind: 'finished', unit: '张', productId: f.product.id }), /数量单位只有“只”/);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('数量是 0 的出入库不记流水：写入前先拦住并说清原因，只有盘点可以记“数量没变”', () => {
  const f = fixture();
  try {
    f.arrival('100');
    const movementCount = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_movements');
    const before = movementCount();
    const movement = (action: string, delta: number) => ({
      stockId: f.raw.id,
      action,
      delta,
      before: 100000,
      after: 100000 + delta,
      sourceKind: 'manual',
      sourceId: null,
      date: '2026-10-28',
      notes: '虚构',
      actor: f.actor,
    });
    for (const action of ['in', 'out', 'purchase'])
      assert.throws(
        () => stockLedger.insertMovement(f.store, movement(action, 0)),
        /这笔出入库的数量是 0，不记流水；只有盘点可以记“数量没变”。请核对单据上的数量。/,
        action,
      );
    assert.equal(movementCount(), before, '被拦下的不进库，也不是靠数据库约束报错');
    // 盘点盘出来和账上一样：记一笔 0 的盘点流水
    const now = f.ops.items(true, f.raw.id)[0];
    f.flow.stock.move(
      f.raw.id,
      { expectedVersion: now.version, requestId: randomUUID(), action: 'adjust', quantity: '100', date: '2026-10-28', notes: '虚构盘点，数量没变', acknowledged: true },
      f.actor,
    );
    const last = one(
      f.store.db,
      tableRows.stock_movements.pick({ action: true, delta_units: true }),
      'SELECT action,delta_units FROM stock_movements ORDER BY seq DESC LIMIT 1',
    );
    assert.ok(last);
    assert.deepEqual([last.action, last.delta_units], ['adjust', 0]);
    assert.equal(f.ops.balance(f.raw.id), 100000);
  } finally {
    f.store.close();
  }
});

test('成品的名称、尺寸、材质、楞型、规格说明按产品；产品改了这几项（含加工要求），成品库存在同一事务里跟着改（版本加一、写审计），备注不动', () => {
  const f = fixture();
  try {
    const box = f.store.saveProduct(
      productSchema.parse({ name: '虚构彩箱', length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: 'K=K', flute: 'BE' }),
    );
    // 传进来的名称、尺寸、材质、楞型都不算数，按产品填；规格说明、备注是库存品自己的
    const stock = f.ops.saveItem(
      {
        name: '随便写的名字',
        kind: 'finished',
        unit: '只',
        productId: box.id,
        length: 1,
        width: 2,
        height: 3,
        dimensionUnit: 'cm',
        material: '乱写',
        flute: 'Z',
        specification: '虚构规格说明',
        notes: '虚构备注',
      },
      f.actor,
    );
    assert.deepEqual(pick(stock), ['虚构彩箱', 300, 200, 150, 'mm', 'K=K', 'BE', '300 × 200 × 150 mm / K=K / BE', '虚构备注']);
    const business = createBusinessService(f.store);
    const update = (patch: Partial<Product>) => {
      const p = f.productRow(box.id);
      return business.execute(
        { entity: 'products', action: 'update', id: box.id, input: { ...p, ...patch, version: p.version } },
        { source: 'manual-ui', operatorId: f.actor.id, actor: f.actor },
      );
    };
    const current = () => f.ops.items(true, stock.id)[0];
    const audits = () =>
      many(
        f.store.db,
        tableRows.business_audit.pick({ actor_id: true, action: true, document: true }),
        "SELECT actor_id,action,document FROM business_audit WHERE entity='stock_items' AND record_id=? AND action='update'",
        stock.id,
      )
        .map((r) => ({
          actor: r.actor_id,
          action: r.action,
          ...z
            .object({
              productId: z.number(),
              before: z.object({ name: z.string() }),
              after: z.object({ name: z.string() }),
            })
            .parse(JSON.parse(r.document) as unknown),
        }));
    // 只改价格：成品库存不动
    update({ priceExact: '1.2345' });
    assert.equal(current().version, stock.version);
    assert.equal(audits().length, 0);
    // 改名称、尺寸（换成厘米）、材质、楞型、加工要求：跟着改（规格说明由它们拼成），版本加一，审计记在改产品的人名下
    update({ name: '虚构彩箱（新版）', length: 31, width: 20, height: 15, dimensionUnit: 'cm', material: 'A=A', flute: 'B', requirements: '虚构印刷要求' });
    assert.deepEqual(pick(current()), ['虚构彩箱（新版）', 31, 20, 15, 'cm', 'A=A', 'B', '31 × 20 × 15 cm / A=A / B / 虚构印刷要求', '虚构备注']);
    assert.equal(current().version, stock.version + 1);
    const [trail] = audits();
    assert.deepEqual([trail.actor, trail.action, trail.productId, trail.before.name, trail.after.name], [f.actor.id, 'update', box.id, '虚构彩箱', '虚构彩箱（新版）']);
    // 同一个事务：成品库存改不成（这里用触发器造一次失败），产品也不改
    f.store.db.exec("CREATE TEMP TRIGGER stock_sync_failure BEFORE UPDATE ON stock_items BEGIN SELECT RAISE(ABORT,'虚构故障'); END");
    assert.throws(() => update({ name: '虚构不会存下的名字' }), /虚构故障/);
    f.store.db.exec('DROP TRIGGER stock_sync_failure');
    assert.equal(f.productRow(box.id).name, '虚构彩箱（新版）');
    assert.equal(current().name, '虚构彩箱（新版）');
    // 归档的成品库存也跟着改
    assert.ok(changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: stock.id, version: current().version }] }, f.actor).results[0].success);
    update({ flute: 'C' });
    assert.deepEqual([current().flute, current().archived], ['C', true]);
  } finally {
    f.store.close();
  }
});

test('产品改了尺寸，成品库存的规格说明跟着改；按新规格下的订单照常排送货，老订单明细还写着旧规格的被拦下，提示去核对这张订单', () => {
  const f = fixture();
  try {
    const box = f.store.saveProduct(
      productSchema.parse({ name: '虚构规格箱', length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: 'K=A', flute: 'B' }),
    );
    const stock = f.ops.saveItem({ name: '随便写', kind: 'finished', unit: '只', productId: box.id, specification: '随便写的规格' }, f.actor);
    assert.equal(stock.specification, '300 × 200 × 150 mm / K=A / B');
    const orderFor = (spec: string) =>
      f.store.saveOrder(
        orderSchema.parse({
          customerId: f.customer.id,
          orderDate: '2026-10-01',
          deliveryDate: '2026-10-30',
          status: '已确认',
          lines: [{ productId: box.id, productName: box.name, specification: spec, quantity: 100, unit: '只', unitPriceCents: 100 }],
        }),
      );
    const old = orderFor(specification(box));
    // 改产品的长：成品库存的规格说明同一事务里跟着变
    const p = f.productRow(box.id);
    createBusinessService(f.store).execute(
      { entity: 'products', action: 'update', id: box.id, input: { ...p, length: 310, version: p.version } },
      { source: 'manual-ui', operatorId: f.actor.id, actor: f.actor },
    );
    const now = f.ops.items(true, stock.id)[0];
    assert.equal(now.specification, '310 × 200 × 150 mm / K=A / B');
    assert.equal(now.specification, specification(f.productRow(box.id)));
    const fresh = orderFor(specification(f.productRow(box.id)));
    const deliver = (order: Order) =>
      saveDoc(f.flow, 
        'delivery',
        { date: '2026-10-27', customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '10' }] },
        f.actor,
      );
    // 按产品现在的规格下的订单照常排送货
    assert.equal(deliver(fresh).status, 'draft');
    // 老订单明细还写着旧规格：拦下，说清是订单明细要核对，不再让人去改成品库存
    assert.throws(
      () => deliver(old),
      /订单 \S+ 的“虚构规格箱”规格和产品现在的不一样，订单明细写的是 300 × 200 × 150 mm，产品现在是 310 × 200 × 150 mm，请核对这张订单的明细。/,
    );
    const [blocker] = deliveryBlockers(now, [f.orderRow(old.id)]);
    assert.ok(blocker);
    assert.equal(blocker.kind, 'spec');
    // 只说不一样的那一项（尺寸），材质、楞型一样就不写
    assert.equal(blocker.text, '规格和产品现在的不一样，订单明细写的是 300 × 200 × 150 mm，产品现在是 310 × 200 × 150 mm，请核对这张订单的明细');
    assert.deepEqual(deliveryBlockers(now, [f.orderRow(fresh.id)]), []);
  } finally {
    f.store.close();
  }
});

test('库存可用量扣掉待送货占用的，送出后变成实际库存；在途只算已订货还没到齐的', () => {
  const f = fixture();
  try {
    f.flow.stock.move(f.finished.id, { action: 'in', quantity: '100', date: '2026-10-01', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: f.finished.version }, f.actor);
    const draft = saveDoc(f.flow, 'delivery', { date: '2026-10-06', customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.finished.id, quantity: '80' }] }, f.actor);
    const units = () => [f.item(f.finished.id).balanceUnits, f.item(f.finished.id).reservedUnits, f.item(f.finished.id).availableUnits];
    assert.deepEqual(units(), [100000, 80000, 20000]);
    f.base.check(draft, {}, f.actor);
    assert.deepEqual(units(), [20000, 0, 20000]);
    for (const status of ['待订货', '已订货'])
      f.ops.savePurchase({ supplierId: f.supplier.id, orderDate: '2026-10-01', status, lines: [{ name: f.raw.name, stockItemId: f.raw.id, unit: '张', quantity: '50', priceBasis: 'quantity' }] }, f.actor);
    assert.equal(f.item(f.raw.id).onOrderUnits, 50000);
  } finally {
    f.store.close();
  }
});
