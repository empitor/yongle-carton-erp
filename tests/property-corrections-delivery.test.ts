// 送货更正的属性测试（fast-check）：两种成品（材质、楞型不同）、两张订单三条明细，随机出库几张送货单，
// 再来任意一串改数量、加行、删行、换挂订单明细、改产品材质、领用、撤销。每一步之后：库存守恒、订单明细的已发等于
// 有效送货之和、订单状态由有效送货派生；会出负库存、超订单、没改、重复明细、挂到已发完订单的被拒（且只因为这些），
// 被拒库里不变；预览和执行一致、防重复、旧版本被拒（property-corrections-fixture.ts）；原样留下的行沿用出库时的
// 材质楞型，新加、换挂的行按产品现在的。改成别的样子再改回原样，一切回到第一次更正之前。内存库、虚构数据。
import { trackedOrder } from '../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Actor } from '../server/core/index.js';
import type { FlowDocView } from '../shared/business/index.js';
import { businessBase, manualWrite } from './business-base-fixture.js';
import { quantityUnits } from '../shared/core/quantity.js';
import { clerk, localAdmin } from './flow-fixture.js';
import { ofKind } from './receive-fixture.js';
import { addTo, assertLedger, attemptCorrection, effectiveIds, freeChoice, reverseChecked, useStock } from './property-corrections-fixture.js';

/** 每条订单明细订 1000 只（千分整数）；每种成品期初 3000 只 */
const ORDERED = 1000000;
const OPENING = 3000000;
/** 产品改材质时从这几种里挑 */
const MATERIALS = [
  { material: 'K=K', flute: 'BC' },
  { material: 'B=B', flute: 'E' },
  { material: 'A=A', flute: 'C' },
];
/** 送货更正允许的拒绝：库存不足、超订单、没改、同一明细两行、挂到已发完的订单 */
const REFUSABLE = /库存不足|超过订单剩余数量|和原送货单一样|同一订单明细请合并|正常待完成订单/;
const units = (q: string | number | null | undefined) => quantityUnits(String(q ?? 0));

/** 一张送货单：每行 [第几条订单明细（0..2）, 数量] */
type Ship = [number, number][];

function setup(ships: Ship[]) {
  const base = businessBase(clerk),
    { store, ops, flow, check } = base;
  const customer = base.customer({ name: '虚构客户' });
  const specs = [
    { name: '虚构外箱甲', material: 'K=A', flute: 'B' },
    { name: '虚构外箱乙', material: 'A=A', flute: 'C' },
  ];
  const products = specs.map((p) => base.product(p));
  const stocks = products.map((p) => base.finished(p, { name: p.name }));
  for (const s of stocks) base.stockIn(s, { quantity: '3000', date: '2026-10-01' });
  const orders = [[0, 1], [0]].map((ps) =>
    base.order(
      customer,
      ps.map((k) => base.line(products[k], 1000, { productName: products[k].name })),
      { orderDate: '2026-10-01', deliveryDate: '2026-12-30' },
    ),
  );
  const slots = [
    { order: orders[0], line: orders[0].lines[0], product: 0 },
    { order: orders[0], line: orders[0].lines[1], product: 1 },
    { order: orders[1], line: orders[1].lines[0], product: 0 },
  ].map((s) => ({ orderId: s.order.id, orderLineId: s.line.id ?? assert.fail('测试数据：订单明细没有编号'), product: s.product }));
  const f = { store, ops, flow, check, customer, products, stocks, orders, slots, current: specs.map((s) => ({ ...s })), used: new Map<number, number>() };
  for (const ship of ships) deliver(f, ship);
  return f;
}
type Setup = ReturnType<typeof setup>;
type Delivery = FlowDocView<'delivery'>;
type Line = { index?: number; quantity: string; orderLineId?: number };

/** 安排并出库一张送货单 */
function deliver(f: Pick<Setup, 'flow' | 'check' | 'customer' | 'slots' | 'stocks'>, ship: Ship) {
  const lines = ship.map(([k, q]) => ({ orderId: f.slots[k].orderId, orderLineId: f.slots[k].orderLineId, stockId: f.stocks[f.slots[k].product].id, quantity: String(q) }));
  const d = f.flow.save('delivery', { date: '2026-11-02', plannedDate: '2026-11-02', customerId: f.customer.id, lines }, clerk);
  f.check(d, { shipDate: '2026-11-02' });
}

const opArb = fc.oneof(
  fc.record({ t: fc.constant('qty' as const), doc: fc.nat(), line: fc.nat(), q: fc.integer({ min: 1, max: 900 }) }),
  fc.record({ t: fc.constant('add' as const), doc: fc.nat(), slot: fc.nat(2), q: fc.integer({ min: 1, max: 300 }) }),
  fc.record({ t: fc.constant('drop' as const), doc: fc.nat(), line: fc.nat() }),
  fc.record({ t: fc.constant('relink' as const), doc: fc.nat(), line: fc.nat(), slot: fc.nat(2) }),
  fc.record({ t: fc.constant('remat' as const), product: fc.nat(1), m: fc.nat(2) }),
  fc.record({ t: fc.constant('use' as const), stock: fc.nat(1), q: fc.integer({ min: 1, max: 2500 }) }),
  fc.record({ t: fc.constant('undo' as const), doc: fc.nat() }),
);
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;
const shipsArb = fc.array(
  fc.uniqueArray(fc.tuple(fc.nat(2), fc.integer({ min: 1, max: 500 })), { selector: (t) => t[0], minLength: 1, maxLength: 3 }),
  { minLength: 1, maxLength: 2 },
);

const keptLines = (d: Delivery): Line[] => d.lines.map((l, index) => ({ index, quantity: l.quantity }));

/** 在要交的行上做一步改动，交回改后的行和谁来做；无从下手（只剩一行还要删、不是改动）是 null */
function correctionOf(f: Setup, op: Op, lines: Line[], d: Delivery): { lines: Line[]; who: Actor } | null {
  const kept = [...lines],
    taken = lines.map((l) => l.orderLineId ?? (l.index === undefined ? null : d.lines[l.index].orderLineId)),
    free = op.t === 'add' || op.t === 'relink' ? freeChoice(f.slots.map((x) => x.orderLineId), taken, op.slot) : null;
  switch (op.t) {
    case 'qty':
      kept[op.line % kept.length] = { ...kept[op.line % kept.length], quantity: String(op.q) };
      return { lines: kept, who: clerk };
    case 'add':
      return free === null ? null : { lines: [...kept, { quantity: String(op.q), orderLineId: free }], who: localAdmin() };
    case 'drop':
      if (kept.length < 2) return null;
      kept.splice(op.line % kept.length, 1);
      return { lines: kept, who: clerk };
    case 'relink':
      if (!free) return null;
      kept[op.line % kept.length] = { ...kept[op.line % kept.length], orderLineId: free };
      return { lines: kept, who: localAdmin() };
    case 'remat':
    case 'use':
    case 'undo':
      return null;
  }
}

/** 订单明细 → 第几条（找产品、成品库存） */
const slotOf = (f: Setup, orderLineId: number) => f.slots.find((s) => s.orderLineId === orderLineId) ?? assert.fail('测试数据：没有订单明细 ' + orderLineId);
/** 更正后的一行沿用原单哪一行：带行号、没换订单明细的是原样留下的 */
const keptBase = (d: Delivery, l: Line) => {
  const base = l.index === undefined ? null : d.lines[l.index];
  return base && (l.orderLineId === undefined || l.orderLineId === base.orderLineId) ? base : null;
};
/** 每条订单明细的已发（千分整数） */
const shippedNow = (f: Setup) =>
  new Map(f.orders.flatMap((o) => (trackedOrder(f.store, o.id, true)?.lines ?? []).map((l) => [l.id ?? 0, units(l.shippedQuantity)])));

/** 一张送货按内容：每个成品库存出多少（负数）、每条订单明细发多少 */
function contribution(lines: readonly { stockId: number; orderLineId: number; quantity: string }[]) {
  const stock = new Map<number, number>(),
    sent = new Map<number, number>();
  for (const l of lines) {
    addTo(stock, l.stockId, -units(l.quantity));
    addTo(sent, l.orderLineId, units(l.quantity));
  }
  return { stock, sent };
}

/** 这次更正按规则该不该被拒、因为什么：被拒的说法要对得上，办成的一条都不能占 */
function expectedRefusals(f: Setup, d: Delivery, lines: Line[], balances: Map<number, number>) {
  const next = lines.map((l) => {
    const base = keptBase(d, l),
      orderLineId = base?.orderLineId ?? l.orderLineId ?? 0;
    return { orderLineId, stockId: base?.stockId ?? f.stocks[slotOf(f, orderLineId).product].id, quantity: l.quantity };
  });
  const was = contribution(d.lines),
    now = contribution(next),
    shipped = shippedNow(f),
    oldLines = new Set(d.lines.map((l) => l.orderLineId));
  const closed = (orderLineId: number) => f.store.order(slotOf(f, orderLineId).orderId, true)?.status === '已发货';
  return {
    库存不足: [...new Set([...was.stock.keys(), ...now.stock.keys()])].some((k) => (balances.get(k) ?? 0) + (now.stock.get(k) ?? 0) - (was.stock.get(k) ?? 0) < 0),
    超过订单剩余数量: [...now.sent].some(([k, n]) => n > (was.sent.get(k) ?? 0) && (shipped.get(k) ?? 0) - (was.sent.get(k) ?? 0) + n > ORDERED),
    和原送货单一样: lines.length === d.lines.length && lines.every((l, i) => l.index === i && keptBase(d, l) && units(l.quantity) === units(d.lines[i].quantity)),
    同一订单明细请合并: new Set(next.map((l) => l.orderLineId)).size !== next.length,
    正常待完成订单: next.some((l) => !oldLines.has(l.orderLineId) && closed(l.orderLineId)),
  };
}

/** 每一步之后：库存守恒；余额等于期初减有效送货减领用；订单明细已发等于有效送货之和；订单状态由已发派生 */
function assertDerived(f: Setup) {
  const balances = assertLedger(f.store, f.ops);
  const all = contribution(effectiveIds(f.store, 'delivery').flatMap((id) => f.flow.get(id, 'delivery').lines));
  for (const s of f.stocks) assert.equal(balances.get(s.id), OPENING + (all.stock.get(s.id) ?? 0) - (f.used.get(s.id) ?? 0), s.name + '的余额');
  const shipped = shippedNow(f);
  for (const s of f.slots) assert.equal(shipped.get(s.orderLineId), all.sent.get(s.orderLineId) ?? 0, '订单明细的已发');
  for (const o of f.orders) {
    const sent = o.lines.map((l) => all.sent.get(l.id ?? 0) ?? 0);
    const status = sent.every((n) => n >= ORDERED) ? '已发货' : sent.some((n) => n > 0) ? '待发货' : '已确认';
    assert.equal(f.store.order(o.id, true)?.status, status, '订单状态由有效送货派生');
  }
}

/** 改一次送货：拒绝只因为该拒的原因；办成了订单影响和真的一样，材质楞型按规矩取 */
function correctOnce(f: Setup, d: Delivery, c: { lines: Line[]; who: Actor }) {
  const expected = expectedRefusals(f, d, c.lines, assertLedger(f.store, f.ops)),
    before = shippedNow(f);
  const input = { expectedVersion: d.version, reason: '虚构更正', lines: c.lines };
  const outcome = attemptCorrection(f.store, f.ops, { id: d.id, input, who: c.who, refusable: REFUSABLE });
  if (!outcome.ok) {
    const reason = Object.entries(expected).find(([k]) => outcome.refused.includes(k));
    assert.ok(reason?.[1], '被拒的原因要成立：' + outcome.refused + ' ' + JSON.stringify(expected));
    return;
  }
  assert.ok(Object.values(expected).every((v) => !v), '该拒的没拒：' + JSON.stringify(expected));
  const after = shippedNow(f);
  for (const o of ofKind(outcome.plan, 'delivery').orderImpact)
    assert.deepEqual([units(o.before), units(o.after)], [before.get(o.orderLineId) ?? 0, after.get(o.orderLineId) ?? 0], '预览的已发前后');
  const rep = f.flow.get(outcome.result.replacementId, 'delivery');
  c.lines.forEach((l, i) => {
    const base = keptBase(d, l),
      want = base ? { material: base.material, flute: base.flute } : f.current[slotOf(f, rep.lines[i].orderLineId).product];
    assert.deepEqual({ material: rep.lines[i].material, flute: rep.lines[i].flute }, { material: want.material, flute: want.flute }, '材质楞型');
  });
}

/** 改产品的材质楞型（已出库的送货单不跟着变） */
function remat(f: Setup, product: number, m: number) {
  f.current[product] = { ...f.current[product], ...MATERIALS[m] };
  const id = f.products[product].id,
    version = f.store.product(id)?.version ?? assert.fail('测试数据：没有产品 ' + id);
  manualWrite(f.store, { entity: 'products', action: 'update', id, input: { ...f.current[product], version } }, null);
}

function step(f: Setup, op: Op) {
  if (op.t === 'use') return useStock(f.flow, f.stocks[op.stock].id, op.q, f.used);
  if (op.t === 'remat') return remat(f, op.product, op.m);
  const ids = effectiveIds(f.store, 'delivery');
  if (!ids.length) return;
  const d = f.flow.get(ids[op.doc % ids.length], 'delivery');
  if (op.t === 'undo') return reverseChecked(f, d, contribution(d.lines).stock);
  const c = correctionOf(f, op, keptLines(d), d);
  if (c) correctOnce(f, d, c);
}

test('送货：任意一串改数量、加行、删行、换挂、改材质、领用、撤销，每步之后库存守恒、已发和订单状态由有效送货派生，拒绝只因该拒的原因', () => {
  fc.assert(
    fc.property(shipsArb, fc.array(opArb, { minLength: 5, maxLength: 9 }), (ships, ops) => {
      const f = setup(ships);
      try {
        assertDerived(f);
        for (const op of ops) {
          step(f, op);
          assertDerived(f);
        }
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 4 },
  );
});

test('送货：领用掉一部分以后再改多，会出负库存的被拒、库里不变，不会的照办', () => {
  fc.assert(
    fc.property(shipsArb, fc.nat(1), fc.integer({ min: 1, max: 3000 }), fc.nat(), fc.integer({ min: 1, max: 900 }), (ships, stock, q, line, to) => {
      const f = setup(ships);
      try {
        useStock(f.flow, f.stocks[stock].id, q, f.used);
        step(f, { t: 'qty', doc: 0, line, q: to });
        assertDerived(f);
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 7 },
  );
});

test('送货：改成别的样子（数量、删行、加行、换挂）再改回原样，库存、订单已发和状态都回到第一次更正之前', () => {
  fc.assert(
    fc.property(shipsArb, fc.array(opArb, { minLength: 1, maxLength: 4 }), (ships, edits) => {
      const f = setup(ships);
      try {
        const a = f.flow.get(effectiveIds(f.store, 'delivery')[0], 'delivery');
        const state = () => ({ balances: [...assertLedger(f.store, f.ops)], shipped: [...shippedNow(f)], status: f.orders.map((o) => f.store.order(o.id, true)?.status) });
        const before = state();
        const lines = edits.reduce((now, op) => correctionOf(f, op, now, a)?.lines ?? now, keptLines(a));
        const b = attemptCorrection(f.store, f.ops, { id: a.id, input: { expectedVersion: a.version, reason: '虚构改成 B', lines }, who: localAdmin(), refusable: REFUSABLE });
        if (!b.ok) return;
        const replaced = f.flow.get(b.result.replacementId, 'delivery');
        const back = attemptCorrection(f.store, f.ops, {
          id: replaced.id,
          input: { expectedVersion: replaced.version, reason: '虚构改回 A', lines: a.lines.map((l) => ({ quantity: l.quantity, orderLineId: l.orderLineId })) },
          who: localAdmin(),
          refusable: /^$/,
        });
        assert.ok(back.ok);
        assert.deepEqual(state(), before, '改回原样以后库存、已发、订单状态回到第一次更正之前');
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 8 },
  );
});
