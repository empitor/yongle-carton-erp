// 算成本前要人填的、已算成本月份的改动、跨期补登、结账核对（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store, one, rows } from '../server/core/index.js';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/index.js';
import { FinanceSettings } from '../server/finance/base/settings.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceCosting } from '../server/finance/costing/costing.js';
import { FinanceClosing } from '../server/finance/reports/closing.js';
import { maker, fixture } from './finance-costing-fixture.js';
import { booked } from './finance-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { FinanceMargin } from '../server/finance/costing/margin.js';
import { MonthCostBook, type Item } from '../server/finance/costing/costing-month.js';
import { spreadAdjustment } from '../server/finance/costing/costing-invoice-adjust.js';
import type { StockMovement as Movement } from '../server/flow/index.js';
import { FinanceEventHandling } from '../server/finance/events/event-handling.js';

/** 管理员改一条流水（给的数量 delta_units、说明 notes）并留修订记录，再同步财务 */
function reviseMovement(s: Store, movement: { id: string; itemId: number }, patch: { delta_units?: number; notes?: string }) {
  const before = s.db.prepare('SELECT * FROM stock_movements WHERE id=?').get(movement.id);
  assert.ok(before, '盘点流水还在');
  businessChanges(s, maker).reviseMovement(movement.id, patch);
  new FinanceEvents(s).sync(maker);
}

/** 对象上有个 compute 方法（成本服务试算用的那个） */
const hasCompute = (o: object): o is { compute: () => unknown } => 'compute' in o && typeof o.compute === 'function';

test('算成本前列出要人填的期初和手工入库，填完才能算，算完不再要求', () => {
  const s = new Store(':memory:');
  try {
    const ops = new OperationsService(s),
      flow = new FlowService(s);
    const item = ops.saveItem(
      { name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' },
      maker,
    );
    const move = (date: string, quantity: string, version: number) =>
      flow.stock.move(
        item.id,
        { action: 'in', quantity, date, notes: '虚构手工入库', expectedVersion: version, acknowledged: true, requestId: randomUUID() },
        maker,
      );
    move('2026-01-20', '10', item.version);
    new FinanceSettings(s).enable(maker, {
      period: '2026-02',
      taxpayer: 'general',
      version: 1,
      requestId: 'enable',
      rows: [],
    });
    const version = Number(s.db.prepare('SELECT version FROM stock_items WHERE id=?').get(item.id)?.version);
    move('2026-02-03', '5', version);
    const costing = new FinanceCosting(s);
    const need = costing.requirements(maker, { period: '2026-02' });
    assert.equal(need.isStart, true);
    assert.deepEqual(
      need.opening.map((o) => [o.name, o.quantity, o.unit]),
      [['虚构纸板', 10000, '张']],
    );
    assert.equal(need.valuations.length, 1);
    assert.equal(need.valuations[0].needsAmount, true);
    assert.throws(() => costing.run(maker, { period: '2026-02', requestId: 'empty' }), /期初成本/);
    costing.run(maker, {
      period: '2026-02',
      requestId: 'filled',
      opening: [{ stockId: item.id, unit: '张', quantity: 10000, amount: 10000 }],
      valuations: [
        { movementId: need.valuations[0].id, unit: '张', amount: 6000, reason: '虚构计价' },
      ],
    });
    const row = costing.list(maker, { period: '2026-02' }).rows[0];
    assert.equal(row.end_qty, 15000);
    assert.equal(row.end_cents, 16000);
    assert.equal(costing.requirements(maker, { period: '2026-02' }).done, true);
    const next = costing.requirements(maker, { period: '2026-03' });
    assert.deepEqual(next.opening, []);
    assert.deepEqual(next.valuations, []);
  } finally {
    s.close();
  }
});

test('已算成本的月份：完工单冲销、管理员改盘点流水，事件等下次成本计算或核对后放行；改了数量提示先重做上月', () => {
  const f = fixture();
  try {
    const flow = new FlowService(f.s),
      events = new FinanceEvents(f.s);
    const item = f.raw();
    f.receive(item);
    const made = f.produce(item, '2026-02-08', '5');
    const version = Number(f.s.db.prepare('SELECT version FROM stock_items WHERE id=?').get(item.id)?.version);
    const counted = flow.stock.move(
      item.id,
      { action: 'adjust', quantity: '4', date: '2026-02-20', notes: '虚构盘点', expectedVersion: version, acknowledged: true, requestId: randomUUID() },
      maker,
    ).movementId;
    events.sync(maker);
    f.cost('2026-02');
    const status = (kind: string, source: string) =>
      String(
        f.s.db
          .prepare(
            `SELECT e.status FROM fin_events e JOIN fin_source_observations x ON x.event_id=e.id
            WHERE x.source_kind=? AND x.source_id=?`,
          )
          .get(kind, source)?.status,
      );
    assert.equal(status('stock', counted), 'costed');
    // 3 月冲销 2 月的完工单：等成本计算，不是谁都处理不了的“有差异”
    f.reverse(made, '2026-03-05');
    events.sync(maker);
    assert.equal(status('production', String(made.id)), 'cost_pending');
    // 管理员改了 2 月那条盘点流水：只改说明不惊动财务；改了数量，盘点事件有差异，可以核对掉，也会被下次成本计算处理
    const revise = (patch: { delta_units?: number; notes?: string }) => reviseMovement(f.s, { id: counted, itemId: item.id }, patch);
    // 只改流水备注：备注不算进来源指纹，事件不动
    revise({ notes: '虚构盘点（补说明）' });
    assert.equal(status('stock', counted), 'costed', '只改流水备注不算来源变了');
    // 改了数量：盘点事件有差异，可以核对掉
    const delta = Number(f.s.db.prepare('SELECT delta_units FROM stock_movements WHERE id=?').get(counted)?.delta_units);
    revise({ delta_units: delta + 1000 });
    assert.equal(status('stock', counted), 'difference');
    const stuck = one(
      f.s.db,
      rows.fin_events,
      `SELECT e.* FROM fin_events e JOIN fin_source_observations x ON x.event_id=e.id
        WHERE x.source_kind='stock' AND x.source_id=?`,
      counted,
    );
    if (!stuck) throw new Error('测试数据：盘点流水没有财务事件');
    new FinanceEventHandling(f.s).acknowledgeStatisticalCorrection(maker, stuck.id, {
      version: stuck.version,
      requestId: randomUUID(),
      reason: '虚构核对',
    });
    assert.equal(status('stock', counted), 'corrected', '盘点差异可以核对掉');
    // 改了数量：3 月的期初对不上 2 月月末，提示先重做 2 月；重做后照常
    revise({ delta_units: -2000, notes: '虚构盘点（改数量）' });
    assert.equal(f.costing.stale(maker, '2026-02')?.stale, true, '2 月成本要重做');
    assert.throws(() => f.cost('2026-03'), /请先重做 2026-02 的成本计算/);
    f.costing.run(maker, { period: '2026-02', requestId: randomUUID(), redo: true });
    f.postDrafts();
    assert.equal(f.row('2026-02', item.id).endQty, 3000, '重做后按改过的数量');
    assert.ok(
      f.s.db.prepare("SELECT 1 FROM fin_period_jobs WHERE period='2026-02' AND kind='costing#1'").get(),
      '原来的执行记录留底',
    );
    f.cost('2026-03');
    assert.equal(status('production', String(made.id)), 'costed', '3 月成本计算把它算作已处理');
    assert.equal(status('stock', counted), 'costed');
    const check = new FinanceClosing(f.s).check(maker, { period: '2026-03' });
    assert.equal(check.steps.find((x) => x.key === 'events')?.ok, true, '结账的事件步骤放行');
    assert.equal(f.gl('1403', '2026-03'), f.row('2026-03', item.id).endCents, '原材料总账和库存一致');
  } finally {
    f.s.close();
  }
});

test('补登日期在已算成本月份的流水：计入第一个还没算成本的月份，成本窗口列出跨期补登；上月成本不算要重做', () => {
  const f = fixture();
  try {
    const flow = new FlowService(f.s);
    const item = f.raw();
    f.receive(item);
    f.cost('2026-02');
    const version = Number(f.s.db.prepare('SELECT version FROM stock_items WHERE id=?').get(item.id)?.version);
    const late = flow.stock.move(
      item.id,
      { action: 'in', quantity: '5', date: '2026-02-20', notes: '虚构补登', expectedVersion: version, acknowledged: true, requestId: randomUUID() },
      maker,
    ).movementId;
    // 登记时间手工写早了的补登（导入或脚本补的）：按行号也认得出
    businessChanges(f.s, maker).backdatedMovement({
      id: 'fict-backdated', item_id: item.id, action: 'in', delta_units: 2000, before_units: 15000, after_units: 17000,
      source_kind: 'manual', date: '2026-02-21', notes: '虚构补登', created_at: '2026-02-21T01:00:00Z',
    });
    const need = f.costing.requirements(maker, { period: '2026-03' });
    assert.deepEqual(need.late.map((m) => m.id).sort(), ['fict-backdated', late].sort());
    assert.deepEqual(
      need.valuations.map((v) => [v.id, v.late, v.needsAmount]).sort(),
      [
        ['fict-backdated', true, true],
        [late, true, true],
      ].sort(),
    );
    assert.equal(f.costing.stale(maker, '2026-02')?.stale, false, '补登按口径计入以后月份，2 月不用重做');
    f.cost('2026-03', [
      { movementId: late, unit: '张', amount: 5000, reason: '虚构计价' },
      { movementId: 'fict-backdated', unit: '张', amount: 2000, reason: '虚构计价' },
    ]);
    const march = f.row('2026-03', item.id);
    assert.deepEqual([march.inQty, march.inCents, march.endQty, march.endCents], [7000, 7000, 17000, 17000]);
    assert.deepEqual(f.details('2026-03').late.sort(), ['fict-backdated', late].sort());
    assert.equal(f.row('2026-02', item.id).endQty, 10000, '2 月的成本不动');
    assert.equal(f.gl('1403', '2026-03'), 17000, '总账和库存一致');
    f.cost('2026-04');
    assert.equal(f.row('2026-04', item.id).endQty, 17000, '下个月不再重复计入');
  } finally {
    f.s.close();
  }
});

test('本月成本算完以后又冲销同月的完工单：结账不被“待算成本”卡住，冲销流水计入下月成本', () => {
  const f = fixture();
  try {
    const events = new FinanceEvents(f.s);
    const item = f.raw();
    f.receive(item);
    const made = f.produce(item, '2026-02-08', '5');
    events.sync(maker);
    f.cost('2026-02');
    f.reverse(made, '2026-02-20');
    events.sync(maker);
    const closing = new FinanceClosing(f.s);
    assert.equal(closing.check(maker, { period: '2026-02' }).steps.find((x) => x.key === 'events')?.ok, true);
    assert.equal(f.costing.stale(maker, '2026-02')?.stale, false, '2 月成本按口径不用重做');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-03' }).valuations, [], '原成本查得到，不用填');
    f.cost('2026-03');
    const r = f.row('2026-03', item.id);
    assert.deepEqual([r.endQty, r.endCents], [10000, 10000], '领料冲回原材料');
    assert.equal(f.row('2026-03', f.finished.id).endQty, 0, '成品扣回');
    assert.equal(f.gl('1403', '2026-03'), 10000);
    assert.equal(f.gl('1405', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('结账前核对成本要不要重做：只在自己的保存点里试算，执行记录原样还在、不留事务；在外层事务里只退回自己；出错也退干净', (t) => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    f.cost('2026-02');
    const db = f.s.db;
    const jobs = () => db.prepare('SELECT * FROM fin_period_jobs ORDER BY rowid').all();
    const before = jobs();
    assert.ok(before.some((j) => j.kind === 'costing' && j.period === '2026-02'));
    // 正常核对
    assert.deepEqual(f.costing.stale(maker, '2026-02'), { stale: false, reason: null });
    assert.deepEqual(jobs(), before, '执行记录原样还在');
    assert.equal(db.isTransaction, false, '没有留下打开的事务');
    // 在外层事务里调用：只退回它自己的保存点，外层先写的还在、事务还开着
    db.exec('BEGIN');
    db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-03','open')").run();
    assert.equal(f.costing.stale(maker, '2026-02')?.stale, false);
    assert.equal(db.isTransaction, true, '外层事务还开着');
    assert.ok(db.prepare("SELECT 1 FROM fin_periods WHERE period='2026-03'").get(), '外层先写的还在');
    assert.deepEqual(jobs(), before);
    db.exec('ROLLBACK');
    // 试算中途报业务提示：当成要重做的原因，试算里写的、删掉的执行记录都退回
    // compute 是成本服务的私有方法：按普通对象认出它再替换（替换的还是同一个服务对象）
    const service: object = f.costing;
    if (!hasCompute(service)) throw new Error('成本服务上没有 compute');
    const compute = t.mock.method(service, 'compute', () => {
      db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-04','open')").run();
      throw new Error('虚构：数量对不上');
    });
    assert.deepEqual(f.costing.stale(maker, '2026-02'), { stale: true, reason: '虚构：数量对不上' });
    assert.equal(db.prepare("SELECT 1 FROM fin_periods WHERE period='2026-04'").get(), undefined);
    assert.deepEqual(jobs(), before);
    assert.equal(db.isTransaction, false);
    // 试算中途撞上数据库约束：原样抛出，同样退干净
    compute.mock.mockImplementation(() => {
      db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-05','虚构')").run();
    });
    assert.throws(() => f.costing.stale(maker, '2026-02'), /CHECK constraint failed/);
    assert.deepEqual(jobs(), before);
    assert.equal(db.isTransaction, false);
  } finally {
    f.s.close();
  }
});

test('一个月的库存账直接算：领料按加权平均出库、记进完工批次，冲回按原出库成本，分录借贷相等', () => {
  const accounts: Record<string, string> = { raw: '1403', finished: '1405', material: '400101', sales: '5401', adjustment: '1901' };
  const item: Item = {
    stockId: 1, name: '虚构纸板', kind: 'raw', unit: '张', openingQty: 10, openingCents: 1000,
    inQty: 0, inCents: 0, outQty: 0, outCents: 0, endQty: 0, endCents: 0,
  };
  const job = { materials: 0, qty: 5, unit: '个', stockId: 2, cost: 0 };
  const book = new MonthCostBook({
    start: '2026-01-01',
    items: new Map([[1, item]]),
    mapping: (field) => accounts[field],
    manualMap: new Map(),
    origins: new Map([['m2', { same: true, originals: ['m1'] }]]),
    completions: new Map(),
    production: new Map([['P1', job]]),
    adjustments: { events: new Map(), prior: new Map(), delta: new Map(), keys: new Map() },
    consumed: new Set(),
    adjustedStocks: new Set(),
    arrivalEvent: () => undefined,
    arrivals: new Map(),
  });
  const move = (id: string, delta: number, source_kind: string): Movement => ({
    id, item_id: 1, delta_units: delta, source_kind, source_id: 'P1', date: '2026-01-10',
    customer_order_id: null, stock_name: '虚构纸板', kind: 'raw', unit: '张', product_id: null, customer_id: null,
  });
  book.outbound(move('m1', -4, 'flow_production'));
  assert.deepEqual([item.outQty, item.outCents, job.materials], [4, 400, 400]);
  assert.equal(book.sameRun(move('m2', 4, 'flow_reversal')), true);
  book.reverseOut(move('m2', 4, 'flow_reversal'));
  assert.deepEqual([item.outQty, item.outCents], [0, 0]);
  assert.equal([...book.balances.values()].reduce((n, x) => n + x, 0), 0, '借贷相等');
});

test('到票调差按到货各行原暂估占比分摊，累计口径不留尾差', () => {
  const snapshot = { doc: { lines: [{ quantity: '1' }, { quantity: '1' }] }, money: { net: 1000, lines: [{ net: 600 }, { net: 400 }] } };
  assert.deepEqual(
    spreadAdjustment(snapshot, 0, 101).map(({ amount, change }) => [amount, change]),
    [[661, 61], [440, 40]],
  );
  assert.throws(() => spreadAdjustment(snapshot, 0, -1001), /原暂估分摊金额/);
});

test('补录到已结账月份的送货：毛利的收入和成本都记在记账的那个月，已结账月份的毛利不变，逐月和总账一致', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    f.produce(item, '2026-02-08', '10');
    booked(f.s, f.deliver('2026-02-15', '4').id, 'delivery');
    f.cost('2026-02');
    const margin = (period: string) => {
      const listed = new FinanceMargin(f.s).get(maker, { period, group: 'customer' }).rows;
      return [listed.reduce((n, r) => n + Number(r.revenue), 0), listed.reduce((n, r) => n + Number(r.cost ?? 0), 0)];
    };
    const february = margin('2026-02');
    assert.deepEqual(february, [-f.gl('5001', '2026-02'), f.gl('5401', '2026-02')], '2 月毛利和总账一致');
    // 2 月已结账（只在内存库里直接标记）以后补录一张 2 月 20 日的送货：凭证记在 3 月 1 日，出库流水按跨期补登进 3 月的成本
    f.s.db.prepare("UPDATE fin_periods SET status='closed' WHERE period='2026-02'").run();
    booked(f.s, f.deliver('2026-02-20', '3').id, 'delivery');
    f.cost('2026-03');
    assert.deepEqual(margin('2026-02'), february, '已结账月份的毛利不变');
    const glMonth = (code: string) => f.gl(code, '2026-03') - f.gl(code, '2026-02');
    assert.deepEqual(margin('2026-03'), [-glMonth('5001'), glMonth('5401')], '3 月毛利的收入、成本和 3 月总账一致');
    assert.deepEqual(margin('2026-03'), [9000, 3000]);
  } finally {
    f.s.close();
  }
});
