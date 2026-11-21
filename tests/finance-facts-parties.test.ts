// 财务从业务拿数据的只读窗口（server/flow/finance-facts/）：往来单位一组的口径，窗口每个函数都只读、只交出数据。
// 全部是虚构数据，只用内存库。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { AppError, one } from '../server/core/index.js';
import { requirePartyName } from '../server/finance/core.js';
import { financeFacts } from '../server/flow/index.js';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';

/** 两个客户、两个供应商，各归档一个 */
function world() {
  const base = businessBase(actor);
  const kept = base.customer({ name: '虚构客户甲' }),
    archived = base.customer({ name: '虚构客户乙' }),
    supplier = base.supplier({ name: '虚构供应商甲' }),
    oldSupplier = base.supplier({ name: '虚构供应商乙' });
  base.store.markArchived('customers', archived.id, actor.id);
  base.store.markArchived('suppliers', oldSupplier.id, actor.id);
  return { db: base.store.db, kept: kept.id, archived: archived.id, supplier: supplier.id, oldSupplier: oldSupplier.id };
}
type World = ReturnType<typeof world>;

test('单位名称：一批编号一次查完，名字按编号对上，找不到的不在结果里，归档的照样有名字', () => {
  const w = world();
  const missing = w.kept + w.archived + w.supplier + w.oldSupplier;
  const customers = financeFacts.parties.names(w.db, 'customer', [w.archived, missing, w.kept]);
  assert.deepEqual([...customers], [[w.archived, '虚构客户乙'], [w.kept, '虚构客户甲']]);
  const suppliers = financeFacts.parties.names(w.db, 'supplier', [w.supplier, w.oldSupplier]);
  assert.deepEqual([...suppliers], [[w.supplier, '虚构供应商甲'], [w.oldSupplier, '虚构供应商乙']]);
  // 客户、供应商分开查：同一个编号当客户查，拿到的不是供应商的名字
  assert.notEqual(financeFacts.parties.names(w.db, 'customer', [w.supplier]).get(w.supplier), '虚构供应商甲');
  // 编号是文字（对账单的单位编号）照样按数字对上，结果按传进来的写法取
  assert.equal(financeFacts.parties.names(w.db, 'customer', [String(w.kept)]).get(String(w.kept)), '虚构客户甲');
  assert.equal(financeFacts.parties.names(w.db, 'supplier', []).size, 0);
});

test('选单位的名单：不含已归档的，新建的在前，客户、供应商各一份', () => {
  const w = world();
  assert.deepEqual(financeFacts.parties.options(w.db, 'customer'), [{ id: w.kept, name: '虚构客户甲' }]);
  assert.deepEqual(financeFacts.parties.options(w.db, 'supplier'), [{ id: w.supplier, name: '虚构供应商甲' }]);
  const base = businessBase(actor);
  const first = base.customer({ name: '虚构客户一' }),
    second = base.customer({ name: '虚构客户二' });
  assert.deepEqual(financeFacts.parties.options(base.store.db, 'customer').map((p) => p.id), [second.id, first.id]);
});

test('财务取一个单位的名字：有就给名字，没有报“往来单位不存在。”（404）', () => {
  const w = world();
  assert.equal(requirePartyName(w.db, 'supplier', w.oldSupplier), '虚构供应商乙');
  assert.throws(
    () => requirePartyName(w.db, 'customer', w.kept + w.archived + w.supplier + w.oldSupplier),
    (e: unknown) => e instanceof AppError && e.status === 404 && e.message === '往来单位不存在。',
  );
});

/**
 * 窗口每个函数跑一遍用的调用。按 financeFacts 的结构定类型：以后加组、加函数，这里不写调用就编译不过，
 * 下面的测试也按 financeFacts 实际有的函数逐个核对，漏写的报出来。
 */
/** 一张合结构的退货单内容原文（解析原文的纯函数用） */
const sampleReturn = JSON.stringify({
  requestId: 'fict-return',
  reason: '虚构质量问题',
  arrivalNumber: '虚构到货',
  supplierId: 1,
  supplierName: '虚构供应商',
  lines: [{ lineIndex: 0, stockId: null, name: '虚构纸板', unit: '张', purchaseLineId: null, quantity: '1' }],
});
/** 库存一组要的登记时间点（虚构） */
const mark = { ranAt: '2026-03-01T00:00:00.000Z', maxRowid: 0 };
type Calls = { [G in keyof typeof financeFacts]: { [F in keyof (typeof financeFacts)[G]]: (w: World) => unknown } };
const calls: Calls = {
  parties: {
    names: (w) => financeFacts.parties.names(w.db, 'customer', [w.kept, w.archived]),
    options: (w) => financeFacts.parties.options(w.db, 'supplier'),
  },
  purchases: {
    lines: (w) => financeFacts.purchases.lines(w.db, [1, 2]),
    returnHeads: (w) => financeFacts.purchases.returnHeads(w.db),
    returnRows: (w) => financeFacts.purchases.returnRows(w.db, [1]),
    returnLines: () => financeFacts.purchases.returnLines({ id: 1, number: '虚构退货', document: sampleReturn }),
    hasConfirmedReturn: (w) => financeFacts.purchases.hasConfirmedReturn(w.db, 1),
  },
  stock: {
    movements: (w) =>
      financeFacts.stock.movements(w.db, { dates: { before: '2026-02-01' }, after: mark, asOf: mark, exclude: ['1'] }),
    balancesBefore: (w) => financeFacts.stock.balancesBefore(w.db, { start: '2026-02-01', end: '2026-02-28', asOf: mark, exclude: [] }),
    openingBalances: (w) => financeFacts.stock.openingBalances(w.db, '2026-02-01', []),
    manualMovements: (w) => financeFacts.stock.manualMovements(w.db, { from: '2026-02-01', to: '2026-02-28', ids: ['m'], exclude: [] }),
    reversalOriginals: (w) => financeFacts.stock.reversalOriginals(w.db, [{ sourceId: '1', itemId: 1 }]),
    completionOriginals: (w) => financeFacts.stock.completionOriginals(w.db, [{ sourceId: '1', itemId: 1 }]),
    undoneArrivals: (w) => financeFacts.stock.undoneArrivals(w.db, { stockIds: [1], end: '2026-02-28', asOf: mark, exclude: [] }),
    reversedArrivals: (w) => financeFacts.stock.reversedArrivals(w.db),
    adjustIds: (w) => financeFacts.stock.adjustIds(w.db, '2026-02-28'),
    maxRowid: (w) => financeFacts.stock.maxRowid(w.db),
    deliveryOutflows: (w) => financeFacts.stock.deliveryOutflows(w.db, '2026-02'),
  },
};

/** 只是数据：文字、数字、布尔、null，数组、Map 和普通对象里装着这些；类的实例（Store、连接、服务对象）、函数都不算 */
function isData(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isData);
  if (value instanceof Map) return [...value].every(([k, v]) => isData(k) && isData(v));
  if (typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isData);
}

const changes = z.object({ n: z.number() });
const totalChanges = (w: World) => one(w.db, changes, 'SELECT total_changes() AS n')?.n;

test('窗口每个函数都只读、只交出数据：各跑一遍，库的改动数不变，回的都是数据', () => {
  const w = world();
  const groups: Record<string, Record<string, (w: World) => unknown>> = calls;
  const listed = Object.entries(groups).flatMap(([g, fns]) => Object.keys(fns).map((f) => g + '.' + f));
  const actual = Object.entries(financeFacts).flatMap(([g, fns]) =>
    Object.entries(fns).map(([f, fn]) => {
      assert.equal(typeof fn, 'function', g + '.' + f + ' 不是函数：窗口只放只读函数');
      return g + '.' + f;
    }),
  );
  assert.deepEqual(listed.sort(), actual.sort(), '窗口的每个函数都要在 calls 里写一次调用');
  for (const [g, fns] of Object.entries(groups))
    for (const [f, call] of Object.entries(fns)) {
      const before = totalChanges(w);
      const result = call(w);
      assert.equal(totalChanges(w), before, g + '.' + f + ' 改了库');
      assert.ok(isData(result), g + '.' + f + ' 交出的不只是数据');
    }
  // 回归：认得出交出去的连接、服务对象和函数
  assert.equal(isData({ db: w.db }), false);
  assert.equal(isData([() => 1]), false);
  assert.equal(isData(new Map([[1, { name: '虚构' }]])), true);
});
