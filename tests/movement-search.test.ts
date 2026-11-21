// 库存流水的查询（server/operations/movements.ts、router.ts 的流水列表，server/business/dashboard.ts 的最近流水）：
// 关键词查名称、算出来的规格、材质、备注（不分大小写）、采购单号；日期范围、分页、计数、汇总；接口的统计带上有匹配流水的库存品。
// 期望值都按下面的虚构数据手算写死。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { createApp } from '../server/app.js';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/service.js';
import { buildDashboard } from '../server/business/dashboard.js';
import type { MovementFilters } from '../shared/business/index.js';
import { pageActor } from './actor-fixture.js';
import { listen } from './http-fixture.js';
import { receiveLines } from './receive-fixture.js';

const actor = pageActor({ id: 'movement-search', name: '虚构仓管', permissions: ['business:edit'] });

/**
 * 纸板甲（100×80cm、K=A）、纸板乙（100×60cm、B=B）。流水按业务日期：
 * 10-05 甲到货 +10（采购单到货）；10-06 乙手工入库 +7“虚构盘盈 Ａ”（被管理员改写过一次）；10-07 甲手工出库 -3；10-08 乙手工入库 +2。
 */
function world() {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const board = (name: string, width: number, material: string) =>
    ops.saveItem({ name, kind: 'raw', unit: '张', length: 100, width, dimensionUnit: 'cm', material, flute: 'BC' }, actor);
  const a = board('虚构五层纸板', 80, 'K=A'),
    b = board('虚构三层纸板', 60, 'B=B');
  const supplier = ops.saveSupplier({ name: '虚构纸板厂' }, actor);
  const purchase = ops.savePurchase(
    { supplierId: supplier.id, status: '已订货', orderDate: '2026-10-01', lines: [{ ...a, stockItemId: a.id, quantity: '100', unitPrice: '1', priceBasis: 'quantity' }] },
    actor,
  );
  const arrival = receiveLines(store, purchase.id, { date: '2026-10-05', items: [{ lineId: purchase.lines[0].id, quantity: '10' }] }, actor).arrival;
  const move = (id: number, action: 'in' | 'out', quantity: string, date: string, notes: string) => {
    const item = ops.items(true, id)[0];
    return flow.stock.move(id, { expectedVersion: item.version, requestId: randomUUID(), action, quantity, date, notes, acknowledged: true }, actor).movementId;
  };
  const gain = move(b.id, 'in', '7', '2026-10-06', '虚构盘盈 Ａ');
  move(a.id, 'out', '3', '2026-10-07', '虚构领用');
  move(b.id, 'in', '2', '2026-10-08', '虚构补录');
  store.db
    .prepare('INSERT INTO stock_movement_revisions(movement_id,item_id,at,actor_id,actor_name,reason,before_document,after_document) VALUES(?,?,?,?,?,?,?,?)')
    .run(gain, b.id, new Date().toISOString(), actor.id, actor.name, '虚构修订', '{}', null);
  return { store, ops, flow, a, b, purchase, arrival, move };
}

test('流水关键词查名称、算出来的规格、材质、备注（不分大小写）、采购单号；日期范围、分页、计数、汇总、库存品都按同一筛选', () => {
  const w = world();
  try {
    const repo = w.ops;
    const signed = (q: MovementFilters, page?: { offset: number; limit: number }) => repo.movements(q, page).map((m) => [m.itemName, m.direction + m.delta]);
    const A = '虚构五层纸板',
      B = '虚构三层纸板';
    assert.deepEqual(signed({}), [[B, '+2'], [A, '-3'], [B, '+7'], [A, '+10']], '业务日期新的在前');
    assert.deepEqual(signed({ q: '五层' }), [[A, '-3'], [A, '+10']]);
    assert.deepEqual(signed({ q: '100 × 60' }), [[B, '+2'], [B, '+7']], '规格没填时按尺寸算出来的查');
    assert.deepEqual(signed({ q: 'k=a' }), [[A, '-3'], [A, '+10']], '材质不分大小写');
    assert.deepEqual(signed({ q: '盘盈 ａ' }), [[B, '+7']], '备注里的全角字母也不分大小写');
    assert.deepEqual(signed({ q: w.purchase.number.toLowerCase() }), [[A, '+10']], '采购单号');
    assert.deepEqual(signed({ start: '2026-10-06', end: '2026-10-07' }), [[A, '-3'], [B, '+7']]);
    assert.deepEqual(signed({ kind: 'raw', start: '2026-10-07' }), [[B, '+2'], [A, '-3']]);
    assert.deepEqual(signed({ q: '纸板' }, { offset: 1, limit: 2 }), [[A, '-3'], [B, '+7']], '有关键词的分页');
    assert.equal(repo.movementCount({ q: '纸板', start: '2026-10-06' }), 3);
    assert.deepEqual(repo.movementPage({ itemId: w.b.id }, 1, 1).totals.map((r) => [r.item_id, r.delta_units]).sort(), [[w.b.id, 2000], [w.b.id, 7000]]);
    assert.deepEqual([...repo.movementItemIds({ q: '盘盈' })], [w.b.id]);
    assert.deepEqual([...repo.movementItemIds({ start: '2026-10-07' })].sort(), [w.a.id, w.b.id].sort());
  } finally {
    w.store.close();
  }
});

test('流水带上来源单据的单号和种类、采购单号、改写次数；手工流水没有来源单据', () => {
  const w = world();
  try {
    const rows = w.flow.views.movements().map((m) => [m.notes, m.flowKind, m.flowNumber, m.purchaseNumber, m.revisionCount]);
    assert.deepEqual(rows.slice(0, 3), [
      ['虚构补录', undefined, undefined, null, 0],
      ['虚构领用', undefined, undefined, null, 0],
      ['虚构盘盈 Ａ', undefined, undefined, null, 1],
    ]);
    assert.deepEqual(rows[3].slice(1), ['arrival', w.arrival.number, w.purchase.number, 0]);
  } finally {
    w.store.close();
  }
});

/** 带统计的流水列表回答里测试要看的几项 */
const listing = z.object({
  rows: z.array(z.object({ itemName: z.string(), notes: z.string(), date: z.string() })),
  filteredRecords: z.number(),
  totalRecords: z.number(),
  page: z.number().optional(),
  metrics: z.array(z.object({ itemId: z.number(), incoming: z.string(), outgoing: z.string(), currentQuantity: z.string() })),
});

test('流水接口：统计只算筛出来的流水，总数是全部流水；关键词带上有匹配流水（不限日期）的库存品；页码超出落到最后一页，排序参数不起作用', async () => {
  const w = world();
  const server = await listen(createApp(w.store));
  const get = async (query: Record<string, string>) => {
    const r = await fetch(server.origin + '/api/warehouse/movements?' + new URLSearchParams(query));
    assert.equal(r.status, 200);
    const body: unknown = await r.json();
    return body;
  };
  /** 统计按库存品编号排（甲先建） */
  const metrics = (body: z.output<typeof listing>) =>
    body.metrics.toSorted((x, y) => x.itemId - y.itemId).map((m) => [m.itemId, m.incoming, m.outgoing, m.currentQuantity]);
  try {
    const ranged = listing.parse(await get({ withMetrics: '1', start: '2026-10-07', end: '2026-10-08' }));
    assert.deepEqual([ranged.filteredRecords, ranged.totalRecords], [2, 4]);
    assert.deepEqual(metrics(ranged), [[w.a.id, '0', '3', '7'], [w.b.id, '2', '0', '9']]);
    // 关键词只匹配乙 10-06 的那笔：日期挑 10-08 时一笔都不列，乙照样在统计里（这段没有进出）
    const elsewhere = listing.parse(await get({ withMetrics: '1', q: '盘盈', start: '2026-10-08', end: '2026-10-08' }));
    assert.deepEqual([elsewhere.rows, metrics(elsewhere)], [[], [[w.b.id, '0', '0', '9']]]);
    assert.deepEqual(metrics(listing.parse(await get({ withMetrics: '1', q: '盘盈' }))), [[w.b.id, '7', '0', '9']]);
    const beyond = listing.parse(await get({ withMetrics: '1', page: '99', pageSize: '3' }));
    assert.deepEqual([beyond.page, beyond.rows.map((r) => r.date), beyond.filteredRecords], [2, ['2026-10-05'], 4]);
    const sorted = listing.parse(await get({ withMetrics: '1', page: '1', pageSize: '2', sort: 'name' }));
    assert.deepEqual(sorted.rows.map((r) => r.notes), ['虚构补录', '虚构领用']);
    const plain = z.array(z.object({ notes: z.string() })).parse(await get({ start: '2026-10-06', end: '2026-10-07' }));
    assert.deepEqual(plain.map((r) => r.notes), ['虚构领用', '虚构盘盈 Ａ'], '不带统计时直接是流水数组');
  } finally {
    await server.close();
    w.store.close();
  }
});

test('首页的最近流水：只列日期范围里的，最多 8 条，新的在前（同一天后登记的在前）', () => {
  const w = world();
  try {
    for (let i = 0; i < 9; i++) w.move(w.a.id, 'in', '1', '2026-10-09', '虚构批次' + i);
    const recent = buildDashboard(w.store, [], { start: '2026-10-06', end: '2026-10-09' }, '2026-10-09', { workbench: false }).overview.movements;
    assert.deepEqual(recent.map((m) => m.notes), [8, 7, 6, 5, 4, 3, 2, 1].map((i) => '虚构批次' + i));
    const early = buildDashboard(w.store, [], { start: '2026-10-05', end: '2026-10-06' }, '2026-10-09', { workbench: false }).overview.movements;
    assert.deepEqual(early.map((m) => m.date), ['2026-10-06', '2026-10-05']);
  } finally {
    w.store.close();
  }
});
