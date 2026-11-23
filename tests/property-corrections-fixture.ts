// 单据更正属性测试（property-corrections-*.test.ts）共用的：整库快照、库存守恒、试一次更正、领用、撤销、加行换挂挑没占的
// （拒了库里不变；办了就核对预览和执行一致、同一请求号重发不重复、版本不对被拒）。内存库、虚构数据。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/index.js';
import { AppError } from '../server/core/errors.js';
import { correctDocument, planCorrection } from '../server/flow/index.js';
import type { OperationsService } from '../server/operations/index.js';
import type { FlowService } from '../server/flow/index.js';
import { quantityString, quantityUnits } from '../shared/core/quantity.js';
import { clerk } from './flow-fixture.js';

/** 每个库按表备好的读全表语句（快照一步要做好几次，语句只备一次） */
const readers = new WeakMap<Store, { name: string; read: () => unknown[] }[]>();
function tableReaders(store: Store) {
  const cached = readers.get(store);
  if (cached) return cached;
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const list = tables.map((t) => {
    const statement = store.db.prepare('SELECT * FROM "' + String(t.name) + '"');
    return { name: String(t.name), read: () => statement.all() };
  });
  readers.set(store, list);
  return list;
}

/** 整库快照：每张表的全部行（拒绝以后库里要和之前完全一样）。测试里不建表，表的清单按库记一次 */
function snapshot(store: Store) {
  return JSON.stringify(tableReaders(store).map((t) => [t.name, t.read()]));
}

/** 每个库存品的余额等于它全部流水之和、不为负；返回 库存品 → 余额（千分整数） */
export function assertLedger(store: Store, ops: OperationsService) {
  const sums = new Map(
    store.db
      .prepare('SELECT item_id, SUM(delta_units) AS s FROM stock_movements GROUP BY item_id')
      .all()
      .map((r) => [Number(r.item_id), Number(r.s)]),
  );
  const balances = new Map<number, number>();
  for (const it of ops.items(true)) {
    assert.equal(it.balanceUnits, sums.get(it.id) ?? 0, it.name + '的余额等于流水之和');
    assert.equal(ops.balance(it.id), it.balanceUnits);
    assert.ok(it.balanceUnits >= 0, it.name + '的余额不为负');
    balances.set(it.id, it.balanceUnits);
  }
  return balances;
}

/** 这种单据现在有效的那几张（已核对、没被撤销或更正掉） */
export function effectiveIds(store: Store, kind: 'arrival' | 'delivery' | 'production') {
  return store.db
    .prepare("SELECT id FROM flow_documents WHERE kind=? AND status='confirmed' ORDER BY id")
    .all(kind)
    .map((r) => Number(r.id));
}

/** 按库存品合计（千分整数）加一笔 */
export const addTo = (m: Map<number, number>, id: number, units: number) => m.set(id, (m.get(id) ?? 0) + units);

/** 一次更正要的东西：哪张、按什么改、谁改；refusable 是允许的拒绝说法 */
type Attempt = { id: number; input: { expectedVersion: number } & Record<string, unknown>; who: Actor; refusable: RegExp };
/** 预览、结果里都有的库存影响 */
type Impact = { stockId: number | null; deltaUnits: number; before: string | null; after: string | null };

/** 业务上的拒绝：只许是 AppError、说法在 refusable 里；别的错照抛（是真问题） */
function refusal(e: unknown, refusable: RegExp) {
  if (e instanceof AppError && refusable.test(e.message)) return e.message;
  throw e;
}

/** 预览说的库存变化和真的执行以后一样：变了的库存品前后、差多少都对，没列出的库存品不动；新流水按库存品合计等于差 */
function assertImpact(impact: Impact[], before: Map<number, number>, after: Map<number, number>, fresh: Map<number, number>) {
  const listed = new Set<number>();
  for (const s of impact) {
    if (s.stockId === null) continue;
    listed.add(s.stockId);
    const was = before.get(s.stockId) ?? 0,
      now = after.get(s.stockId) ?? 0;
    assert.equal(quantityUnits(s.before ?? '0'), was, '预览的更正前库存');
    assert.equal(quantityUnits(s.after ?? '0'), now, '预览的更正后库存');
    assert.equal(now - was, s.deltaUnits, '预览的净变化');
    assert.equal(fresh.get(s.stockId) ?? 0, s.deltaUnits, '新写的流水合计等于净变化');
  }
  for (const [id, units] of after) if (!listed.has(id)) assert.equal(units, before.get(id) ?? 0, '预览没列的库存品不动');
  for (const [id, units] of fresh) if (!listed.has(id)) assert.equal(units, 0, '预览没列的库存品没有净流水');
}

/** 某条流水编号之后新写的流水，按库存品合计 */
function movementsAfter(store: Store, rowid: number) {
  const m = new Map<number, number>();
  for (const r of store.db.prepare('SELECT item_id, delta_units FROM stock_movements WHERE rowid>?').all(rowid))
    addTo(m, Number(r.item_id), Number(r.delta_units));
  return m;
}
const lastRowid = (store: Store) => Number(store.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM stock_movements').get()?.n ?? 0);

/**
 * 试一次更正：预览或提交被拒（说法要在 refusable 里）时库里和之前完全一样，返回拒绝的话；
 * 办成了核对预览和执行一致、同一请求号重发结果一样且不再写库、拿不对的版本和已被更正掉的原单再更正都被拒。
 * 返回 { plan, result } 交给各种单据再核对自己的影响（采购、订单、任务）。
 */
export function attemptCorrection(store: Store, ops: OperationsService, a: Attempt) {
  const before = snapshot(store),
    balances = assertLedger(store, ops);
  const planned = previewOrRefusal(store, a);
  assert.equal(snapshot(store), before, '预览不写库，被拒也不写：' + planned.refused);
  if (!planned.plan) return { ok: false as const, refused: planned.refused };
  const plan = planned.plan;
  const body = { ...a.input, previewDigest: plan.previewDigest, requestId: randomUUID() },
    mark = lastRowid(store);
  const result = correctDocument(store, a.id, body, a.who);
  const after = assertLedger(store, ops);
  assertImpact(plan.stockImpact, balances, after, movementsAfter(store, mark));
  assert.deepEqual(result.stockImpact, plan.stockImpact, '执行交回的库存影响和预览一样');
  const done = snapshot(store);
  assert.deepEqual(correctDocument(store, a.id, body, a.who), result, '同一请求号重发，结果和第一次一样');
  const version = Number(store.db.prepare('SELECT version FROM flow_documents WHERE id=?').get(result.replacementId)?.version);
  const rejected = (pattern: RegExp) => (e: unknown) => e instanceof AppError && e.status === 409 && pattern.test(e.message);
  assert.throws(() => planCorrection(store, result.replacementId, { ...a.input, expectedVersion: version + 1 }, a.who), rejected(/版本已改变/));
  assert.throws(
    () => correctDocument(store, a.id, { ...body, requestId: randomUUID() }, a.who),
    rejected(/只能更正有效的/),
    '拿更正前的原单和它的旧版本再提交被拒',
  );
  assert.equal(snapshot(store), done, '同一请求号重发、被拒的旧版本都不写库');
  return { ok: true as const, plan, result };
}

/** 出预览；被拒时交回拒绝的话 */
function previewOrRefusal(store: Store, a: Attempt) {
  try {
    return { plan: planCorrection(store, a.id, a.input, a.who), refused: '' };
  } catch (e) {
    return { plan: null, refused: refusal(e, a.refusable) };
  }
}

/** 手工领用（出库）q 张或只，最多领到余额为止；领了多少记进 used（库存品 → 千分整数） */
export function useStock(flow: FlowService, stockId: number, q: number, used: Map<number, number>) {
  const item = flow.ops.items(true, stockId)[0],
    take = Math.min(q * 1000, item.balanceUnits);
  if (!take) return;
  const input = { expectedVersion: item.version, requestId: randomUUID(), action: 'out', quantity: quantityString(take), date: '2026-10-20', notes: '虚构领用', acknowledged: true };
  flow.stock.move(stockId, input, clerk);
  addTo(used, stockId, take);
}

/**
 * 撤销整张单（入过库的扣回、出过库的加回）：stock 是这张单按库存品入了多少（出库为负）。
 * 只有库存不够扣回才被拒，被拒库里不变。撤销完工要超级管理员（who）
 */
export function reverseChecked(f: { store: Store; ops: OperationsService; flow: FlowService }, d: { id: number; version: number }, stock: Map<number, number>, who: Actor = clerk) {
  const balances = assertLedger(f.store, f.ops),
    short = [...stock].some(([id, n]) => (balances.get(id) ?? 0) < n),
    before = snapshot(f.store);
  try {
    f.flow.reverse(d.id, { version: d.version, reason: '虚构撤销', acknowledged: true }, who);
    assert.ok(!short, '库存不够扣回却撤销成了');
  } catch (e) {
    if (!(e instanceof AppError && /库存不足/.test(e.message))) throw e;
    assert.ok(short, '库存够扣回却被拒：' + e.message);
    assert.equal(snapshot(f.store), before);
  }
}

/** 从 all 里挑第 n 个没被占的（加行、换挂不撞上单上已有的）；都占了是 null */
export function freeChoice(all: readonly number[], taken: Iterable<unknown>, n: number) {
  const used = new Set(taken),
    free = all.filter((x) => !used.has(x));
  return free.length ? free[n % free.length] : null;
}
