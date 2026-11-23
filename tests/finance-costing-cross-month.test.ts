// 跨月撤销、更正到货单的成本：到货那个月照常算，撤销（更正）那个月按原暂估红字入库冲回，总账由红字冲销凭证记；
// 从没记过账的作废到货两个月都不计（全部是虚构数据，只用内存库）。到过票的情形见 finance-costing-cross-month-invoices.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { FlowService } from '../server/flow/index.js';
import { PurchaseReturns } from '../server/flow/index.js';
import { setDoc, supervisor } from './finance-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceEventViews } from '../server/finance/events/event-views.js';
import { maker, fixture } from './finance-costing-fixture.js';

type Costing = ReturnType<typeof fixture>;

/** 撤销到货单（冲回流水记在 date），同步财务并按这天红字冲销、记账 */
const undo = (f: Costing, doc: { id: number }, date: string) => {
  f.reverse(doc, date);
  f.redReverse(date);
};

test('上月有单价到货、本月撤销并红冲、上月成本还没算：上月照常入库，本月红字入库冲回，两个月库存都等于 1403', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-25');
    undo(f, received, '2026-03-03');
    f.cost('2026-02');
    assert.deepEqual(f.costRow('2026-02', item.id), [10000, 10000, 0, 0, 10000, 10000]);
    assert.equal(f.gl('1403', '2026-02'), 10000);
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, -10000, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('上月已算成本、没结账，本月撤销并红冲：上月不用重做，重做上月成本行和原来一样', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-25');
    f.cost('2026-02');
    const before = f.costRow('2026-02', item.id);
    undo(f, received, '2026-03-03');
    assert.deepEqual(f.costing.stale(maker, '2026-02'), { stale: false, reason: null });
    f.costing.run(maker, { period: '2026-02', requestId: randomUUID(), redo: true });
    assert.deepEqual(f.costRow('2026-02', item.id), before);
  } finally {
    f.s.close();
  }
});

test('撤销到货那个月算成本：这笔冲回不用人填，成本凭证不碰原材料，主营业务成本不变', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-25');
    f.cost('2026-02');
    undo(f, received, '2026-03-03');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-03' }).valuations, []);
    const job = f.cost('2026-03');
    assert.equal(job.voucherId, null, '没有要成本计算另记的分录');
    assert.equal(f.gl('1403', '2026-03'), 0);
    assert.equal(f.gl('5401', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('无单价到货跨月撤销：上月、本月都不计这批，两个月都能算，期初对得上', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const doc = f.arrive(item, '2026-02-25');
    f.reverse(doc, '2026-03-03');
    f.redReverse('2026-03-03');
    f.cost('2026-02');
    assert.deepEqual(f.costRow('2026-02', item.id), [0, 0, 0, 0, 0, 0]);
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [0, 0, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('跨期补登的有单价到货在本月撤销：本月补登入库又冲回，期末 0，1403 为 0', () => {
  const f = fixture();
  try {
    f.cost('2026-02');
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-20');
    undo(f, received, '2026-03-05');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [0, 0, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('跨期补登的无单价到货在本月撤销：本月能算，这批不计', () => {
  const f = fixture();
  try {
    f.cost('2026-02');
    const item = f.raw();
    const doc = f.arrive(item, '2026-02-20');
    f.reverse(doc, '2026-03-05');
    f.redReverse('2026-03-05');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-03' }).late, [], '作废又没记过账的不算跨期补登');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [0, 0, 0, 0, 0, 0]);
  } finally {
    f.s.close();
  }
});

test('上月已算、本月更正 10 张改 6 张：本月入 -4 张 -40 元，期末 6 张 60 元等于 1403', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05');
    f.cost('2026-02');
    f.correctArrival(received.id, '6', '2026-03-05');
    f.redReverse('2026-03-05');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-4000, -4000, 0, 0, 6000, 6000]);
    assert.equal(f.gl('1403', '2026-03'), 6000);
  } finally {
    f.s.close();
  }
});

test('同一种纸两批不同价、领用一部分后撤销一批：按这批原暂估冲回，不按均价，剩下的金额等于 1403', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05');
    f.receive(item, '2026-02-06', '12.0000');
    f.produce(item, '2026-02-10', '5');
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', item.id).endQty, f.row('2026-02', item.id).endCents], [15000, 16500]);
    undo(f, received, '2026-03-03');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, -10000, 0, 0, 5000, 6500]);
    assert.equal(f.gl('1403', '2026-03'), 6500);
  } finally {
    f.s.close();
  }
});

test('更正以后下个月又撤销替代单：按替代单记过账的暂估冲回，期末 0 等于 1403', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05');
    f.cost('2026-02');
    f.correctArrival(received.id, '6', '2026-03-05');
    f.redReverse('2026-03-05');
    f.cost('2026-03');
    const replacement = Number(new FlowService(f.s).get(received.id).replacedBy);
    undo(f, { id: replacement }, '2026-04-03');
    f.cost('2026-04');
    assert.deepEqual(f.costRow('2026-04', item.id), [-6000, -6000, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-04'), 0);
  } finally {
    f.s.close();
  }
});

test('上月退过一部分货（未到票，暂估已按退货冲减），本月先撤销退货再撤销到货：期末 0 等于 1403', () => {
  // 有确认的退货时业务不让撤销到货（要先撤销退货），所以能走到的顺序只有这一种
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05');
    const back = f.returnGoods(received.id, '2026-02-10', '3');
    const sync = () => {
      new FinanceEvents(f.s).sync(maker);
      f.postDrafts();
    };
    sync();
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', item.id).endQty, f.row('2026-02', item.id).endCents], [7000, 7000]);
    assert.equal(f.gl('1403', '2026-02'), 7000);
    const returns = new PurchaseReturns(f.s);
    returns.reverse(supervisor, back.id, { version: returns.get(back.id).version, reason: '虚构：退错了' });
    // 撤销退货的流水和暂估加回都记在 3 月 2 日（虚构）
    businessChanges(f.s).moveMovements({ kind: 'purchase_return', id: back.id }, '2026-03-02', true);
    businessChanges(f.s).returnReversedAt(back.id, '2026-03-02T02:00:00.000Z');
    sync();
    undo(f, received, '2026-03-03');
    f.cost('2026-03');
    assert.deepEqual([f.row('2026-03', item.id).endQty, f.row('2026-03', item.id).endCents], [0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('两批不同价、按均价领用后撤销一批（没到过票）：撤销那个月数量 0 金额也是 0，均价差转入主营业务成本', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05', '20.0000');
    f.receive(item, '2026-02-06', '10.0000');
    f.produce(item, '2026-02-10', '10');
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', item.id).endQty, f.row('2026-02', item.id).endCents], [10000, 15000]);
    undo(f, received, '2026-03-03');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, -20000, 0, -5000, 0, 0]);
    assert.deepEqual(f.details('2026-03').residuals.map((r) => [r.stockId, r.cents, r.account]), [[item.id, -5000, '5401']]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('隔一个月才撤销（2 月到货、4 月撤销）：2、3 月不用重做，4 月冲回', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-25');
    f.cost('2026-02');
    f.cost('2026-03');
    undo(f, received, '2026-04-03');
    for (const period of ['2026-02', '2026-03'])
      assert.deepEqual(f.costing.stale(maker, period), { stale: false, reason: null }, period);
    f.cost('2026-04');
    assert.deepEqual(f.costRow('2026-04', item.id), [-10000, -10000, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-04'), 0);
  } finally {
    f.s.close();
  }
});

test('启用前的到货在启用后撤销：期初对得上，冲回仍要人在“计算成本”窗口选对方科目', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const doc = f.arrive(item, '2026-01-20', { unitPrice: '10.0000' });
    const opening = [{ stockId: item.id, unit: '张', quantity: 10000, amount: 10000 }];
    f.costing.run(maker, { period: '2026-02', requestId: randomUUID(), opening });
    f.postDrafts();
    f.reverse(doc, '2026-03-03');
    f.redReverse('2026-03-03');
    const back = f.reversal(doc, item.id);
    const need = f.costing.requirements(maker, { period: '2026-03' }).valuations;
    assert.deepEqual(need.map((v) => [v.id, v.needsAmount, v.needsCounter]), [[back, false, true]]);
    f.cost('2026-03', [{ movementId: back, unit: '张', amount: 0, counterAccount: '1901', reason: '虚构：启用前到货作废' }]);
    assert.deepEqual(f.costRow('2026-03', item.id), [0, 0, 10000, 10000, 0, 0]);
  } finally {
    f.s.close();
  }
});

test('红字冲销已撤销到货的日期默认取撤销那天；那个月已结账的取最早没结账月份的 1 号', () => {
  const f = fixture();
  try {
    const { received } = f.receive(f.raw(), '2026-02-25');
    f.reverse(received, '2026-03-04');
    new FinanceEvents(f.s).sync(maker);
    const pending = () =>
      new FinanceEventViews(f.s).list(maker, { status: 'difference' }).rows.map((r) => [r.source_id, r.correction_date]);
    assert.deepEqual(pending(), [[String(received.id), '2026-03-04']]);
    f.s.db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-03','closed') ON CONFLICT(period) DO UPDATE SET status='closed'").run();
    assert.deepEqual(pending(), [[String(received.id), '2026-04-01']]);
  } finally {
    f.s.close();
  }
});

test('替代单记过账以后又改了内容：这次的“有差异”默认日期不再取当初更正那天', () => {
  const f = fixture();
  try {
    const { received } = f.receive(f.raw(), '2026-02-05');
    f.correctArrival(received.id, '6', '2026-02-12');
    f.redReverse('2026-02-12');
    const replacement = Number(new FlowService(f.s).get(received.id).replacedBy);
    setDoc(f.s, replacement, '$.lines[0].unitPrice', '12.0000');
    new FinanceEvents(f.s).sync(maker);
    const pending = new FinanceEventViews(f.s).list(maker, { status: 'difference' }).rows;
    assert.deepEqual(pending.map((r) => [r.source_id, r.correction_date]), [[String(replacement), null]]);
  } finally {
    f.s.close();
  }
});

test('更正到货单后，原单和替代单的红字冲销默认日期都是更正那天', () => {
  const f = fixture();
  try {
    const { received } = f.receive(f.raw(), '2026-02-25');
    f.correctArrival(received.id, '6', '2026-03-05');
    new FinanceEvents(f.s).sync(maker);
    const pending = new FinanceEventViews(f.s).list(maker, { status: 'difference' }).rows;
    assert.equal(pending.length, 2, '原单、替代单都“有差异”');
    assert.deepEqual(pending.map((r) => r.correction_date), ['2026-03-05', '2026-03-05']);
  } finally {
    f.s.close();
  }
});
