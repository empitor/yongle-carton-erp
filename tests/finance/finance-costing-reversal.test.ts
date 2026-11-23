// 冲销送货、完工单按原成本冲回；同月冲销、更正到货单也走“红字入库”：记过账的按原暂估冲回，
// 没记过账的作废到货两条流水都不计（全部是虚构数据，只用内存库）。跨月的情形见 finance-costing-cross-month.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { FinanceEvents } from '../../server/finance/events/events.js';
import { maker, fixture } from './finance-costing-fixture.js';

test('上月送货本月冲销：按原销售成本冲回，借库存商品贷主营业务成本', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    f.produce(item, '2026-02-08', '10');
    const sent = f.deliver('2026-02-15', '4');
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', f.finished.id).endQty, f.row('2026-02', f.finished.id).endCents], [6000, 6000]);
    assert.equal(f.gl('1405', '2026-02'), 6000);
    assert.equal(f.gl('5401', '2026-02'), 4000);
    f.reverse(sent, '2026-03-05');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-03' }).valuations, [], '查得到原成本，不用填');
    f.cost('2026-03');
    const r = f.row('2026-03', f.finished.id);
    assert.deepEqual([r.inQty, r.inCents, r.endQty, r.endCents], [4000, 4000, 10000, 10000]);
    assert.equal(f.gl('1405', '2026-03'), 10000, '库存商品总账和库存一致');
    assert.equal(f.gl('5401', '2026-03'), 0, '销售成本冲回');
    const sale = f.s.db.prepare("SELECT movement_id,cost_cents FROM fin_cost_sales WHERE period='2026-03'").all();
    assert.deepEqual(sale.map((x) => Number(x.cost_cents)), [-4000], '毛利里这笔送货的成本也冲掉');
  } finally {
    f.s.close();
  }
});

test('同一个月送货、冲销、再送货：冲销按原出库成本当负数出库，后面的送货照常', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    f.produce(item, '2026-02-08', '10');
    const sent = f.deliver('2026-02-15', '4');
    f.reverse(sent, '2026-02-20');
    f.deliver('2026-02-21', '3');
    assert.deepEqual(
      f.costing.requirements(maker, { period: '2026-02' }).valuations,
      [],
      '本月的冲销系统自己算',
    );
    f.cost('2026-02');
    const r = f.row('2026-02', f.finished.id);
    assert.deepEqual([r.inQty, r.outQty, r.outCents, r.endQty, r.endCents], [10000, 3000, 3000, 7000, 7000]);
    assert.equal(f.gl('1405', '2026-02'), 7000);
    assert.equal(f.gl('5401', '2026-02'), 3000);
    const sales = f.s.db.prepare("SELECT cost_cents FROM fin_cost_sales WHERE period='2026-02' ORDER BY cost_cents").all();
    assert.deepEqual(sales.map((x) => Number(x.cost_cents)), [0, 3000]);
  } finally {
    f.s.close();
  }
});

test('上月生产本月冲销：原材料按原领料成本、成品按原完工成本自动冲回生产成本，总账和库存一致', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    const made = f.produce(item, '2026-02-08', '5');
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', item.id).endQty, f.row('2026-02', item.id).endCents], [5000, 5000]);
    f.reverse(made, '2026-03-05');
    assert.deepEqual(
      f.costing.requirements(maker, { period: '2026-03' }).valuations,
      [],
      '原材料退回和成品扣回都查得到原成本，不用填',
    );
    f.cost('2026-03');
    const r = f.row('2026-03', item.id);
    assert.deepEqual([r.inQty, r.inCents, r.endQty, r.endCents], [5000, 5000, 10000, 10000]);
    const done = f.row('2026-03', f.finished.id);
    assert.deepEqual([done.inQty, done.inCents, done.endQty, done.endCents], [-5000, -5000, 0, 0], '按原完工成本冲减');
    assert.equal(f.gl('1403', '2026-03'), 10000, '原材料总账和库存一致');
    assert.equal(f.gl('1405', '2026-03'), 0);
    assert.equal(f.gl('400101', '2026-03'), 0, '生产成本冲平');
  } finally {
    f.s.close();
  }
});

test('同一个月生产又冲销：领料和完工都按本月算出的成本冲回，不用填', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    const made = f.produce(item, '2026-02-08', '5');
    f.reverse(made, '2026-02-20');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-02' }).valuations, []);
    f.cost('2026-02');
    const r = f.row('2026-02', item.id),
      done = f.row('2026-02', f.finished.id);
    assert.deepEqual([r.outQty, r.outCents, r.endQty, r.endCents], [0, 0, 10000, 10000]);
    assert.deepEqual([done.inQty, done.inCents, done.endQty, done.endCents], [0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-02'), 10000);
    assert.equal(f.gl('1405', '2026-02'), 0);
    assert.equal(f.gl('400101', '2026-02'), 0);
  } finally {
    f.s.close();
  }
});

test('查不到原领料成本的冲销入库：计算成本窗口要填金额并选对方科目，不选不让算', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.receive(item);
    const made = f.produce(item, '2026-02-08', '5');
    f.cost('2026-02');
    // 造一个查不到原成本的情形：从那次成本计算的明细里拿掉每笔领料和完工的成本
    f.s.db
      .prepare(
        "UPDATE fin_period_jobs SET details=json_set(details,'$.issues',json('[]'),'$.receipts',json('[]')) WHERE kind='costing' AND period='2026-02'",
      )
      .run();
    f.reverse(made, '2026-03-05');
    const rawBack = f.reversal(made, item.id),
      finishedBack = f.reversal(made, f.finished.id);
    const need = f.costing.requirements(maker, { period: '2026-03' }).valuations;
    const flags = new Map(need.map((v) => [v.id, [v.needsAmount, v.needsCounter]]));
    assert.equal(need.length, 2);
    assert.deepEqual(flags.get(finishedBack), [false, true]);
    assert.deepEqual(flags.get(rawBack), [true, true], '原材料退回要填金额，也要选对方科目');
    const finishedInput = { movementId: finishedBack, unit: '只', amount: 0, counterAccount: '400101', reason: '虚构' };
    assert.throws(
      () => f.costing.run(maker, { period: '2026-03', requestId: randomUUID(), valuations: [finishedInput] }),
      /缺少入库成本/,
    );
    assert.throws(
      () =>
        f.costing.run(maker, {
          period: '2026-03',
          requestId: randomUUID(),
          valuations: [finishedInput, { movementId: rawBack, unit: '张', amount: 5000, reason: '虚构' }],
        }),
      /对方科目/,
    );
    f.cost('2026-03', [
      finishedInput,
      { movementId: rawBack, unit: '张', amount: 5000, counterAccount: '400101', reason: '虚构' },
    ]);
    assert.equal(f.gl('1403', '2026-03'), 10000, '选了对方科目，总账跟着记');
    assert.equal(f.gl('400101', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('当月确认一张无单价到货又在当月冲销：没记过账，入库和冲回都不计，算成本通过且数量金额和总账都是零', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const doc = f.arrive(item, '2026-02-05');
    f.reverse(doc, '2026-02-12');
    new FinanceEvents(f.s).sync(maker);
    f.cost('2026-02');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-02' }).valuations, []);
    const r = f.row('2026-02', item.id);
    assert.deepEqual([r.inQty, r.inCents, r.outQty, r.outCents, r.endQty, r.endCents], [0, 0, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-02'), 0);
    assert.equal(f.gl('2202', '2026-02'), 0);
  } finally {
    f.s.close();
  }
});

test('当月确认一张无单价到货不冲销：成本计算照旧拦下并提示核对入库记录', () => {
  const f = fixture();
  try {
    const item = f.raw();
    f.arrive(item, '2026-02-05');
    assert.throws(
      () => f.cost('2026-02'),
      new RegExp('原材料到货财务资料未完成，请核对入库记录：' + item.name + '，2026-02-05'),
    );
  } finally {
    f.s.close();
  }
});

test('同一种材料一张无单价到货已冲销、另一张未冲销：仍然被拒且报错点的是未冲销那张', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const reversed = f.arrive(item, '2026-02-05');
    f.arrive(item, '2026-02-09');
    f.reverse(reversed, '2026-02-12');
    new FinanceEvents(f.s).sync(maker);
    assert.throws(
      () => f.cost('2026-02'),
      (err: Error) =>
        err.message.includes('原材料到货财务资料未完成，请核对入库记录：' + item.name + '，2026-02-09') &&
        !err.message.includes('2026-02-05'),
    );
  } finally {
    f.s.close();
  }
});

test('一张无单价到货两行同一种材料当月冲销：两行入库和合计的一笔冲回都不计，数量金额和总账都是零', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const doc = f.arrive(item, '2026-02-05', { quantities: ['4', '6'] });
    f.reverse(doc, '2026-02-10');
    new FinanceEvents(f.s).sync(maker);
    f.cost('2026-02');
    assert.deepEqual(f.costRow('2026-02', item.id), [0, 0, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-02'), 0);
  } finally {
    f.s.close();
  }
});

test('有单价但还没生成暂估凭证的到货当月冲销：没记过账，两条流水都不计，库存和总账都是零', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const doc = f.arrive(item, '2026-02-04', { unitPrice: '10.0000' });
    f.reverse(doc, '2026-02-10');
    new FinanceEvents(f.s).sync(maker);
    f.cost('2026-02');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-02' }).valuations, []);
    assert.deepEqual(f.costRow('2026-02', item.id), [0, 0, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-02'), 0);
    assert.equal(f.gl('2202', '2026-02'), 0);
  } finally {
    f.s.close();
  }
});

test('暂估已记账的到货当月冲销并红冲：入库后按原暂估红字入库冲回，库存和总账都是零', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05');
    f.reverse(received, '2026-02-12');
    f.redReverse('2026-02-12');
    f.cost('2026-02');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-02' }).valuations, []);
    assert.deepEqual(f.costRow('2026-02', item.id), [0, 0, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-02'), 0);
    assert.equal(f.gl('2202', '2026-02'), 0);
  } finally {
    f.s.close();
  }
});

test('有单价到货当月更正（10 张改 6 张）并红冲重做：原单入库又按原暂估冲回，替代单按 6 张入库，总账等于替代单金额', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received } = f.receive(item, '2026-02-05');
    f.correctArrival(received.id, '6', '2026-02-12');
    f.redReverse('2026-02-12');
    f.cost('2026-02');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-02' }).valuations, []);
    assert.deepEqual(f.costRow('2026-02', item.id), [6000, 6000, 0, 0, 6000, 6000]);
    assert.equal(f.gl('1403', '2026-02'), 6000);
  } finally {
    f.s.close();
  }
});

test('无单价到货当月冲销后同种材料又正常到货并领用：出库成本只按正常到货算，不受已冲销到货影响', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const bad = f.arrive(item, '2026-02-03');
    f.reverse(bad, '2026-02-04');
    new FinanceEvents(f.s).sync(maker);
    f.receive(item, '2026-02-06');
    f.produce(item, '2026-02-15', '4');
    f.cost('2026-02');
    assert.deepEqual(f.costing.requirements(maker, { period: '2026-02' }).valuations, []);
    const r = f.row('2026-02', item.id);
    assert.deepEqual([r.inQty, r.inCents, r.outQty, r.outCents, r.endQty, r.endCents], [10000, 10000, 4000, 4000, 6000, 6000]);
    assert.equal(f.gl('1403', '2026-02'), 6000);
    assert.equal(f.gl('1405', '2026-02'), 4000);
  } finally {
    f.s.close();
  }
});
