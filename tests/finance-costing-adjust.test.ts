// 成本里的到票调差、红票冲减和采购退货（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { maker, fixture } from './finance-costing-fixture.js';

test('上月到票多调了 10 元，本月整张红冲或部分红冲：按累计暂估检查，本月成本照常算', () => {
  for (const [net, counter, end] of [
    [-11000, undefined, 0],
    [-10500, '1403', 500],
  ] as const) {
    const f = fixture();
    try {
      const item = f.raw();
      const { payable } = f.receive(item);
      const b = f.blue('BLUE', '2026-02-10', [[payable, 11000]]);
      f.postDrafts();
      f.cost('2026-02');
      assert.equal(f.row('2026-02', item.id).endCents, 11000, '暂估 100，到票 110');
      assert.equal(f.gl('1403', '2026-02'), 11000);
      f.red('RED', '2026-03-10', b.id, net, counter);
      f.postDrafts();
      f.cost('2026-03');
      const r = f.row('2026-03', item.id);
      assert.deepEqual([r.endQty, r.inCents, r.endCents], [10000, net, end], '红冲后库存金额 ' + end);
      assert.equal(f.gl('1403', '2026-03'), end, '总账原材料一致');
    } finally {
      f.s.close();
    }
  }
});

test('上月到票并算过成本，本月全部退货再开红票：不再报“没有可计价原材料”', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received, payable } = f.receive(item);
    const b = f.blue('BLUE', '2026-02-10', [[payable, 10000]]);
    f.postDrafts();
    f.cost('2026-02');
    f.returnGoods(received.id, '2026-03-08', '10');
    f.red('RED', '2026-03-09', b.id, -10000);
    f.postDrafts();
    f.cost('2026-03');
    const r = f.row('2026-03', item.id);
    assert.deepEqual([r.inQty, r.inCents, r.endQty, r.endCents], [-10000, -10000, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
    assert.deepEqual(f.details('2026-03').residuals, [], '正好冲完，没有余额要结转');
  } finally {
    f.s.close();
  }
});

test('上月领用 7 张，本月退回剩下 3 张并开 30 元红票：成本照常算，库存和总账都是 0', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received, payable } = f.receive(item);
    const b = f.blue('BLUE', '2026-02-10', [[payable, 10000]]);
    f.produce(item, '2026-02-12', '7');
    f.postDrafts();
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', item.id).endQty, f.row('2026-02', item.id).endCents], [3000, 3000]);
    f.returnGoods(received.id, '2026-03-08', '3');
    f.red('RED', '2026-03-09', b.id, -3000, '1403');
    f.postDrafts();
    f.cost('2026-03');
    const r = f.row('2026-03', item.id);
    assert.deepEqual([r.endQty, r.endCents], [0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('货已领用完才到的折让红票：数量为 0 的余额转入主营业务成本，库存和总账都清零', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { payable } = f.receive(item);
    const b = f.blue('BLUE', '2026-02-10', [[payable, 10000]]);
    f.produce(item, '2026-02-12', '10');
    f.postDrafts();
    f.cost('2026-02');
    f.red('RED', '2026-03-09', b.id, -2000, '1403');
    f.postDrafts();
    f.cost('2026-03');
    const r = f.row('2026-03', item.id);
    assert.deepEqual([r.inCents, r.outCents, r.endQty, r.endCents], [-2000, -2000, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0, '总账原材料也清零');
    assert.equal(f.gl('5401', '2026-03'), -2000, '折让冲减当期主营业务成本');
    assert.deepEqual(
      f.details('2026-03').residuals.map((x) => [x.stockId, x.cents, x.account]),
      [[item.id, -2000, '5401']],
    );
  } finally {
    f.s.close();
  }
});

test('全部退货、红票只冲 90：剩下的 10 元转入主营业务成本；红票还没到时余额先留着，到了再结清', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received, payable } = f.receive(item);
    const b = f.blue('BLUE', '2026-02-10', [[payable, 10000]]);
    f.postDrafts();
    f.cost('2026-02');
    f.returnGoods(received.id, '2026-03-08', '10');
    f.cost('2026-03');
    assert.deepEqual(
      [f.row('2026-03', item.id).endQty, f.row('2026-03', item.id).endCents],
      [0, 10000],
      '红票没到，退货不单独计价，余额先留着',
    );
    assert.deepEqual(f.details('2026-03').residuals, []);
    f.red('RED', '2026-04-02', b.id, -9000, '1403');
    f.postDrafts();
    f.cost('2026-04');
    const r = f.row('2026-04', item.id);
    assert.deepEqual([r.inCents, r.outCents, r.endQty, r.endCents], [-9000, 1000, 0, 0]);
    assert.equal(f.gl('1403', '2026-04'), 0);
    assert.equal(f.gl('5401', '2026-04'), 1000, '供应商少退的 10 元计入主营业务成本');
  } finally {
    f.s.close();
  }
});

test('月成本算完以后才记账的到票调差和红票，下个月作为跨期调差补进库存，只算一次', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { payable } = f.receive(item);
    const b = f.blue('BLUE', '2026-02-10', [[payable, 11000]]);
    f.costing.run(maker, { period: '2026-02', requestId: randomUUID() });
    assert.equal(f.row('2026-02', item.id).endCents, 10000, '发票凭证还没记账，2 月按暂估');
    f.postDrafts();
    assert.equal(f.gl('1403', '2026-02'), 11000);
    assert.deepEqual(f.costing.pendingInvoiceAdjustments('2026-02'), { cents: 1000, events: [1] });
    f.cost('2026-03');
    assert.deepEqual([f.row('2026-03', item.id).inCents, f.row('2026-03', item.id).endCents], [1000, 11000]);
    assert.equal(f.gl('1403', '2026-03'), 11000, '3 月库存和总账对上');
    assert.equal(f.costing.pendingInvoiceAdjustments('2026-03').cents, 0);
    assert.deepEqual(f.details('2026-03').applied, ['b:' + b.id + ':' + payable]);
    // 3 月成本算完以后才录的 3 月红票，4 月补进来
    const r = f.red('RED', '2026-03-20', b.id, -1000, '1403');
    f.postDrafts();
    f.cost('2026-04');
    assert.deepEqual([f.row('2026-04', item.id).inCents, f.row('2026-04', item.id).endCents], [-1000, 10000]);
    assert.equal(f.gl('1403', '2026-04'), 10000);
    assert.deepEqual(f.details('2026-04').applied, ['r:' + r.id + ':' + payable]);
    f.cost('2026-05');
    assert.deepEqual(
      [f.row('2026-05', item.id).inCents, f.row('2026-05', item.id).endCents],
      [0, 10000],
      '用过的不再重复算',
    );
  } finally {
    f.s.close();
  }
});

test('一张蓝票三批到货、两张红票：成本按蓝票累计分摊，各批冲减和应付冲减一致', () => {
  const f = fixture();
  try {
    const stocks = [f.raw(), f.raw(), f.raw()];
    const payables = stocks.map((item) => f.receive(item).payable);
    const b = f.blue(
      'BLUE',
      '2026-02-10',
      payables.map((p) => [p, 10000]),
    );
    f.postDrafts();
    f.red('RED-1', '2026-02-12', b.id, -5000, '1403');
    f.red('RED-2', '2026-02-13', b.id, -5000, '1403');
    f.postDrafts();
    f.cost('2026-02');
    const costs = stocks.map((item) => f.row('2026-02', item.id).inCents);
    const owed = payables.map((p) =>
      Number(f.s.db.prepare('SELECT amount_cents FROM fin_obligations WHERE id=?').get(p)?.amount_cents),
    );
    assert.deepEqual(costs, [6667, 6666, 6667]);
    assert.deepEqual(costs, owed, '未税时每批的成本冲减和应付冲减相同');
    assert.equal(f.gl('1403', '2026-02'), 20000);
  } finally {
    f.s.close();
  }
});

test('折让红票超过剩下库存的价值：库存成本归零，超出部分转入主营业务成本，不再卡成本计算', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { payable } = f.receive(item);
    const b = f.blue('BLUE', '2026-02-10', [[payable, 10000]]);
    f.produce(item, '2026-02-12', '9');
    f.postDrafts();
    f.cost('2026-02');
    assert.deepEqual([f.row('2026-02', item.id).endQty, f.row('2026-02', item.id).endCents], [1000, 1000]);
    f.red('RED', '2026-03-09', b.id, -5000, '1403');
    f.postDrafts();
    f.cost('2026-03');
    const r = f.row('2026-03', item.id);
    assert.deepEqual([r.inCents, r.endQty, r.endCents], [-1000, 1000, 0], '还剩 1 张，成本记为 0');
    assert.equal(f.gl('1403', '2026-03'), 0, '总账原材料和库存一致');
    assert.equal(f.gl('5401', '2026-03'), -4000, '超出的 40 元冲减主营业务成本');
    const residuals = f.details('2026-03').residuals;
    assert.deepEqual(
      residuals.map((x) => [x.stockId, x.cents, x.account]),
      [[item.id, -4000, '5401']],
    );
    assert.match(residuals[0].reason, /为负/);
  } finally {
    f.s.close();
  }
});
