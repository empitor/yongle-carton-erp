// 成品库存按“每次完工”分批（server/flow/stock-batches.ts、shared/business/stock-batches.ts）：批次怎么算、估计还剩多少、批量取数。
// 批次备注、批次接口在 document-info.test.ts。数据全是虚构的，库在内存里。
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk, localAdmin } from './flow-fixture.js';
import { stockItemBatches } from '../server/flow/stock-batches.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { stockBatches, type BatchMovement } from '../shared/business/stock-batches.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { createBusinessService } from '../server/business/service.js';
import type { Order } from '../shared/core/order-view.js';
import type { Actor } from '../server/core/auth.js';
// 删除引擎要用到各模块登记的删除规则（和 tests/delete-rules.test.ts 一样先加载）
import '../server/import/index.js';

function setup() {
  const f = flowFixture();
  f.arrive('GYS-虚构-1', '1000');
  const orderA = f.order(1000),
    orderB = f.order(1000),
    orderC = f.order(1000);
  const task = (orderIds: number[]) =>
    f.task({ productId: f.product.id, quantity: '1000', unit: '只', orderIds, plannedDate: '2026-10-27' });
  const complete = (taskId: number, good: string, date: string, extra: Record<string, unknown> = {}) =>
    f.confirmId(
      f.draft('production', {
        date,
        taskId,
        productId: f.product.id,
        finishedStockId: f.finished.id,
        goodQuantity: good,
        operator: '虚构机长',
        materials: [{ stockId: f.raw.id, issued: '20', returned: '5' }],
        ...extra,
      }).id,
    );
  const ship = (order: Order, quantity: string) =>
    f.confirm('delivery', {
      customerId: f.customer.id,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity }],
    });
  const reverse = (doc: { id: number }, who: Actor = localAdmin()) =>
    f.flow.reverse(doc.id, { version: f.flow.get(doc.id).version, reason: '虚构：登记错了', acknowledged: true }, who);
  /** 本机管理员更正一张已生效的单据（correction.ts），返回替代单 */
  const correct = (doc: { id: number }, extra: Record<string, unknown>) => {
    const v = { expectedVersion: f.flow.get(doc.id).version, reason: '虚构：登记错了', ...extra },
      plan = planCorrection(f.store, doc.id, v, localAdmin());
    return f.flow.get(correctDocument(f.store, doc.id, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, localAdmin()).replacementId);
  };
  const batches = (all = false) => stockItemBatches(f.store, f.finished.id, { allDepleted: all });
  const balance = () => f.ops.balance(f.finished.id);
  return { ...f, orderA, orderB, orderC, task, complete, ship, reverse, correct, batches, balance };
}
/** 每块的“入库/剩余”：先列还有货的、再列已发完的，各自新的在前；顺带核对各批剩余之和等于实际库存 */
function shape(f: ReturnType<typeof setup>) {
  const r = f.batches(true);
  const all = [...r.open, ...r.depleted];
  const sum = all.reduce((n, b) => n + b.remainingUnits, 0);
  assert.equal(sum, f.balance(), '各批估计剩余加起来要等于实际库存');
  assert.equal(r.unmatchedUnits, 0);
  return all.map((b) => (b.kind === 'other' ? b.label + ' ' : '') + b.inQuantity + '/' + b.remaining);
}
const move = (f: ReturnType<typeof setup>, action: 'in' | 'out' | 'adjust', quantity: string) => {
  const it = f.ops.items(true, f.finished.id)[0];
  f.flow.stock.move(
    f.finished.id,
    { expectedVersion: it.version, requestId: randomUUID(), action, quantity, date: '2026-10-28', notes: '虚构手工', acknowledged: true },
    clerk,
  );
};

test('两次完工就是两批：日期、单号、任务、订单客户、用料、操作人、备注都带出来', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  const first = f.complete(t.id, '100', '2026-10-25', { notes: '这批用的进口纸，质量好' });
  const second = f.complete(t.id, '80', '2026-10-26');
  const r = f.batches();
  assert.equal(r.open.length, 2);
  assert.equal(r.depletedTotal, 0);
  const [newer, older] = r.open;
  assert.equal(newer.date, '2026-10-26');
  assert.equal(newer.documentId, second.id);
  assert.equal(newer.notes, '');
  assert.equal(older.date, '2026-10-25');
  assert.equal(older.number, first.number);
  assert.equal(older.inQuantity, '100');
  assert.equal(older.remaining, '100');
  assert.equal(older.taskId, t.id);
  assert.equal(older.taskNumber, t.number);
  assert.deepEqual(older.orders, [{ id: f.orderA.id, number: f.orderA.number, customerName: '虚构客户' }]);
  assert.deepEqual(
    older.materials.map((m) => [m.name, m.quantity]),
    [['虚构纸板', '15']],
    '实际用量 = 领料 20 − 退料 5',
  );
  assert.equal(older.operator, '虚构机长');
  assert.equal(older.notes, '这批用的进口纸，质量好');
  assert.equal(r.balance, '180');
  assert.equal(r.unit, '只');
});

test('送货先扣挂着同一张订单的那批；没有对应批次时先做先发', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  f.complete(ta.id, '100', '2026-10-25');
  f.complete(tb.id, '100', '2026-10-26');
  f.ship(f.orderB, '60');
  // 订单 B 的批次是后做的，也先扣它
  assert.deepEqual(shape(f), ['100/40', '100/100']);
  // 订单 C 没有对应批次：先做的先发
  f.ship(f.orderC, '30');
  assert.deepEqual(shape(f), ['100/40', '100/70']);
  // 订单 A 要 90，对应那批只剩 70，不够的按先做先发从别的批次扣
  f.ship(f.orderA, '90');
  assert.deepEqual(shape(f), ['100/20', '100/0']);
  const r = f.batches();
  assert.equal(r.open.length, 1);
  assert.equal(r.depletedTotal, 1);
  assert.equal(r.depleted[0].remaining, '0');
});

test('完工被撤销不算一批；送货被撤销等于没发过', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  f.complete(t.id, '100', '2026-10-25');
  const wrong = f.complete(t.id, '50', '2026-10-26');
  const delivery = f.ship(f.orderA, '40');
  assert.deepEqual(shape(f), ['50/50', '100/60']);
  f.reverse(wrong);
  assert.deepEqual(shape(f), ['100/60'], '撤销的完工和它的冲销成对抵掉');
  f.reverse(delivery, clerk);
  assert.deepEqual(shape(f), ['100/100'], '撤销的送货等于没发过');
  assert.equal(f.balance(), 100000);
});

test('撤销的完工抵掉后当时批次不够：欠着的从之后完工的批次里扣，合计仍等于实际库存', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  f.complete(t.id, '100', '2026-10-24');
  const wrong = f.complete(t.id, '50', '2026-10-25');
  f.ship(f.orderA, '120');
  f.complete(t.id, '100', '2026-10-26');
  f.reverse(wrong);
  assert.equal(f.balance(), 80000);
  assert.deepEqual(shape(f), ['100/80', '100/0']);
});

test('手工入库、盘点盘盈各算一条其他入库；手工出库、盘点盘亏先做先发', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  f.complete(t.id, '100', '2026-10-25');
  move(f, 'in', '30');
  // 完工批次排在前面，其他入库排在后面，不穿插
  assert.deepEqual(shape(f), ['100/100', '手动入库 30/30']);
  move(f, 'out', '110');
  assert.deepEqual(shape(f), ['手动入库 30/20', '100/0']);
  move(f, 'adjust', '35'); // 盘点：实际 35，比账上 20 多 15
  assert.deepEqual(shape(f), ['盘点盘盈 15/15', '手动入库 30/20', '100/0']);
  move(f, 'adjust', '5'); // 盘亏 30：先扣先入的
  assert.deepEqual(shape(f), ['盘点盘盈 15/5', '100/0', '手动入库 30/0']);
  move(f, 'adjust', '5'); // 数量没变的盘点不影响
  assert.deepEqual(shape(f), ['盘点盘盈 15/5', '100/0', '手动入库 30/0']);
  const r = f.batches();
  assert.equal(r.open.length, 1);
  assert.equal(r.open[0].kind, 'other');
  assert.equal(r.open[0].documentId, null);
});

test('原材料库存品不分批；不存在的库存品报找不到', () => {
  const f = setup();
  assert.throws(() => stockItemBatches(f.store, f.raw.id), /只有成品/);
  assert.throws(() => stockItemBatches(f.store, 99999), /不存在/);
  const r = stockItemBatches(f.store, f.finished.id);
  assert.deepEqual([r.open, r.depleted, r.depletedTotal], [[], [], 0]);
});

test('默认只给最近 20 个已发完的批次，depleted=all 给全部', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  for (let i = 0; i < 23; i++) f.complete(t.id, '10', '2026-10-' + String(1 + i).padStart(2, '0'));
  f.complete(t.id, '10', '2026-10-26');
  f.ship(f.orderA, '230');
  const r = f.batches();
  assert.equal(r.open.length, 1);
  assert.equal(r.depletedTotal, 23);
  assert.equal(r.depleted.length, 20);
  assert.equal(r.depleted[0].date, '2026-10-23', '已发完的新的在前');
  assert.equal(f.batches(true).depleted.length, 23);
});

/** 本机管理员删一张单据（删除引擎和数据管理同一个服务），库存处理选 preserve（库存不动）或 recalculate */
function removeDoc(f: ReturnType<typeof setup>, module: 'production' | 'delivery', id: number, inventoryPolicy: 'preserve' | 'recalculate' = 'preserve') {
  const service = new DatabaseMaintenanceService(f.store),
    owner = localAdmin();
  const selection = { module, items: [{ id, version: f.flow.get(id).version }], inventoryPolicy };
  const plan = service.preview(selection, owner);
  service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test');
}
/** 每块“日期 入库/剩余”，先列还有货的、再列已发完的；顺带核对各批剩余之和等于实际库存 */
const dated = (f: ReturnType<typeof setup>) => {
  shape(f);
  const r = f.batches(true);
  return [...r.open, ...r.depleted].map((b) => (b.kind === 'other' ? b.label + ' ' : '') + b.date + ' ' + b.inQuantity + '/' + b.remaining);
};

test('撤销过的完工单删掉、选库存不动：原单和冲销仍成对去掉，送货照旧扣原来那批，不多出“其他入库”', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  f.complete(t.id, '100', '2026-10-24');
  const x = f.complete(t.id, '100', '2026-10-25');
  f.ship(f.orderC, '50'); // 订单 C 没有对应批次：先做先发，扣 10-24 那批
  f.reverse(x);
  assert.deepEqual(dated(f), ['2026-10-24 100/50']);
  removeDoc(f, 'production', x.id);
  const kinds = f.store.db
    .prepare('SELECT DISTINCT source_kind FROM stock_movements WHERE item_id=? AND source_id IS NULL')
    .all(f.finished.id)
    .map((r) => r.source_kind);
  assert.deepEqual(kinds, ['database-maintenance'], '被删单据的入库和冲销都改成了系统维护');
  assert.deepEqual(dated(f), ['2026-10-24 100/50'], '仍是 A 剩 50，没有“其他入库 · 系统维护”');
  // 只删了、没撤销过的完工单：只有一笔入库改成系统维护，照旧列为其他入库
  const y = f.complete(t.id, '30', '2026-10-26');
  removeDoc(f, 'production', y.id);
  const r = f.batches(true);
  const other = [...r.open, ...r.depleted].find((b) => b.kind === 'other');
  assert.ok(other);
  assert.match(other.label, /系统维护/);
  assert.deepEqual([other.inQuantity, other.remaining, other.documentId], ['30', '30', null]);
  assert.deepEqual(dated(f), ['2026-10-24 100/50', other.label + ' 2026-10-26 30/30'], '其他入库排在完工批次后面');
});

test('撤销后重新登记（同一个生产任务）：新的一批顶替被撤销那批的位置，中间给同一订单的送货扣它', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  const a = f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  f.ship(f.orderA, '60'); // 实际发的是 A
  f.reverse(a); // A 登记错了
  const again = f.complete(ta.id, '90', '2026-10-26');
  assert.deepEqual(dated(f), ['2026-10-26 90/30', '2026-10-25 100/100'], 'A′ 剩 30、B 剩 100（不是 B 40、A′ 90）');
  const shown = f.batches().open[0];
  assert.deepEqual([shown.documentId, shown.number, shown.date, shown.inQuantity], [again.id, again.number, '2026-10-26', '90'], '显示的是新的那张');
});

test('本机管理员更正完工单、换到另一张生产任务：替代单顶替原来那批的位置', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]),
    ta2 = f.task([f.orderA.id]);
  const a = f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  f.ship(f.orderA, '60');
  const replacement = f.correct(a, { taskId: ta2.id, goodQuantity: '90', date: '2026-10-26' });
  assert.equal(replacement.correctionOf, a.id);
  assert.deepEqual(dated(f), ['2026-10-26 90/30', '2026-10-25 100/100']);
});

test('先登记对的、再撤销错的（新完工在撤销之前登记）：同样顶替；没有撤销时和以前一样', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  const a = f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  f.ship(f.orderA, '60');
  f.complete(ta.id, '90', '2026-10-26');
  assert.deepEqual(dated(f), ['2026-10-26 90/90', '2026-10-25 100/100', '2026-10-24 100/40']);
  f.reverse(a);
  // A′ 在撤销之前登记，也顶替 A 的位置：给订单 A 的 60 扣它，B 不动
  assert.deepEqual(dated(f), ['2026-10-26 90/30', '2026-10-25 100/100']);
});

test('同一任务本来两次正常完工、其中一次后来撤销又没重登：后一次顶替前一次的位置，合计等于实际库存', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  const first = f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  f.ship(f.orderC, '60'); // 不挂批次的订单：先做先发，扣 10-24 那批
  f.complete(ta.id, '100', '2026-10-26');
  f.ship(f.orderA, '30'); // 给订单 A：扣 10-24 那批
  assert.deepEqual(dated(f), ['2026-10-26 100/100', '2026-10-25 100/100', '2026-10-24 100/10']);
  f.reverse(first);
  // 10-26 那批站到 10-24 的位置：原来扣 10-24 的 60 和 30 都改扣它，B 不动
  assert.deepEqual(dated(f), ['2026-10-26 100/10', '2026-10-25 100/100']);
  assert.equal(f.balance(), 110_000);
});

test('先做的先发按完工日期：先登记 10-13、再补录 10-10，不挂订单的出库先扣 10-10 那批；界面也按完工日期排', () => {
  const f = setup();
  const t = f.task([f.orderA.id]);
  f.complete(t.id, '100', '2026-10-13');
  f.complete(t.id, '100', '2026-10-10'); // 补录一张更早的
  f.ship(f.orderC, '30');
  assert.deepEqual(dated(f), ['2026-10-13 100/100', '2026-10-10 100/70']);
  // 挂同一订单的送货也在对应批次里按完工日期先扣早的
  f.ship(f.orderA, '80');
  assert.deepEqual(dated(f), ['2026-10-13 100/90', '2026-10-10 100/0']);
});

test('其他入库说清来由：头部是类型，带出流水备注（原因）和登记人；用料分开给名称、材质、楞型和张数', () => {
  const f = setup();
  const board = f.base.raw({ name: '虚构BC五层纸板 1250×1000', material: 'K=A', flute: 'BC' });
  f.stockIn('50', board.id);
  const t = f.task([f.orderA.id]);
  f.complete(t.id, '100', '2026-10-25', { materials: [{ stockId: board.id, issued: '30', returned: '0' }] });
  move(f, 'in', '20');
  const r = f.batches();
  assert.deepEqual(
    r.open.map((b) => b.kind),
    ['batch', 'other'],
  );
  const [made, other] = r.open;
  assert.deepEqual(made.materials, [{ stockId: board.id, name: '虚构BC五层纸板 1250×1000', material: 'K=A', flute: 'BC', quantity: '30' }]);
  assert.equal(made.reason, '');
  assert.equal(made.operator, '虚构机长');
  assert.deepEqual([other.label, other.reason, other.operator, other.documentId], ['手动入库', '虚构手工', '虚构业务员', null]);
});

test('更正已出库的送货单再撤销替代单：批次跟着变，撤销后等于没发过', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  const d = f.ship(f.orderB, '60');
  assert.deepEqual(dated(f), ['2026-10-25 100/40', '2026-10-24 100/100']);
  const replacement = f.correct(d, { lines: [{ index: 0, quantity: '30' }] });
  assert.deepEqual(dated(f), ['2026-10-25 100/70', '2026-10-24 100/100']);
  f.reverse(replacement);
  assert.deepEqual(dated(f), ['2026-10-25 100/100', '2026-10-24 100/100']);
  assert.equal(f.balance(), 200_000);
});

test('更正已入库的完工单数量再撤销替代单：批次跟着改，撤销后这批不算，送货改从别的批次扣', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  const a = f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  f.ship(f.orderC, '30'); // 先做先发，扣 A
  assert.deepEqual(dated(f), ['2026-10-25 100/100', '2026-10-24 100/70']);
  const replacement = f.correct(a, { goodQuantity: '80' });
  assert.deepEqual(dated(f), ['2026-10-25 100/100', '2026-10-24 80/50']);
  f.reverse(replacement);
  assert.deepEqual(dated(f), ['2026-10-25 100/70']);
  assert.equal(f.balance(), 70_000);
});

test('一张送货单多行、同一库存品、不同订单：各扣各订单的批次，撤销后成对去掉', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  const d = f.confirm('delivery', {
    customerId: f.customer.id,
    lines: [f.orderA, f.orderB].map((o, i) => ({ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.finished.id, quantity: i ? '50' : '30' })),
  });
  assert.deepEqual(dated(f), ['2026-10-25 100/50', '2026-10-24 100/70']);
  f.reverse(d);
  assert.deepEqual(dated(f), ['2026-10-25 100/100', '2026-10-24 100/100']);
});

test('拆分送货单（出库改挂到新单）以后撤销其中一张：只加回那张的数量，另一张照旧', () => {
  const f = setup();
  const ta = f.task([f.orderA.id]),
    tb = f.task([f.orderB.id]);
  f.complete(ta.id, '100', '2026-10-24');
  f.complete(tb.id, '100', '2026-10-25');
  f.confirm('delivery', {
    customerId: f.customer.id,
    lines: [f.orderA, f.orderB].map((o, i) => ({ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.finished.id, quantity: i ? '50' : '30' })),
  });
  // 订单 A 换客户：送货单拆成两张，订单 A 那笔出库改挂到新单
  const who = localAdmin();
  const other = f.base.customer({ name: '虚构换来的客户' });
  const current = f.store.order(f.orderA.id);
  assert.ok(current);
  createBusinessService(f.store).execute(
    { entity: 'orders', action: 'update', id: current.id, input: { ...current, customerId: other.id } },
    { source: 'manual-ui', operatorId: who.id, superAdminMode: true, actor: who },
  );
  const deliveries = f.flow.list('delivery');
  assert.equal(deliveries.length, 2);
  const moved = deliveries.find((x) => x.customerId === other.id);
  assert.ok(moved);
  assert.deepEqual(dated(f), ['2026-10-25 100/50', '2026-10-24 100/70'], '拆分不改批次');
  f.reverse(moved);
  assert.deepEqual(dated(f), ['2026-10-25 100/50', '2026-10-24 100/100']);
  assert.equal(f.balance(), 150_000);
});

test('批量取数：查询次数和批次多少无关，不逐批查', () => {
  const count = (n: number) => {
    const f = setup();
    const t = f.task([f.orderA.id]),
      t2 = f.task([f.orderB.id, f.orderC.id]);
    for (let i = 0; i < n; i++) f.complete(i % 2 ? t.id : t2.id, '10', '2026-10-2' + (i % 5));
    const prepare = mock.method(f.store.db, 'prepare');
    try {
      const r = stockItemBatches(f.store, f.finished.id);
      assert.equal(r.open.length, n);
      assert.ok(r.open.every((b) => b.orders.length && b.materials.length));
    } finally {
      prepare.mock.restore();
    }
    return prepare.mock.callCount();
  };
  const few = count(2),
    many = count(8);
  assert.equal(few, many);
  assert.ok(many <= 6, '库存品、流水、完工单、任务、订单客户、原材料各一次：' + many);
});

test('推算函数：配不上原单的冲销按普通出入库算，算不平时如实给差额', () => {
  let seq = 0;
  const m = (delta: number, sourceKind: string, sourceId: string | null = null, orderId: number | null = null): BatchMovement => ({
    id: 'm' + ++seq,
    seq,
    createdAt: '2026-10-01T00:00:0' + seq + '.000Z',
    date: '2026-10-01',
    delta,
    action: delta > 0 ? 'in' : 'out',
    sourceKind,
    sourceId,
    orderId,
  });
  const production = new Map([['1', { orderIds: [7] }]]);
  // 冲销数量对不上原单：不成对抵掉，冲销扣回当普通出库
  const r = stockBatches([m(100000, 'flow_production', '1'), m(-40000, 'flow_reversal', '1')], production);
  assert.deepEqual(
    r.entries.map((e) => [e.kind, e.inUnits, e.remainingUnits]),
    [['batch', 100000, 60000]],
  );
  assert.equal(r.unmatchedUnits, 0);
  // 流水本身结余为负（数据库不允许，这里只验证兜底）：不硬凑，差额如实给出
  seq = 0;
  const bad = stockBatches([m(10000, 'manual'), m(-30000, 'manual')], new Map());
  assert.equal(bad.balanceUnits, -20000);
  assert.equal(bad.remainingUnits, 0);
  assert.equal(bad.unmatchedUnits, -20000);
});
