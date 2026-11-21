import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement as h, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { one, rows as tableRows } from '../server/core/index.js';
import { createApp } from '../server/app.js';
import { listen } from './http-fixture.js';
import { PurchaseReturns } from '../server/flow/returns.js';
import type { MovementView } from '../shared/business/index.js';
import {
  matchesMovement,
  movementFilterSchema,
  movementLabels,
  movementTypeOf,
  movementTypes,
  type MovementType,
} from '../shared/business/movement-filters.js';
import MovementRecords from '../src/warehouse/MovementRecords.js';
import type { Actor } from '../server/core/auth.js';
import { saveDoc } from './receive-fixture.js';
import { businessBase } from './business-base-fixture.js';

// 全部是虚构数据，只用内存库。
const actor: Actor = pageActor({ id: 'movement-type-test', name: '虚构仓库员', permissions: ['business:edit'] });
const superActor = (): Actor => ({
  ...actor,
  role: 'super_admin',
  superAdminMode: true,
  superAdminUntil: Date.now() + 600000,
});

/** 每种流水各来一条以上：到货、生产领料 / 退料 / 完工、发货、撤销、采购退货、手工、系统维护。 */
function worldBase() {
  const base = businessBase(actor),
    { store, ops, flow } = base,
    returns = new PurchaseReturns(store);
  const customer = base.customer({ name: '虚构流水客户' });
  const product = base.product({ name: '虚构流水纸箱' });
  const supplier = base.supplier({ name: '虚构流水供应商' });
  const rawInput = {
    name: '虚构五层纸板',
    kind: 'raw',
    unit: '张',
    length: 100,
    width: 80,
    height: null,
    dimensionUnit: 'cm',
    material: 'K=A',
    flute: 'BC',
    specification: '100×80cm',
    notes: '',
    productId: null,
  };
  const raw = base.raw(rawInput),
    finished = base.finished(product, { ...rawInput, name: '虚构成品纸箱', kind: 'finished', unit: '只', productId: product.id, specification: '型号A' });
  const order = base.order(
    customer,
    [base.line(product, 100, { productName: product.name, specification: '型号A', unitPriceCents: 123, notes: '' })],
    { notes: '', costs: null },
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: null,
      orderDate: '2026-10-01',
      expectedDate: '2026-10-20',
      status: '已订货',
      notes: '',
      lines: [{ ...rawInput, stockItemId: raw.id, quantity: '200', unitPrice: '2.1234', priceBasis: 'area' }],
    },
    actor,
  );
  return { store, ops, flow, check: base.check, returns, customer, product, supplier, rawInput, raw, finished, order, purchase };
}

function world() {
  const base = worldBase();
  const { store, ops, flow, returns, customer, product, supplier, rawInput, raw, finished, order, purchase } = base;
  const confirm = (d: { id: number }) => base.check(d);
  const arrival = confirm(
    saveDoc(flow, 
      'arrival',
      {
        date: '2026-10-20',
        supplierId: supplier.id,
        reference: '虚构到货-' + randomUUID(),
        lines: [
          { stockId: raw.id, purchaseLineId: purchase.lines[0].id, item: rawInput, quantity: '100', unitPrice: '2.1234', priceBasis: 'area' },
        ],
      },
      actor,
    ),
  );
  confirm(
    saveDoc(flow, 
      'production',
      {
        date: '2026-10-21',
        productId: product.id,
        finishedStockId: finished.id,
        goodQuantity: '60',
        scrapQuantity: '0',
        operator: '虚构机长',
        materials: [{ stockId: raw.id, issued: '80', returned: '10' }],
      },
      actor,
    ),
  );
  // 采购退货，再撤销一张退货
  returns.create(actor, { arrivalId: arrival.id, date: '2026-10-21', reason: '虚构破损', requestId: randomUUID(), lines: [{ lineIndex: 0, quantity: '2' }] });
  const back = returns.create(actor, { arrivalId: arrival.id, date: '2026-10-21', reason: '虚构破损', requestId: randomUUID(), lines: [{ lineIndex: 0, quantity: '3' }] });
  returns.reverse(superActor(), back.id, { version: back.version, reason: '虚构误退' });
  // 发货，再撤销
  const delivery = confirm(
    saveDoc(flow, 
      'delivery',
      {
        date: '2026-10-22',
        customerId: customer.id,
        lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: '40' }],
      },
      actor,
    ),
  );
  flow.reverse(delivery.id, { version: flow.get(delivery.id).version, reason: '虚构撤销', acknowledged: true }, superActor());
  const move = (id: number, action: 'in' | 'out' | 'adjust', quantity: string, date: string, notes: string) => {
    const item = ops.repo.items(true, id)[0];
    assert.ok(item);
    return ops.move(
      id,
      { expectedVersion: item.version, requestId: randomUUID(), action, quantity, date, notes, acknowledged: true },
      actor,
    );
  };
  move(raw.id, 'in', '10', '2026-10-23', '虚构手工入库');
  move(raw.id, 'out', '3', '2026-10-23', '虚构手工出库');
  move(finished.id, 'adjust', '55', '2026-10-24', '虚构盘点');
  // 系统维护留下的流水（没有对应的界面入口，直接写入内存库）
  const insert = store.db.prepare('INSERT INTO stock_movements(id,item_id,action,delta_units,before_units,after_units,source_kind,source_id,purchase_line_id,customer_order_id,date,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const direct = (action: string, delta: number, sourceKind: string, sourceId: string | null, notes: string) => {
    const before = ops.repo.balance(raw.id);
    insert.run(randomUUID(), raw.id, action, delta, before, before + delta, sourceKind, sourceId, null, null, '2026-10-19', notes, actor.id, actor.name, new Date().toISOString());
  };
  direct('in', 1000, 'database-maintenance', null, '虚构系统维护');
  return { store, ops, flow, raw, finished, move };
}

const expected: Record<MovementType, number> = {
  purchase: 1,
  production_issue: 1,
  production_return: 1,
  production_output: 1,
  delivery: 1,
  purchase_return: 2,
  reversal: 2, // 撤销退货 + 撤销发货
  in: 1,
  out: 1,
  adjust: 1,
  maintenance: 1,
};

test('流水类型按来源单据分：生产领料、退料、完工入库、客户发货、撤销各归各类，手动出库只算没有来源单据的', () => {
  const w = world();
  try {
    const all = w.ops.repo.movements();
    const counts = Object.fromEntries(movementTypes.map((t) => [t, all.filter((m) => movementTypeOf(m) === t).length]));
    assert.deepEqual(counts, expected);
    // 每条流水只有一种类型，全部类型加起来就是全部流水
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), all.length);
    const typed = (t: MovementType) => all.filter((m) => movementTypeOf(m) === t);
    assert.deepEqual(typed('production_issue').map((m) => [m.kind, m.direction, m.delta]), [['raw', '-', '80']]);
    assert.deepEqual(typed('production_return').map((m) => [m.kind, m.direction, m.delta]), [['raw', '+', '10']]);
    assert.deepEqual(typed('production_output').map((m) => [m.kind, m.direction, m.delta]), [['finished', '+', '60']]);
    assert.deepEqual(typed('delivery').map((m) => [m.kind, m.direction, m.delta]), [['finished', '-', '40']]);
    assert.ok(typed('reversal').every((m) => m.source_kind !== 'manual'));
    // 手动入库、出库、盘点只有手工登记的，不再把领料、发货、退货算进手动出库
    for (const t of ['in', 'out', 'adjust'] as const)
      assert.ok(typed(t).every((m) => m.source_kind === 'manual'), t);
    assert.deepEqual(typed('out').map((m) => m.notes), ['虚构手工出库']);
    // 每种类型都有中文名，下拉里一项不少
    for (const t of movementTypes) assert.ok(movementLabels[t] && !/[a-z]/i.test(movementLabels[t]), t);
    assert.equal(movementLabels.production_issue, '生产领料');
    assert.equal(movementLabels.reversal, '单据撤销');
  } finally {
    w.store.close();
  }
});

test('按类型筛选：SQL 筛出的和按 movementTypeOf 判断的完全一致，有关键词、分页、计数也一样', async () => {
  const w = world();
  const server = await listen(createApp(w.store));
  const base = server.origin + '/api/warehouse/movements';
  try {
    const repo = w.ops.repo,
      all = repo.movements();
    for (const action of movementTypes) {
      const want = all.filter((m) => movementTypeOf(m) === action);
      assert.deepEqual(repo.movements({ action }), want, action);
      assert.equal(repo.movementCount({ action }), want.length, action);
      // 有关键词时走另一条路（先取筛选列再按关键词匹配），结果相同
      assert.deepEqual(
        repo.movements({ action, q: '虚构' }),
        want.filter((m) => matchesMovement(m, { q: '虚构' })),
        action + ' q',
      );
      for (const kind of ['raw', 'finished'] as const)
        assert.deepEqual(repo.movements({ action, kind }), want.filter((m) => m.kind === kind), action + kind);
      const page = repo.movementPage({ action }, 1, 2);
      assert.deepEqual(page.rows, want.slice(0, 2), action + ' page');
      assert.equal(page.totals.length, want.length);
      // 前端拿到一页后再用同一个函数筛一遍，不会多也不会少
      assert.deepEqual(page.rows.filter((m) => matchesMovement(m, { action })), page.rows);
    }
    const http = z
      .object({
        filteredRecords: z.number(),
        rows: z.array(z.object({ delta: z.string() })),
        metrics: z.array(z.object({ itemId: z.number(), outgoing: z.string(), incoming: z.string() })),
      })
      .parse(await (await fetch(base + '?withMetrics=1&page=1&pageSize=50&action=production_issue')).json());
    assert.equal(http.filteredRecords, 1);
    assert.equal(http.rows[0].delta, '80');
    // 汇总只算筛出来的流水：原材料出库 80，成品这一类没有
    const byItem = new Map(http.metrics.map((g) => [g.itemId, g]));
    const rawMetrics = byItem.get(w.raw.id);
    assert.ok(rawMetrics);
    assert.equal(rawMetrics.outgoing, '80');
    assert.equal(rawMetrics.incoming, '0');
    // 旧的四个取值照样能用，意思是没有来源单据的手工流水和采购到货
    assert.equal(z.array(z.unknown()).parse(await (await fetch(base + '?action=out')).json()).length, 1);
    assert.equal(z.array(z.unknown()).parse(await (await fetch(base + '?action=purchase')).json()).length, 1);
    assert.equal((await fetch(base + '?action=delete')).status, 400);
    assert.equal(movementFilterSchema.safeParse({ action: 'reversal' }).success, true);
  } finally {
    await server.close();
    w.store.close();
  }
});

test('流水按业务日期倒序，同一天按记录时间、写入顺序倒序；分页、关键词、按库存品都一样', () => {
  const w = world();
  try {
    const { store, ops, raw, finished, move } = w;
    // 业务日期和登记顺序故意打乱：先登记的日期反而晚
    move(finished.id, 'in', '1', '2026-10-30', '排序-晚');
    move(finished.id, 'in', '1', '2026-10-02', '排序-早');
    move(finished.id, 'in', '1', '2026-10-30', '排序-同日后登记');
    move(finished.id, 'in', '1', '2026-10-15', '排序-中');
    // 同一天：记录时间更晚的排前面，即使写入顺序更早
    const first = one(store.db, tableRows.stock_movements.pick({ id: true }), "SELECT id FROM stock_movements WHERE notes='排序-晚'");
    assert.ok(first);
    store.db.prepare('UPDATE stock_movements SET created_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', first.id);
    const rowids = new Map(
      z
        .array(z.object({ id: z.string(), r: z.number() }))
        .parse(store.db.prepare('SELECT id,rowid AS r FROM stock_movements').all())
        .map((r) => [String(r.id), Number(r.r)]),
    );
    const rowidOf = (id: string) => {
      const rowid = rowids.get(id);
      assert.ok(rowid !== undefined, '流水 ' + id + ' 没有 rowid');
      return rowid;
    };
    const sorted = (rows: MovementView[]) =>
      [...rows].sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.created_at.localeCompare(a.created_at) ||
          rowidOf(b.id) - rowidOf(a.id),
      );
    const all = ops.repo.movements();
    assert.deepEqual(all.map((m) => m.id), sorted(all).map((m) => m.id));
    assert.deepEqual(
      ops.repo.movements({ q: '排序' }).map((m) => m.notes),
      ['排序-晚', '排序-同日后登记', '排序-中', '排序-早'],
    );
    // 不是按登记先后：后登记的 10-30 排在先登记的盘点（10-24）前面，最早登记的到货（10-20）排在它们后面
    const at = (f: (m: MovementView) => boolean) => all.findIndex(f);
    assert.ok(at((m) => m.notes === '排序-晚') < at((m) => m.notes === '虚构盘点'));
    assert.ok(at((m) => m.notes === '虚构盘点') < at((m) => m.source_kind === 'flow_arrival'));
    assert.ok(at((m) => m.source_kind === 'flow_arrival') < at((m) => m.notes === '排序-早'));
    // 分页、关键词分页、按库存品、按类型都保持同一顺序
    for (const q of [{}, { q: '虚构' }, { itemId: raw.id }, { itemId: finished.id }, { kind: 'finished' as const }, { action: 'in' as const }]) {
      const rows = ops.repo.movements(q);
      assert.deepEqual(rows.map((m) => m.id), sorted(rows).map((m) => m.id), JSON.stringify(q));
      assert.deepEqual(ops.repo.movements(q, { offset: 2, limit: 3 }), rows.slice(2, 5), JSON.stringify(q));
      assert.deepEqual(ops.repo.movementPage(q, 2, 3).rows, rows.slice(3, 6), JSON.stringify(q));
    }
  } finally {
    w.store.close();
  }
});

test('流水页：明细的类型用来源单据的叫法，按产品汇总的行能点进这个库存品，不露内部编号', () => {
  const w = world();
  try {
    const rows = w.ops.repo.movements();
    const common = {
      rows,
      summary: [
        {
          itemId: 987654,
          name: '虚构汇总纸板',
          specification: '',
          kind: 'raw',
          unit: '张',
          incoming: '3',
          outgoing: '1',
          currentQuantity: '2',
          archived: false,
        },
      ],
      totalRecords: rows.length,
      filteredRecords: rows.length,
      pageSize: 50,
      page: 1,
      onPage: () => {},
      item: null,
      onClearItem: () => {},
      onView: () => {},
      onPickItem: () => {},
    };
    const details = renderToStaticMarkup(
      h(MovementRecords, { ...common, view: 'details' } satisfies ComponentProps<typeof MovementRecords>),
    );
    for (const label of ['生产领料', '生产退料', '生产完工入库', '客户发货', '单据撤销', '采购退货', '采购到货', '系统维护'])
      assert.ok(details.includes('>' + label + '<'), label);
    assert.doesNotMatch(details, /库存品编号|#\d/);
    const summary = renderToStaticMarkup(
      h(MovementRecords, { ...common, view: 'summary' } satisfies ComponentProps<typeof MovementRecords>),
    );
    assert.match(summary, /aria-label="看 虚构汇总纸板 的流水"/);
    assert.doesNotMatch(summary, /987654|库存品编号/);
  } finally {
    w.store.close();
  }
});

test('流水详情的修订记录：数量带正负号，和详情上面的“数量 -1000 只”对得上；数量没变也照样带符号', async () => {
  const { signedQuantity } = await import('../src/warehouse/MovementDetail.js');
  // 千分整数：出库 1000 只存成 -1000000，入库 300 张存成 300000
  assert.equal(signedQuantity(-1000000), '-1000');
  assert.equal(signedQuantity(300000), '+300');
  assert.equal(signedQuantity(-1500), '-1.5');
  assert.equal(signedQuantity(0), '0');
});
