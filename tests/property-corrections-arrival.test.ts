// 到货更正的属性测试（fast-check）：一张采购单两条明细（两种纸板），随机登记几张到货，再来任意一串
// 改数量、加行、删行、换挂采购明细、领用、撤销。每一步之后：库存守恒、采购明细的已到货等于挂在它上面的有效到货之和；
// 会出负库存、超订购、全改成 0、没改的被拒（且只因为这些被拒），被拒库里不变；预览和执行一致、防重复、旧版本被拒
// （property-corrections-fixture.ts）。改成别的样子再改回原样，一切回到第一次更正之前。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import type { Actor } from '../server/core/auth.js';
import type { FlowDocView } from '../shared/business/index.js';
import { quantityUnits } from '../shared/core/quantity.js';
import { clerk, flowFixture, localAdmin } from './flow-fixture.js';
import { ofKind, orderedPurchase } from './receive-fixture.js';
import { addTo, assertLedger, attemptCorrection, effectiveIds, freeChoice, reverseChecked, useStock } from './property-corrections-fixture.js';

/** 每条采购明细订了多少（千分整数，1000 张） */
const ORDERED = 1000000;
/** 到货更正允许的拒绝：库存不足、超订购、全改成 0、没改、同一采购明细出现两次 */
const REFUSABLE = /库存不足|超过采购订购数量|每一行都是 0|无需提交|同一采购明细不能重复出现/;
const units = (q: string | null | undefined) => quantityUnits(q ?? '0');

/** 采购单三条明细各挂一种纸板，按 arrivals 登记几张到货（每张前两条明细各一行，数量是张；第三条留给加行、换挂） */
function setup(arrivals: [number, number][]) {
  const f = flowFixture();
  const [second, third] = ['虚构纸板乙', '虚构纸板丙'].map((name) => f.ops.saveItem({ name, kind: 'raw', unit: '张' }, clerk));
  const p = orderedPurchase(f, clerk, [
    [f.raw, '1000'],
    [second, '1000'],
    [third, '1000'],
  ]);
  arrivals.forEach(([a, b], i) => p.receive([{ quantity: String(a) }, { quantity: String(b) }], '虚构送货单-' + i));
  const stocks = [f.raw, second, third];
  const purchaseLines = p.purchase.lines.map((l) => {
    const stock = stocks.find((s) => s.id === l.stockItemId) ?? assert.fail('测试数据：采购明细没挂纸板');
    return { id: l.id, stock };
  });
  return { ...f, p, stocks, purchaseLines, used: new Map<number, number>() };
}
type Setup = ReturnType<typeof setup>;
type Arrival = FlowDocView<'arrival'>;
type Line = Record<string, unknown> & { index?: number; quantity: string };

const opArb = fc.oneof(
  fc.record({ t: fc.constant('qty' as const), doc: fc.nat(), line: fc.nat(), q: fc.integer({ min: 0, max: 700 }) }),
  fc.record({ t: fc.constant('add' as const), doc: fc.nat(), pl: fc.nat(1), q: fc.integer({ min: 1, max: 300 }) }),
  fc.record({ t: fc.constant('drop' as const), doc: fc.nat(), line: fc.nat() }),
  fc.record({ t: fc.constant('relink' as const), doc: fc.nat(), line: fc.nat(), pl: fc.nat(1) }),
  fc.record({ t: fc.constant('use' as const), stock: fc.nat(2), q: fc.integer({ min: 1, max: 700 }) }),
  fc.record({ t: fc.constant('undo' as const), doc: fc.nat() }),
);
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;
const arrivalsArb = fc.array(fc.tuple(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 400 })), { minLength: 1, maxLength: 2 });

/** 挂到单上还没挂的第 n 条采购明细上的一整行（新加或换挂用）；都挂上了是 null */
function linkTo(f: Setup, n: number, d: Arrival, lines: Line[]) {
  const taken = lines.map((l) => l.purchaseLineId ?? (l.index === undefined ? null : d.lines[l.index].purchaseLineId)),
    id = freeChoice(f.purchaseLines.map((p) => p.id), taken, n),
    stock = f.purchaseLines.find((p) => p.id === id)?.stock;
  return stock ? { purchaseLineId: id, stockId: stock.id, item: { name: stock.name, unit: '张' } } : null;
}

/** 原单每一行原样留下（按行号） */
const keptLines = (d: Arrival): Line[] => d.lines.map((l, index) => ({ index, quantity: l.quantity }));

/** 在要交的行上做一步改动，交回改后的行和谁来做；这一步无从下手（只剩一行还要删、不是改动）是 null */
function correctionOf(f: Setup, op: Op, lines: Line[], d: Arrival): { lines: Line[]; who: Actor } | null {
  const kept = [...lines],
    link = op.t === 'add' || op.t === 'relink' ? linkTo(f, op.pl, d, lines) : null;
  switch (op.t) {
    case 'qty':
      kept[op.line % kept.length] = { ...kept[op.line % kept.length], quantity: String(op.q) };
      return { lines: kept, who: clerk };
    case 'add':
      return link && { lines: [...kept, { quantity: String(op.q), ...link, unitPrice: '2', priceBasis: 'quantity' }], who: localAdmin() };
    case 'drop':
      if (kept.length < 2) return null;
      kept.splice(op.line % kept.length, 1);
      return { lines: kept, who: localAdmin() };
    case 'relink':
      if (!link) return null;
      kept[op.line % kept.length] = { ...kept[op.line % kept.length], ...link };
      return { lines: kept, who: localAdmin() };
    case 'use':
    case 'undo':
      return null;
  }
}

/** 一张到货按内容：每个库存品入多少、每条采购明细到多少 */
function contribution(lines: readonly { stockId?: unknown; purchaseLineId?: unknown; quantity: string; stockedQuantity?: string | null }[]) {
  const stock = new Map<number, number>(),
    received = new Map<number, number>();
  for (const l of lines) {
    if (typeof l.stockId === 'number') addTo(stock, l.stockId, units(l.stockedQuantity ?? l.quantity));
    if (typeof l.purchaseLineId === 'number') addTo(received, l.purchaseLineId, units(l.quantity));
  }
  return { stock, received };
}

/** 这次更正按规则该不该被拒、因为什么（库存不足、超订购、全是 0、没改）：被拒的说法要对得上，办成的一条都不能占 */
function expectedRefusals(f: Setup, d: Arrival, lines: Line[], balances: Map<number, number>) {
  const next = lines.map((l) => ({ ...(l.index === undefined ? {} : d.lines[l.index]), ...l, stockedQuantity: l.quantity }));
  const was = contribution(d.lines),
    now = contribution(next);
  const received = new Map(f.p.current().lines.map((l) => [l.id, units(l.receivedQuantity)]));
  const delta = (m: Map<number, number>, k: number, a: Map<number, number>, b: Map<number, number>) => (m.get(k) ?? 0) + (b.get(k) ?? 0) - (a.get(k) ?? 0);
  const keys = (a: Map<number, number>, b: Map<number, number>) => [...new Set([...a.keys(), ...b.keys()])];
  const unchanged =
    lines.length === d.lines.length &&
    lines.every((l, i) => l.index === i && units(l.quantity) === units(d.lines[i].quantity) && (l.purchaseLineId ?? d.lines[i].purchaseLineId) === d.lines[i].purchaseLineId);
  return {
    库存不足: keys(was.stock, now.stock).some((k) => delta(balances, k, was.stock, now.stock) < 0),
    超过采购订购数量: keys(was.received, now.received).some(
      (k) => (now.received.get(k) ?? 0) > (was.received.get(k) ?? 0) && delta(received, k, was.received, now.received) > ORDERED,
    ),
    每一行都是: lines.every((l) => units(l.quantity) === 0),
    无需提交: unchanged,
    同一采购明细不能重复出现: new Set(next.flatMap((l) => (typeof l.purchaseLineId === 'number' ? [l.purchaseLineId] : []))).size !== next.filter((l) => typeof l.purchaseLineId === 'number').length,
  };
}

/** 每一步之后：库存守恒；余额等于有效到货入的减去领用的；采购明细的已到货等于有效到货之和 */
function assertDerived(f: Setup) {
  const balances = assertLedger(f.store, f.ops);
  const all = contribution(effectiveIds(f.store, 'arrival').flatMap((id) => f.flow.get(id, 'arrival').lines));
  for (const s of f.stocks) assert.equal(balances.get(s.id), (all.stock.get(s.id) ?? 0) - (f.used.get(s.id) ?? 0), s.name + '的余额');
  for (const l of f.p.current().lines) assert.equal(units(l.receivedQuantity), all.received.get(l.id) ?? 0, '采购明细的已到货');
}

/** 改一次到货：拒绝只因为该拒的原因；办成了采购影响的前后和真的一样 */
function correctOnce(f: Setup, d: Arrival, c: { lines: Line[]; who: Actor }) {
  const expected = expectedRefusals(f, d, c.lines, assertLedger(f.store, f.ops));
  const input = { expectedVersion: d.version, reason: '虚构更正', lines: c.lines };
  const before = new Map(f.p.current().lines.map((l) => [l.id, l.receivedQuantity]));
  const outcome = attemptCorrection(f.store, f.ops, { id: d.id, input, who: c.who, refusable: REFUSABLE });
  if (!outcome.ok) {
    const reason = Object.entries(expected).find(([k]) => outcome.refused.includes(k));
    assert.ok(reason?.[1], '被拒的原因要成立：' + outcome.refused + ' ' + JSON.stringify(expected));
    return;
  }
  assert.deepEqual(expected, { 库存不足: false, 超过采购订购数量: false, 每一行都是: false, 无需提交: false, 同一采购明细不能重复出现: false }, '该拒的没拒');
  const after = new Map(f.p.current().lines.map((l) => [l.id, l.receivedQuantity]));
  for (const p of ofKind(outcome.plan, 'arrival').purchaseImpact)
    for (const l of p.lines) assert.deepEqual([units(l.before), units(l.after)], [units(before.get(l.lineId)), units(after.get(l.lineId))], '预览的已到货前后');
}

function step(f: Setup, op: Op) {
  if (op.t === 'use') return useStock(f.flow, f.stocks[op.stock].id, op.q, f.used);
  const ids = effectiveIds(f.store, 'arrival');
  if (!ids.length) return;
  const d = f.flow.get(ids[op.doc % ids.length], 'arrival');
  if (op.t === 'undo') return reverseChecked(f, d, contribution(d.lines).stock);
  const c = correctionOf(f, op, keptLines(d), d);
  if (c) correctOnce(f, d, c);
}

test('到货：任意一串改数量、加行、删行、换挂、领用、撤销，每步之后库存守恒、已到货等于有效到货之和，拒绝只因该拒的原因', () => {
  fc.assert(
    fc.property(arrivalsArb, fc.array(opArb, { minLength: 5, maxLength: 9 }), (arrivals, ops) => {
      const f = setup(arrivals);
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
    { numRuns: 3 },
  );
});

test('到货：领用掉一部分以后再改少，会出负库存的被拒、库里不变，不会的照办', () => {
  fc.assert(
    fc.property(arrivalsArb, fc.nat(1), fc.integer({ min: 1, max: 800 }), fc.nat(), fc.integer({ min: 0, max: 400 }), (arrivals, stock, q, line, to) => {
      const f = setup(arrivals);
      try {
        useStock(f.flow, f.stocks[stock].id, q, f.used);
        step(f, { t: 'qty', doc: 0, line, q: to });
        assertDerived(f);
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 6 },
  );
});

/** 原单的整行内容（改回原样时按新加的行整行交回去） */
const wholeLine = (l: Arrival['lines'][number]): Line => ({
  quantity: l.quantity,
  acceptedQuantity: l.acceptedQuantity,
  rejectedQuantity: l.rejectedQuantity,
  stockedQuantity: l.stockedQuantity ?? undefined,
  stockId: l.stockId,
  purchaseLineId: l.purchaseLineId,
  item: l.item,
  unitPrice: l.unitPrice,
  priceBasis: l.priceBasis,
});
/** 库存余额和每条采购明细的已到货 */
const state = (f: Setup) => ({
  balances: [...assertLedger(f.store, f.ops)],
  received: f.p.current().lines.map((l) => [l.id, l.receivedQuantity]),
});

test('到货：改成别的样子（数量、删行、加行、换挂）再改回原样，库存和采购明细已到货都回到第一次更正之前', () => {
  fc.assert(
    fc.property(arrivalsArb, fc.array(opArb, { minLength: 1, maxLength: 4 }), (arrivals, edits) => {
      const f = setup(arrivals);
      try {
        const a = f.flow.get(effectiveIds(f.store, 'arrival')[0], 'arrival'),
          before = state(f);
        const lines = edits.reduce((now, op) => correctionOf(f, op, now, a)?.lines ?? now, keptLines(a));
        const b = attemptCorrection(f.store, f.ops, {
          id: a.id,
          input: { expectedVersion: a.version, reason: '虚构改成 B', lines },
          who: localAdmin(),
          refusable: REFUSABLE,
        });
        if (!b.ok) return;
        const replaced = f.flow.get(b.result.replacementId, 'arrival');
        const back = attemptCorrection(f.store, f.ops, {
          id: replaced.id,
          input: { expectedVersion: replaced.version, reason: '虚构改回 A', lines: a.lines.map(wholeLine) },
          who: localAdmin(),
          refusable: /^$/,
        });
        assert.ok(back.ok);
        assert.deepEqual(state(f), before, '改回原样以后库存、已到货回到第一次更正之前');
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 6 },
  );
});
