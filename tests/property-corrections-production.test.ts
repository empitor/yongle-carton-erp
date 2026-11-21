// 完工更正的属性测试（fast-check）：一张订单、两张挂订单的生产任务和一张另一产品的任务，纸板、衬板两种领料，
// 随机登记几张完工，再来任意一串改合格报废数、改领用、加删领料行、换纸板、换挂任务和产品、领用、撤销。
// 每一步之后：库存守恒、任务已入库等于有效完工之和、订单状态由有效单据派生；会出负库存、全是 0、没改的被拒
// （且只因为这些），被拒库里不变；预览和执行一致、防重复、旧版本被拒（property-corrections-fixture.ts）。
// 改成别的样子再改回原样，一切回到第一次更正之前。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { FlowDocView } from '../shared/business/index.js';
import { productSchema } from '../shared/core/domain.js';
import { quantityUnits } from '../shared/core/quantity.js';
import { businessFixture, localAdmin } from './flow-fixture.js';
import { ofKind } from './receive-fixture.js';
import { addTo, assertLedger, attemptCorrection, effectiveIds, freeChoice, reverseChecked, useStock } from './property-corrections-fixture.js';

/** 订单订 1000 只（千分整数）；纸板、衬板期初各 500 张 */
const ORDERED = 1000000;
const OPENING = 500000;
/** 完工更正允许的拒绝：库存不足、合格报废都是 0、没改、同一种料两行 */
const REFUSABLE = /库存不足|合格、报废都是 0|和原完工单一样|同一原材料只能登记一次/;
const units = (q: string | null | undefined) => quantityUnits(q ?? '0');

/** 一张完工：挂第几张任务（0、1 挂订单）、合格数、领多少张纸板 */
type Done = [number, number, number];

function setup(done: Done[]) {
  const f = businessFixture(),
    actor = f.actor;
  const other = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱乙' }));
  const otherStock = f.ops.saveItem({ name: '虚构成品乙', kind: 'finished', unit: '只', productId: other.id }, actor);
  const opening = (id: number) => {
    const it = f.ops.items(true, id)[0];
    f.flow.stock.move(id, { action: 'in', quantity: '500', date: '2026-10-01', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: it.version }, actor);
  };
  opening(f.raw.id);
  opening(f.glue.id);
  const tasks = [f.task('1000'), f.task('1000'), f.flow.save('task', { date: '2026-10-27', productId: other.id, quantity: '1000', unit: '只', orderIds: [], plannedDate: '2026-10-27' }, actor)];
  for (const [t, good, issued] of done)
    f.confirm('production', {
      taskId: tasks[t].id,
      productId: f.product.id,
      finishedStockId: f.finished.id,
      goodQuantity: String(good),
      operator: '虚构员工',
      materials: [{ stockId: f.raw.id, issued: String(issued), returned: '0' }],
    });
  // 换挂的去处：[任务, 产品]
  const targets = [
    { taskId: tasks[0].id, productId: f.product.id },
    { taskId: tasks[1].id, productId: f.product.id },
    { taskId: tasks[2].id, productId: other.id },
    { taskId: null, productId: f.product.id },
    { taskId: null, productId: other.id },
  ];
  const finishedOf = new Map([
    [f.product.id, f.finished.id],
    [other.id, otherStock.id],
  ]);
  return { ...f, tasks, targets, finishedOf, materials: [f.raw, f.glue], stocks: [f.raw, f.glue, f.finished, otherStock], used: new Map<number, number>() };
}
type Setup = ReturnType<typeof setup>;
type Production = FlowDocView<'production'>;
type Material = { index?: number; stockId?: number; issued: string; returned?: string };
type Input = { goodQuantity?: string; scrapQuantity?: string; materials?: Material[]; taskId?: number | null; productId?: number };

const opArb = fc.oneof(
  fc.record({ t: fc.constant('good' as const), doc: fc.nat(), good: fc.integer({ min: 0, max: 600 }), scrap: fc.integer({ min: 0, max: 50 }) }),
  fc.record({ t: fc.constant('issue' as const), doc: fc.nat(), line: fc.nat(), q: fc.integer({ min: 1, max: 120 }) }),
  fc.record({ t: fc.constant('addmat' as const), doc: fc.nat(), stock: fc.nat(1), q: fc.integer({ min: 1, max: 60 }) }),
  fc.record({ t: fc.constant('dropmat' as const), doc: fc.nat(), line: fc.nat() }),
  fc.record({ t: fc.constant('swapmat' as const), doc: fc.nat(), line: fc.nat(), stock: fc.nat(1) }),
  fc.record({ t: fc.constant('retarget' as const), doc: fc.nat(), target: fc.nat(4) }),
  fc.record({ t: fc.constant('use' as const), stock: fc.nat(3), q: fc.integer({ min: 1, max: 600 }) }),
  fc.record({ t: fc.constant('undo' as const), doc: fc.nat() }),
);
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;
const doneArb = fc.array(fc.tuple(fc.nat(1), fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 60 })), { minLength: 1, maxLength: 2 });

const keptMaterials = (d: Production): Material[] => d.materials.map((m, index) => ({ index, issued: m.issued }));

/** 在要交的更正上做一步改动；无从下手（只剩一行领料还要删、不是改动）是 null */
function correctionOf(f: Setup, op: Op, input: Input, d: Production): Input | null {
  const materials = [...(input.materials ?? keptMaterials(d))],
    taken = materials.map((m) => m.stockId ?? (m.index === undefined ? null : d.materials[m.index].stockId)),
    free = op.t === 'addmat' || op.t === 'swapmat' ? freeChoice(f.materials.map((m) => m.id), taken, op.stock) : null;
  switch (op.t) {
    case 'good':
      return { ...input, goodQuantity: String(op.good), scrapQuantity: String(op.scrap) };
    case 'issue':
      materials[op.line % materials.length] = { ...materials[op.line % materials.length], issued: String(op.q) };
      return { ...input, materials };
    case 'addmat':
      return free === null ? null : { ...input, materials: [...materials, { stockId: free, issued: String(op.q) }] };
    case 'dropmat':
      if (materials.length < 2) return null;
      materials.splice(op.line % materials.length, 1);
      return { ...input, materials };
    case 'swapmat':
      if (!free) return null;
      materials[op.line % materials.length] = { ...materials[op.line % materials.length], stockId: free };
      return { ...input, materials };
    case 'retarget':
      return { ...input, ...f.targets[op.target] };
    case 'use':
    case 'undo':
      return null;
  }
}

/** 一张完工按内容的库存变化：成品入合格数，每种料减（领 − 退） */
function contribution(d: { finishedStockId?: number | null; goodQuantity: string; materials: readonly { stockId?: number; issued: string; returned?: string }[] }) {
  const stock = new Map<number, number>();
  if (d.finishedStockId) addTo(stock, d.finishedStockId, units(d.goodQuantity));
  for (const m of d.materials) if (m.stockId) addTo(stock, m.stockId, units(m.returned) - units(m.issued));
  return stock;
}

/** 这次更正按规则该不该被拒、因为什么：被拒的说法要对得上，办成的一条都不能占 */
function expectedRefusals(f: Setup, d: Production, input: Input, balances: Map<number, number>) {
  const materials = (input.materials ?? keptMaterials(d)).map((m) => {
    const base = m.index === undefined ? undefined : d.materials[m.index];
    return { stockId: m.stockId ?? base?.stockId, issued: m.issued, returned: m.returned ?? base?.returned ?? '0' };
  });
  const productId = input.productId ?? d.productId,
    good = input.goodQuantity ?? d.goodQuantity,
    scrap = input.scrapQuantity ?? d.scrapQuantity;
  const was = contribution(d),
    now = contribution({ finishedStockId: f.finishedOf.get(productId), goodQuantity: good, materials });
  const sameMaterials =
    materials.length === d.materials.length &&
    materials.every((m, i) => m.stockId === d.materials[i].stockId && units(m.issued) === units(d.materials[i].issued) && (input.materials?.[i].index ?? i) === i);
  return {
    库存不足: [...new Set([...was.keys(), ...now.keys()])].some((k) => (balances.get(k) ?? 0) + (now.get(k) ?? 0) - (was.get(k) ?? 0) < 0),
    '合格、报废都是 0': !units(good) && !units(scrap),
    同一原材料只能登记一次: new Set(materials.map((m) => m.stockId)).size !== materials.length,
    和原完工单一样:
      units(good) === units(d.goodQuantity) && units(scrap) === units(d.scrapQuantity) && sameMaterials && productId === d.productId && (input.taskId === undefined ? d.taskId : input.taskId) === d.taskId,
  };
}

/** 每一步之后：库存守恒；余额等于期初加减有效完工、减领用；任务已入库等于有效完工之和；订单状态由任务完成情况派生 */
function assertDerived(f: Setup) {
  const balances = assertLedger(f.store, f.ops);
  const docs = effectiveIds(f.store, 'production').map((id) => f.flow.get(id, 'production'));
  const stock = new Map<number, number>(),
    completed = new Map<number, number>();
  for (const d of docs) {
    for (const [k, n] of contribution(d)) addTo(stock, k, n);
    if (d.taskId) addTo(completed, d.taskId, units(d.goodQuantity));
  }
  for (const s of f.stocks) {
    const opening = s.kind === 'raw' ? OPENING : 0;
    assert.equal(balances.get(s.id), opening + (stock.get(s.id) ?? 0) - (f.used.get(s.id) ?? 0), s.name + '的余额');
  }
  for (const t of f.tasks) assert.equal(units(f.flow.get(t.id, 'task').completed), completed.get(t.id) ?? 0, '任务的已入库');
  const made = (completed.get(f.tasks[0].id) ?? 0) + (completed.get(f.tasks[1].id) ?? 0);
  assert.equal(f.store.order(f.order.id, true)?.status, made >= ORDERED ? '待发货' : '生产中', '订单状态由有效完工派生');
}

/** 改一次完工：拒绝只因为该拒的原因；办成了任务影响的前后和真的一样 */
function correctOnce(f: Setup, d: Production, input: Input) {
  const expected = expectedRefusals(f, d, input, assertLedger(f.store, f.ops));
  const completed = () => new Map(f.tasks.map((t) => [t.id, units(f.flow.get(t.id, 'task').completed)]));
  const before = completed();
  const outcome = attemptCorrection(f.store, f.ops, {
    id: d.id,
    input: { expectedVersion: d.version, reason: '虚构更正', ...input },
    who: localAdmin(),
    refusable: REFUSABLE,
  });
  if (!outcome.ok) {
    const reason = Object.entries(expected).find(([k]) => outcome.refused.includes(k));
    assert.ok(reason?.[1], '被拒的原因要成立：' + outcome.refused + ' ' + JSON.stringify(expected));
    return;
  }
  assert.ok(Object.values(expected).every((v) => !v), '该拒的没拒：' + JSON.stringify(expected));
  const after = completed();
  for (const t of ofKind(outcome.plan, 'production').taskImpact)
    assert.deepEqual([units(t.before), units(t.after)], [before.get(t.id), after.get(t.id)], '预览的任务已入库前后');
}

function step(f: Setup, op: Op) {
  if (op.t === 'use') return useStock(f.flow, f.stocks[op.stock].id, op.q, f.used);
  const ids = effectiveIds(f.store, 'production');
  if (!ids.length) return;
  const d = f.flow.get(ids[op.doc % ids.length], 'production');
  if (op.t === 'undo') return reverseChecked(f, d, contribution(d), f.actor);
  const input = correctionOf(f, op, {}, d);
  if (input) correctOnce(f, d, input);
}

test('完工：任意一串改合格报废、改领料、加删换纸板、换挂任务产品、领用、撤销，每步之后库存守恒、任务已入库和订单状态由有效完工派生，拒绝只因该拒的原因', () => {
  fc.assert(
    fc.property(doneArb, fc.array(opArb, { minLength: 5, maxLength: 9 }), (done, ops) => {
      const f = setup(done);
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

test('完工：成品用掉一部分以后再改少、或多领纸板，会出负库存的被拒、库里不变，不会的照办', () => {
  fc.assert(
    fc.property(doneArb, fc.nat(3), fc.integer({ min: 1, max: 600 }), fc.oneof(opArb.filter((op) => op.t === 'good' || op.t === 'issue')), (done, stock, q, op) => {
      const f = setup(done);
      try {
        useStock(f.flow, f.stocks[stock].id, q, f.used);
        step(f, op);
        assertDerived(f);
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 7 },
  );
});

test('完工：改成别的样子（合格数、领料、换纸板、换挂任务和产品）再改回原样，库存、任务已入库、订单状态都回到第一次更正之前', () => {
  fc.assert(
    fc.property(doneArb, fc.array(opArb, { minLength: 1, maxLength: 4 }), (done, edits) => {
      const f = setup(done);
      try {
        const a = f.flow.get(effectiveIds(f.store, 'production')[0], 'production');
        const state = () => ({
          balances: [...assertLedger(f.store, f.ops)],
          completed: f.tasks.map((t) => f.flow.get(t.id, 'task').completed),
          status: f.store.order(f.order.id, true)?.status,
        });
        const before = state();
        const input = edits.reduce<Input>((now, op) => correctionOf(f, op, now, a) ?? now, {});
        const b = attemptCorrection(f.store, f.ops, { id: a.id, input: { expectedVersion: a.version, reason: '虚构改成 B', ...input }, who: localAdmin(), refusable: REFUSABLE });
        if (!b.ok) return;
        const replaced = f.flow.get(b.result.replacementId, 'production');
        const back = {
          goodQuantity: a.goodQuantity,
          scrapQuantity: a.scrapQuantity,
          materials: a.materials.map((m) => ({ stockId: m.stockId, issued: m.issued, returned: m.returned })),
          productId: a.productId,
          taskId: a.taskId ?? null,
        };
        const result = attemptCorrection(f.store, f.ops, { id: replaced.id, input: { expectedVersion: replaced.version, reason: '虚构改回 A', ...back }, who: localAdmin(), refusable: /^$/ });
        assert.ok(result.ok);
        assert.deepEqual(state(), before, '改回原样以后库存、任务已入库、订单状态回到第一次更正之前');
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 6 },
  );
});
