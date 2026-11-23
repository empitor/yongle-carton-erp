// 财务从业务拿数据的只读窗口：库存一组（server/flow/finance-facts/stock.ts）的口径。
// 真实单据服务造到货、撤销、领料完工、送货、盘点（虚构数据、内存库）；只读的通则在 finance-facts-parties.test.ts。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { one } from '../../server/core/index.js';
import { financeFacts } from '../../server/flow/index.js';
import { quantityUnits } from '../../shared/core/index.js';
import { businessBase } from '../support/business-base-fixture.js';
import { businessChanges } from '../support/business-changes-fixture.js';
import { fixture, maker } from './finance-costing-fixture.js';
import { must } from '../support/read-result.js';

const stock = financeFacts.stock;
const u = (q: string) => quantityUnits(q);

/**
 * 两种纸板 a、b：a 2 月 3 日到货 10 张（记过账），b 2 月 4 日无单价到货 10 张、6 日撤销；
 * 2 月 8 日 a 领料 4 张完工 4 只，15 日送货 3 只，3 月 2 日再送 1 只；20 日 a 盘亏 1 张。
 */
function world() {
  const f = fixture();
  const a = f.raw(),
    b = f.raw();
  f.receive(a, '2026-02-03');
  const unpriced = f.arrive(b, '2026-02-04');
  f.reverse(unpriced, '2026-02-06');
  f.produce(a, '2026-02-08', '4');
  const sent = f.deliver('2026-02-15', '3');
  f.deliver('2026-03-02', '1');
  const changes = businessChanges(f.s, maker);
  changes.backdatedMovement({
    id: 'fict-count', item_id: a.id, action: 'adjust', delta_units: -u('1'), before_units: u('6'), after_units: u('5'),
    source_kind: 'manual', date: '2026-02-20', notes: '虚构盘亏', created_at: '2026-02-20T01:00:00Z',
  });
  return { f, db: f.s.db, a, b, unpriced, sent, changes };
}

const feb = { from: '2026-02-01', to: '2026-02-28' };

test('流水：日期段含两头、某日以前不含当天，按日期、行号排，带库存品和订单的客户；exclude 去掉那张到货的入库和冲回', () => {
  const w = world();
  const all = stock.movements(w.db, { dates: feb, exclude: [] });
  assert.deepEqual(
    all.map((m) => [m.date, m.source_kind, m.delta_units]),
    [
      ['2026-02-03', 'flow_arrival', u('10')],
      ['2026-02-04', 'flow_arrival', u('10')],
      ['2026-02-06', 'flow_reversal', -u('10')],
      ['2026-02-08', 'flow_production', -u('4')],
      ['2026-02-08', 'flow_production', u('4')],
      ['2026-02-15', 'flow_delivery', -u('3')],
      ['2026-02-20', 'manual', -u('1')],
    ],
  );
  const delivered = must(all.find((m) => m.source_kind === 'flow_delivery'), '送货流水');
  assert.deepEqual([delivered.kind, delivered.unit, delivered.stock_name, delivered.customer_id], ['finished', '只', '虚构纸箱', 1]);
  assert.equal(must(all.find((m) => m.source_kind === 'manual'), '盘点流水').customer_id, null, '没挂订单的客户是空');
  // 撤销的那张无单价到货：入库和冲回一起去掉，别的照旧
  const kept = stock.movements(w.db, { dates: feb, exclude: [String(w.unpriced.id)] });
  assert.deepEqual(all.filter((m) => m.source_id !== String(w.unpriced.id)), kept);
  // 来源编号空着的到货流水：排除列表不空也照样在（不按空编号误排）
  w.changes.backdatedMovement({
    id: 'fict-unsourced', item_id: w.a.id, action: 'in', delta_units: u('1'), before_units: u('5'), after_units: u('6'),
    source_kind: 'flow_arrival', date: '2026-02-21', notes: '虚构无来源到货', created_at: '2026-02-21T01:00:00Z',
  });
  const unsourced = (exclude: string[]) => stock.movements(w.db, { dates: feb, exclude }).filter((m) => m.id === 'fict-unsourced');
  assert.equal(unsourced([String(w.unpriced.id)]).length, 1);
  assert.equal(stock.balancesBefore(w.db, { start: '2026-03-01', end: '2026-02-28', exclude: [String(w.unpriced.id)] }).find((s) => s.id === w.a.id)?.qty, u('6'));
  // 某日以前：不含当天
  assert.deepEqual(stock.movements(w.db, { dates: { before: '2026-02-06' }, exclude: [] }).map((m) => m.date), ['2026-02-03', '2026-02-04']);
});

test('流水：after 只要那个时间点以后才登记的（登记时间或行号有一个晚就算），asOf 只要以前登记的', () => {
  const w = world();
  const mark = { ranAt: '2099-01-01T00:00:00.000Z', maxRowid: stock.maxRowid(w.db) };
  // 登记时间写早了的补登：按行号认得出是之后才登记的
  w.changes.backdatedMovement({
    id: 'fict-late', item_id: w.a.id, action: 'in', delta_units: u('2'), before_units: u('5'), after_units: u('7'),
    source_kind: 'manual', date: '2026-02-21', notes: '虚构补登', created_at: '2026-02-21T01:00:00Z',
  });
  const late = stock.movements(w.db, { dates: { before: '2026-03-01' }, after: mark, exclude: [] });
  assert.deepEqual(late.map((m) => m.id), ['fict-late']);
  const asOf = stock.movements(w.db, { dates: feb, asOf: mark, exclude: [] });
  assert.equal(asOf.some((m) => m.id === 'fict-late'), false);
  assert.equal(asOf.length, 7);
});

test('结存：end 以前有流水的库存品带 start 以前的数量（exclude 的不算）；期初结存只列不是 0 的，原材料在前、按名称排', () => {
  const w = world();
  const c = w.f.raw();
  w.f.receive(c, '2026-03-05');
  const qty = (start: string, exclude: string[]) =>
    new Map(stock.balancesBefore(w.db, { start, end: '2026-02-28', exclude }).map((s) => [s.id, s.qty]));
  // 撤销前（2 月 5 日）b 还有 10 张；那张到货不计时一直是 0；3 月才有流水的 c 不在里面
  assert.deepEqual([...qty('2026-02-05', [])].sort(), [[w.a.id, u('10')], [w.b.id, u('10')], [w.f.finished.id, 0]].sort());
  assert.equal(qty('2026-02-05', [String(w.unpriced.id)]).get(w.b.id), 0);
  assert.equal(qty('2026-02-05', []).has(c.id), false);
  const opening = (start: string, exclude: string[]) => stock.openingBalances(w.db, start, exclude).map((s) => [s.stockId, s.quantity]);
  assert.deepEqual(opening('2026-02-10', []), [[w.a.id, u('6')], [w.f.finished.id, u('4')]], '原材料在前；b 撤销后是 0 不列');
  assert.deepEqual(opening('2026-02-05', [String(w.unpriced.id)]), [[w.a.id, u('10')]]);
  const last = must(stock.openingBalances(w.db, '2026-02-10', [])[1], '成品的期初结存');
  assert.deepEqual([last.name, last.unit], ['虚构纸箱', '只']);
});

test('要人填金额的流水：日期段里的加上指定编号的，不含完工、采购退货、到货入库、成品送货出库，exclude 的不要', () => {
  const w = world();
  w.changes.backdatedMovement({
    id: 'fict-march', item_id: w.a.id, action: 'in', delta_units: u('1'), before_units: u('5'), after_units: u('6'),
    source_kind: 'manual', date: '2026-03-10', notes: '虚构三月入库', created_at: '2026-03-10T01:00:00Z',
  });
  const listed = (ids: string[], exclude: string[]) =>
    stock.manualMovements(w.db, { ...feb, ids, exclude }).map((m) => [m.source_kind, m.quantity, m.kind]);
  assert.deepEqual(listed([], []), [
    ['flow_reversal', -u('10'), 'raw'],
    ['manual', -u('1'), 'raw'],
  ]);
  assert.deepEqual(listed(['fict-march'], [String(w.unpriced.id)]), [
    ['manual', -u('1'), 'raw'],
    ['manual', u('1'), 'raw'],
  ]);
  const counted = must(stock.manualMovements(w.db, { ...feb, ids: [], exclude: [] }).find((m) => m.id === 'fict-count'), '盘点流水');
  assert.deepEqual([counted.notes, counted.unit, counted.item_id, counted.source_id], ['虚构盘亏', '张', w.a.id, null]);
});

test('冲销对应的原流水：一批一次查完，按传入的位置对回；送货找出库、到货找入库、完工找完工入库，对不上的是空', () => {
  const w = world();
  const second = w.f.produce(w.a, '2026-02-09', '2');
  w.f.reverse(w.sent, '2026-02-25');
  w.f.reverse(second, '2026-02-26');
  const finished = w.f.finished.id;
  const originals = stock.reversalOriginals(w.db, [
    { sourceId: String(w.sent.id), itemId: finished },
    { sourceId: String(w.unpriced.id), itemId: w.b.id },
    { sourceId: String(w.sent.id), itemId: w.a.id },
    { sourceId: '999999', itemId: finished },
  ]);
  assert.deepEqual(
    originals.map((list) => list.map((o) => [o.document_kind, o.source_kind, o.delta_units])),
    [[['delivery', 'flow_delivery', -u('3')]], [['arrival', 'flow_arrival', u('10')]], [], []],
  );
  const sentOut = must(originals[0][0], '原送货出库');
  assert.deepEqual([sentOut.kind, sentOut.customer_id, sentOut.date], ['finished', 1, '2026-02-15']);
  const completions = stock.completionOriginals(w.db, [
    { sourceId: String(second.id), itemId: finished },
    { sourceId: String(w.sent.id), itemId: finished },
    { sourceId: String(second.id), itemId: w.a.id },
  ]);
  assert.deepEqual(completions.map((list) => list.map((o) => [o.delta_units, o.date])), [[[u('2'), '2026-02-09']], [], []]);
});

test('撤销冲回过的到货：只看已撤销（含被更正替代）的到货单，按库存品、冲回日期截止、exclude 筛；已撤销的到货单编号是文字', () => {
  const w = world();
  const corrected = w.f.receive(w.b, '2026-02-11').received;
  w.f.correctArrival(corrected.id, '6', '2026-02-12');
  const undone = (stockIds: number[], end: string, exclude: string[]) =>
    stock.undoneArrivals(w.db, { stockIds, end, exclude }).map((r) => [r.source_id, r.item_id]).sort();
  const b = w.b.id;
  assert.deepEqual(undone([b], '2026-02-28', []), [[String(w.unpriced.id), b], [String(corrected.id), b]].sort());
  assert.deepEqual(undone([b], '2026-02-11', []), [[String(w.unpriced.id), b]], '冲回日期晚于截止日的不算');
  assert.deepEqual(undone([b], '2026-02-28', [String(w.unpriced.id)]), [[String(corrected.id), b]]);
  assert.deepEqual(undone([w.a.id], '2026-02-28', []), [], '别的库存品的不算');
  assert.deepEqual(stock.reversedArrivals(w.db).sort(), [String(w.unpriced.id), String(corrected.id)].sort(), '有效的到货、替代单不算');
});

test('盘点流水编号按日期截止；最大行号是现在流水的；成品送货出库量按订单、客户、产品、库存品合计，只算这个月有效的送货单', () => {
  const w = world();
  assert.deepEqual(stock.adjustIds(w.db, '2026-02-20'), ['fict-count']);
  assert.deepEqual(stock.adjustIds(w.db, '2026-02-19'), []);
  const max = z.object({ n: z.number() });
  assert.equal(stock.maxRowid(w.db), one(w.db, max, 'SELECT max(rowid) AS n FROM stock_movements')?.n);
  assert.equal(stock.maxRowid(businessBase(maker).store.db), 0, '没有流水是 0');
  const outflow = (period: string) =>
    stock.deliveryOutflows(w.db, period).map((r) => [r.orderId, r.customerId, r.productId, r.itemId, r.unit, r.quantity]);
  const order = must(one(w.db, z.object({ id: z.number() }), 'SELECT id FROM orders'), '订单').id;
  const product = must(one(w.db, z.object({ id: z.number() }), 'SELECT product_id AS id FROM stock_items WHERE id=?', w.f.finished.id), '产品').id;
  const finished = w.f.finished.id;
  assert.deepEqual(outflow('2026-02'), [[order, 1, product, finished, '只', u('3')]]);
  assert.deepEqual(outflow('2026-03'), [[order, 1, product, finished, '只', u('1')]]);
  w.f.reverse(w.sent, '2026-02-25');
  assert.deepEqual(outflow('2026-02'), [], '撤销了的送货单不算');
});
