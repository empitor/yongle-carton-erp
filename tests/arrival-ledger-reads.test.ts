// 按范围读的结果（server/flow/rules/arrivals.ts、daily.ts、receipt-events.ts，server/overview/workbench.ts、related-business.ts、dashboard.ts）：
// 到货记录按日期、供应商、记录编号、采购单筛；仓库台账的日历计数和按天、全部列的记录；工作台、关联面板、只重算相关采购单。
// 期望值都按下面的虚构数据手算写死。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { many, rows } from '../server/core/index.js';
import { WarehouseDaily } from '../server/flow/index.js';
import { arrivalPurchaseIds, receiptEvents, syncReceivedUnits } from '../server/flow/rules/receipt-events.js';
import { buildWorkbench } from '../server/overview/workbench.js';
import { relatedBusiness } from '../server/overview/related-business.js';
import { buildDashboard } from '../server/overview/dashboard.js';
import type { WarehouseDailyResult } from '../shared/business/index.js';
import { clerk, flowFixture } from './flow-fixture.js';
import { archiveDoc, orderedPurchase, saveDoc } from './receive-fixture.js';

/**
 * 供应商甲的采购单 p1（1000 张）、供应商乙的 p2（500 张）、供应商甲的 p3（200 张），都买 f.raw：
 * a1 甲 10-10 到 100 张；a2 甲 10-11 待入库 50 张；a3 乙 10-11 到 30 张；a4 甲 10-12 到 20 张后归档；a5 乙 10-12 待入库 10 张后取消。
 * 成品期初 100 只（10-20）；送货 d1 计划 10-21、10-22 出库 10 只；d2 计划 10-22 待送货 5 只；d3 计划 10-23、10-22 出库 3 只后撤销。
 * 生产任务 t1 计划 10-28 共 10 只（完工 4 只），t2 计划 10-27 共 20 只。
 */
function world() {
  const f = flowFixture();
  const s2 = f.ops.saveSupplier({ name: '虚构供应商乙' }, clerk);
  const p1 = orderedPurchase(f, clerk),
    p2 = orderedPurchase({ ...f, supplier: s2 }, clerk, ['500']),
    p3 = orderedPurchase(f, clerk, ['200']);
  const a1 = p1.receive('100', '虚构送货-甲1', { date: '2026-10-10' }).arrival,
    a2 = p1.receive('50', '虚构送货-甲2', { date: '2026-10-11', pending: true }).arrival,
    a3 = p2.receive('30', '虚构送货-乙1', { date: '2026-10-11' }).arrival,
    a4 = p1.receive('20', '虚构送货-甲3', { date: '2026-10-12' }).arrival,
    a5 = p2.receive('10', '虚构送货-乙2', { date: '2026-10-12', pending: true }).arrival;
  archiveDoc(f.flow, a4.id, false, clerk, f.flow.get(a4.id).version);
  f.flow.cancel(a5.id, { version: f.flow.get(a5.id).version, reason: '虚构取消', acknowledged: true }, clerk);
  return { ...f, s2, p1, p2, p3, a1, a2, a3, a4, a5 };
}
type World = ReturnType<typeof world>;

/** 在 world 上加送货、生产任务和一张完工 */
function withShipping(w: World) {
  w.stockIn('100');
  const order = w.order(100);
  const delivery = (date: string, plannedDate: string, quantity: string) =>
    saveDoc(w.flow, 'delivery', { date, plannedDate, customerId: w.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: w.finished.id, quantity }] }, clerk);
  const d1 = delivery('2026-10-22', '2026-10-21', '10');
  w.confirmId(d1.id, { shipDate: '2026-10-22' });
  const d2 = delivery('2026-10-22', '2026-10-22', '5');
  const d3 = delivery('2026-10-22', '2026-10-23', '3');
  w.confirmId(d3.id, { shipDate: '2026-10-22' });
  w.flow.reverse(d3.id, { version: w.flow.get(d3.id).version, reason: '虚构发重了', acknowledged: true }, clerk);
  const task = (quantity: string, plannedDate: string) =>
    w.task({ productId: w.product.id, quantity, unit: '只', orderIds: [order.id], plannedDate });
  const t1 = task('10', '2026-10-28'),
    t2 = task('20', '2026-10-27');
  const production = w.confirm('production', {
    date: '2026-10-28',
    taskId: t1.id,
    productId: w.product.id,
    finishedStockId: w.finished.id,
    goodQuantity: '4',
    scrapQuantity: '0',
    operator: '虚构机长',
    materials: [{ stockId: w.raw.id, issued: '1', returned: '0' }],
  });
  return { order, d1, d2, d3, t1, t2, production };
}

/** 台账结果里的单据编号：到货按到货单编号，送货、生产任务按单据编号 */
function docIds(result: WarehouseDailyResult<unknown>) {
  if (result.kind === 'arrival') return result.records.map((r) => r.flowId);
  const records: readonly { id: number }[] = result.records;
  return records.map((r) => r.id);
}

test('到货记录按日期、供应商、记录编号、采购单筛：默认连待入库、取消的也列，归档的不列，新的在前', () => {
  const w = world();
  try {
    const ids = (raw: Record<string, unknown>) => w.flow.arrivalRecords(raw).map((r) => r.flowId);
    assert.deepEqual(ids({}), [w.a5.id, w.a3.id, w.a2.id, w.a1.id]);
    assert.deepEqual(ids({ includeInactive: false }), [w.a3.id, w.a1.id], '只要有效的');
    assert.deepEqual(ids({ date: '2026-10-11' }), [w.a3.id, w.a2.id]);
    assert.deepEqual(ids({ supplierId: w.s2.id }), [w.a5.id, w.a3.id]);
    assert.deepEqual(ids({ purchaseId: w.p1.purchase.id }), [w.a2.id, w.a1.id]);
    assert.deepEqual(ids({ purchaseId: w.p2.purchase.id, includeInactive: false }), [w.a3.id]);
    assert.deepEqual(ids({ receiptId: 'flow-' + w.a1.id }), [w.a1.id]);
    assert.deepEqual(ids({ receiptId: 'flow-' + w.a4.id }), [], '归档的按编号也不列');
    assert.deepEqual(ids({ receiptId: 'flow-999999' }), []);
  } finally {
    w.store.close();
  }
});

test('到货台账：日历只数有效到货的到货日；按天列到货日在这天的和登记在这天的待入库，取消、归档的不列；全部看列出没归档的', () => {
  const w = world();
  try {
    const daily = new WarehouseDaily(w.store);
    const counts = { '2026-10-10': { planned: 0, completed: 1, pending: 0, total: 1 }, '2026-10-11': { planned: 0, completed: 1, pending: 0, total: 1 } };
    const day = daily.get({ kind: 'arrival', date: '2026-10-11' });
    assert.deepEqual([docIds(day), day.summary, day.counts], [[w.a3.id, w.a2.id], { planned: 0, completed: 1, pending: 0 }, counts]);
    const later = daily.get({ kind: 'arrival', date: '2026-10-12' });
    assert.deepEqual([docIds(later), later.summary], [[], { planned: 0, completed: 0, pending: 0 }]);
    const all = daily.get({ kind: 'arrival', date: '2026-10-11', scope: 'all' });
    assert.deepEqual([docIds(all), all.counts], [[w.a5.id, w.a3.id, w.a2.id, w.a1.id], counts]);
  } finally {
    w.store.close();
  }
});

test('送货台账：计划日、出库日各自归属，撤销的不算但它的计划日照样占一格（全是 0）；生产任务只按计划日列', () => {
  const w = world(),
    s = withShipping(w);
  try {
    const daily = new WarehouseDaily(w.store);
    const counts = {
      '2026-10-21': { planned: 1, completed: 0, pending: 0, total: 1 },
      '2026-10-22': { planned: 1, completed: 1, pending: 1, total: 2 },
      '2026-10-23': { planned: 0, completed: 0, pending: 0, total: 0 },
    };
    const day = daily.get({ kind: 'delivery', date: '2026-10-22' });
    assert.deepEqual([docIds(day), day.summary, day.counts], [[s.d2.id, s.d1.id], { planned: 1, completed: 1, pending: 1 }, counts]);
    const planned = daily.get({ kind: 'delivery', date: '2026-10-21' });
    assert.deepEqual([docIds(planned), planned.summary], [[s.d1.id], { planned: 1, completed: 0, pending: 0 }]);
    assert.deepEqual(docIds(daily.get({ kind: 'delivery', date: '2026-10-22', scope: 'all' })).sort(), [s.d1.id, s.d2.id, s.d3.id].sort());
    assert.ok(day.kind === 'delivery');
    assert.deepEqual(day.records.map((r) => [r.customerName, r.lines[0].quantity]), [['虚构客户', '5'], ['虚构客户', '10']]);
    // 今日页只读待送货、本月出库、计划在这天的（撤销的 d3 不在），不带流水；完整的台账带
    const forToday = daily.records('delivery', '2026-10-22');
    assert.deepEqual(forToday.map((d) => d.id).sort((x, y) => x - y), [s.d1.id, s.d2.id]);
    assert.deepEqual(forToday.flatMap((d) => d.lines.flatMap((l) => l.movements)), []);
    assert.equal(daily.records('delivery').find((d) => d.id === s.d1.id)?.lines[0].movements.length, 1);
    // 生产任务 t1 单据日期是 10-27、计划 10-28：只在计划那天列
    assert.deepEqual(docIds(daily.get({ kind: 'task', date: '2026-10-28' })), [s.t1.id]);
    assert.deepEqual(docIds(daily.get({ kind: 'task', date: '2026-10-28', scope: 'all' })), [s.t1.id]);
    assert.deepEqual(docIds(daily.get({ kind: 'task', date: '2026-10-27' })), [s.t2.id]);
  } finally {
    w.store.close();
  }
});

test('点开一张（doc）：已归档的到货单、送货单按编号也读得到验收入库和流水；列表照旧不带已归档的', () => {
  const w = world(),
    s = withShipping(w);
  try {
    archiveDoc(w.flow, s.d1.id, false, clerk, w.flow.get(s.d1.id).version);
    const daily = new WarehouseDaily(w.store);
    const arrival = daily.get({ kind: 'arrival', doc: w.a4.id });
    assert.ok(arrival.kind === 'arrival');
    assert.deepEqual(
      arrival.records.map((r) => [r.flowId, r.inspectionStatus, r.inventoryStatus, r.lines[0].movements.length]),
      [[w.a4.id, '全部合格', '已入库', 1]],
    );
    const delivery = daily.get({ kind: 'delivery', doc: s.d1.id });
    assert.ok(delivery.kind === 'delivery');
    assert.deepEqual(delivery.records.map((r) => [r.id, r.lines[0].movements.length]), [[s.d1.id, 1]]);
    assert.ok(!docIds(daily.get({ kind: 'arrival', date: '2026-10-12', scope: 'all' })).includes(w.a4.id));
    assert.ok(!docIds(daily.get({ kind: 'delivery', date: '2026-10-22', scope: 'all' })).includes(s.d1.id));
    assert.throws(() => daily.get({ kind: 'task', doc: s.t1.id }), /只有到货单、送货单/);
    // 在用的也一样：只回这一张
    const own = (kind: 'arrival' | 'delivery', doc: number) => docIds(daily.get({ kind, doc }));
    assert.deepEqual(own('arrival', w.a1.id), [w.a1.id]);
    assert.deepEqual(own('delivery', s.d2.id), [s.d2.id]);
    // 种类不对、编号不存在：报 404 说清楚，不回空列表
    assert.throws(() => daily.get({ kind: 'arrival', doc: s.d2.id }), (e: unknown) => e instanceof Error && 'status' in e && e.status === 404 && /是送货单，不是到货单/.test(e.message));
    assert.throws(() => daily.get({ kind: 'delivery', doc: 999999 }), /没有编号 999999 的单据/);
  } finally {
    w.store.close();
  }
});

test('工作台按天数：待入库、待送货不分日期，当天到货、入库流水、出库、计划的生产任务按这天；首页可以不带工作台，助手的概览带上', () => {
  const w = world();
  withShipping(w);
  try {
    const base = { toOrder: 0, pendingArrivals: 1, activeTasks: 2, productionToday: 0, pendingDeliveries: 1 };
    const expected = {
      '2026-10-11': { ...base, date: '2026-10-11', arrivalsToday: 1, stockedToday: 1, tasksToday: 0, deliveriesToday: 0 },
      '2026-10-22': { ...base, date: '2026-10-22', arrivalsToday: 0, stockedToday: 0, tasksToday: 0, deliveriesToday: 1 },
      '2026-10-27': { ...base, date: '2026-10-27', arrivalsToday: 0, stockedToday: 0, tasksToday: 1, deliveriesToday: 0 },
      '2026-10-28': { ...base, date: '2026-10-28', arrivalsToday: 0, stockedToday: 0, tasksToday: 1, deliveriesToday: 0, productionToday: 1 },
    };
    for (const [date, want] of Object.entries(expected)) assert.deepEqual(buildWorkbench(w.store, date), want, date);
    const range = { start: '2026-10-01', end: '2026-10-31' };
    const plain = buildDashboard(w.store, [], range, '2026-10-22', { workbench: false });
    assert.equal('workbench' in plain.overview, false);
    const withWorkbench = buildDashboard(w.store, [], range, '2026-10-22');
    assert.deepEqual(withWorkbench.overview.workbench, expected['2026-10-22']);
    const { workbench: _workbench, ...rest } = withWorkbench.overview;
    assert.deepEqual(rest, plain.overview, '除了工作台，别的一样');
  } finally {
    w.store.close();
  }
});

test('订单、采购单的关联面板：完工、成品库存、生产进度、到货（归档的不列）、订的库存品；编号不存在是 null', () => {
  const w = world(),
    s = withShipping(w);
  try {
    const order = relatedBusiness(w.store, 'orders', s.order.id);
    assert.ok(order);
    assert.deepEqual(order.productions.map((p) => p.id), [s.production.id]);
    assert.deepEqual(order.stocks.map((x) => x.id), [w.finished.id]);
    assert.deepEqual(order.deliveries.map((d) => d.id).sort(), [s.d1.id, s.d2.id, s.d3.id].sort(), '撤销的送货单也列');
    assert.deepEqual(order.marks, []);
    assert.deepEqual(
      order.production.map((p) => [p.id, p.planned, p.completed, p.progress]).sort(),
      [[s.t1.id, '10', '4', 40], [s.t2.id, '20', '0', 0]].sort(),
    );
    assert.equal(relatedBusiness(w.store, 'orders', 999999), null);
    const purchase = relatedBusiness(w.store, 'purchases', w.p1.purchase.id);
    assert.ok(purchase);
    assert.deepEqual(purchase.arrivals.map((a) => a.flowId), [w.a2.id, w.a1.id]);
    assert.deepEqual(purchase.stocks.map((x) => x.id), [w.raw.id]);
    assert.deepEqual(purchase.orders, []);
    assert.equal(relatedBusiness(w.store, 'purchases', 999999), null);
  } finally {
    w.store.close();
  }
});

test('只重算指定采购单的已到货：跨单到货算出两张采购单，按到货单编号读事件按编号排；改坏两张的缓存，只修好指定的那张', () => {
  const w = world();
  try {
    const item = { name: w.raw.name, unit: '张' };
    const line = (p: { purchase: { lines: { id: number }[] } }, quantity: string) => ({ stockId: w.raw.id, purchaseLineId: p.purchase.lines[0].id, item, quantity });
    const cross = saveDoc(w.flow, 'arrival', { date: '2026-10-13', supplierId: w.supplier.id, reference: '虚构跨单-' + randomUUID(), lines: [line(w.p1, '10'), line(w.p3, '15')] }, clerk);
    w.confirmId(cross.id);
    assert.deepEqual(arrivalPurchaseIds(w.store, [cross.id]).sort(), [w.p1.purchase.id, w.p3.purchase.id].sort());
    assert.deepEqual(arrivalPurchaseIds(w.store, [null, undefined]), []);
    assert.deepEqual(receiptEvents(w.store, undefined, { arrivalIds: [w.a3.id, w.a1.id] }).map((e) => e.flowId), [w.a1.id, w.a3.id]);
    assert.deepEqual(receiptEvents(w.store, undefined, { arrivalIds: [] }), []);
    // 已到货缓存（千分整数，明细按 p1、p2、p3 的顺序）：p1 = 100 + 20（归档不影响已到货）+ 10，待入库的不算；p2 = 30，取消的不算；p3 = 15
    const cached = () =>
      many(w.store.db, rows.purchase_lines.pick({ received_units: true }), 'SELECT received_units FROM purchase_lines ORDER BY id').map((r) => r.received_units);
    assert.deepEqual(cached(), [130000, 30000, 15000]);
    w.store.db.prepare('UPDATE purchase_lines SET received_units=received_units+1000 WHERE purchase_id IN (?,?)').run(w.p1.purchase.id, w.p2.purchase.id);
    syncReceivedUnits(w.store, false, [w.p1.purchase.id]);
    assert.deepEqual(cached(), [130000, 31000, 15000], '只修好 p1');
    syncReceivedUnits(w.store);
    assert.deepEqual(cached(), [130000, 30000, 15000]);
  } finally {
    w.store.close();
  }
});
