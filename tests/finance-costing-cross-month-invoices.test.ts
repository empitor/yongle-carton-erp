// 到过票的到货跨月撤销：只按还挂着的暂估冲回库存，到票调差和红票照常进库存；撤销以后不能再关联发票
// （全部是虚构数据，只用内存库）。没到票的情形见 finance-costing-cross-month.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { FinanceInvoiceMatching } from '../server/finance/invoice-matching.js';
import { FinanceEvents } from '../server/finance/events.js';
import { randomUUID } from 'node:crypto';
import { bill } from './finance-fixture.js';
import { maker, fixture } from './finance-costing-fixture.js';

type Costing = ReturnType<typeof fixture>;

/** 2 月到货 10 张（暂估 100 元）、2 月到票（蓝票 net 元，部分到票时给对应的原暂估），2 月算好成本 */
function invoicedArrival(f: Costing, net: number, estimate?: number) {
  const item = f.raw();
  const { received, payable } = f.receive(item, '2026-02-05');
  const blue = f.blue('BLUE', '2026-02-20', [[payable, net, estimate]]);
  f.postDrafts();
  f.cost('2026-02');
  return { item, received, blue };
}

test('到票（蓝票 110 元）后撤销，红票、红冲在同月：冲回金额 0，红票调差冲掉 110 元，1403 为 0', () => {
  const f = fixture();
  try {
    const { item, received, blue } = invoicedArrival(f, 11000);
    f.reverse(received, '2026-03-03');
    f.red('RED', '2026-03-03', blue.id, -11000);
    f.postDrafts();
    f.redReverse('2026-03-03');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, -11000, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('到票后撤销、红票下个月才到：本月数量 0、余额 110 元先留着等于 1403；红票到了结清，主营业务成本不动', () => {
  const f = fixture();
  try {
    const { item, received, blue } = invoicedArrival(f, 11000);
    f.reverse(received, '2026-03-03');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, 0, 0, 0, 0, 11000]);
    assert.equal(f.gl('1403', '2026-03'), 11000);
    assert.deepEqual(f.details('2026-03').residuals, [], '红票没到，余额不结清');
    f.red('RED', '2026-04-02', blue.id, -11000);
    f.postDrafts();
    f.redReverse('2026-04-02');
    f.cost('2026-04');
    assert.deepEqual([f.row('2026-04', item.id).endQty, f.row('2026-04', item.id).endCents], [0, 0]);
    assert.equal(f.gl('1403', '2026-04'), 0);
    assert.equal(f.gl('5401', '2026-04'), 0);
  } finally {
    f.s.close();
  }
});

test('蓝票和撤销同在本月、红票下个月才到：本月余额 110 元留着等红票，不转主营业务成本；红票到了归 0，两个月 5401 都不动', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received, payable } = f.receive(item, '2026-02-05');
    f.cost('2026-02');
    const blue = f.blue('BLUE', '2026-03-02', [[payable, 11000]]);
    f.postDrafts();
    f.reverse(received, '2026-03-03');
    f.cost('2026-03');
    assert.deepEqual([f.row('2026-03', item.id).endQty, f.row('2026-03', item.id).endCents], [0, 11000]);
    assert.deepEqual(f.details('2026-03').residuals, [], '到过票的部分等红票');
    assert.equal(f.gl('1403', '2026-03'), 11000);
    f.red('RED', '2026-04-02', blue.id, -11000);
    f.postDrafts();
    f.redReverse('2026-04-02');
    f.cost('2026-04');
    assert.deepEqual([f.row('2026-04', item.id).endQty, f.row('2026-04', item.id).endCents], [0, 0]);
    assert.deepEqual(f.details('2026-04').residuals, []);
    for (const period of ['2026-03', '2026-04']) assert.equal(f.gl('5401', period), 0, period);
  } finally {
    f.s.close();
  }
});

test('撤销那个月算完以后，蓝票才记账、被下个月的成本用掉：回头查撤销那个月不用重做', () => {
  const f = fixture();
  try {
    const item = f.raw();
    const { received, payable } = f.receive(item, '2026-02-05');
    f.cost('2026-02');
    f.blue('BLUE', '2026-03-01', [[payable, 11000]]);
    f.reverse(received, '2026-03-03');
    new FinanceEvents(f.s).sync(maker);
    f.costing.run(maker, { period: '2026-03', requestId: randomUUID() });
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, 0, 0, 0, 0, 10000], '蓝票还没记账，留着到过票的 100');
    f.postDrafts();
    f.cost('2026-04');
    assert.deepEqual([f.row('2026-04', item.id).endQty, f.row('2026-04', item.id).endCents], [0, 11000], '晚记账的调差进 4 月');
    assert.deepEqual(f.costing.stale(maker, '2026-03'), { stale: false, reason: null });
  } finally {
    f.s.close();
  }
});

test('部分到票（6 张 66 元）后撤销：只冲还挂着的 40 元暂估，红票冲 66 元，1403 为 0', () => {
  const f = fixture();
  try {
    const { item, received, blue } = invoicedArrival(f, 6600, 6000);
    assert.equal(f.row('2026-02', item.id).endCents, 10600, '暂估 100，到票调差 6');
    f.reverse(received, '2026-03-03');
    f.red('RED', '2026-03-03', blue.id, -6600);
    f.postDrafts();
    f.redReverse('2026-03-03');
    f.cost('2026-03');
    assert.deepEqual(f.costRow('2026-03', item.id), [-10000, -10600, 0, 0, 0, 0]);
    assert.equal(f.gl('1403', '2026-03'), 0);
  } finally {
    f.s.close();
  }
});

test('开票对比不列已撤销、被更正替代的到货（还没红冲的也不列），有效的照列', () => {
  const f = fixture();
  try {
    const kept = f.receive(f.raw(), '2026-02-05'),
      reversed = f.receive(f.raw(), '2026-02-06'),
      replaced = f.receive(f.raw(), '2026-02-07');
    f.reverse(reversed.received, '2026-03-03');
    f.correctArrival(replaced.received.id, '6', '2026-03-03');
    new FinanceEvents(f.s).sync(maker);
    const listed = () => new FinanceInvoiceMatching(f.s).list(maker, { kind: 'payable' }).rows.map((r) => r.id);
    assert.deepEqual(listed(), [kept.payable], '撤销、被替代的原单不列；替代单要红冲重做后才有往来');
  } finally {
    f.s.close();
  }
});

test('已撤销、被更正替代的到货名下的往来不能再关联发票：关联被拒并说出单号，撤销前关联好的待确认发票确认时说先去掉关联', () => {
  const f = fixture();
  try {
    const invoices = new FinanceInvoices(f.s);
    const reversed = f.receive(f.raw(), '2026-02-05'),
      replaced = f.receive(f.raw(), '2026-02-06');
    const early = invoices.create(maker, bill('purchase', 'EARLY', { date: '2026-02-20', gross: 10000 }));
    invoices.link(maker, early.id, { version: 1, requestId: 'link-early', links: [{ obligationId: reversed.payable, amount: 10000 }] });
    f.reverse(reversed.received, '2026-03-03');
    f.correctArrival(replaced.received.id, '6', '2026-03-03');
    f.redReverse('2026-03-03');
    for (const { received, payable } of [reversed, replaced]) {
      const late = invoices.create(maker, bill('purchase', 'LATE-' + payable, { date: '2026-03-05', gross: 10000 }));
      const link = { version: 1, requestId: 'link-late-' + payable, links: [{ obligationId: payable, amount: 10000 }] };
      assert.throws(() => invoices.link(maker, late.id, link), {
        message: '到货 ' + received.number + ' 已撤销或被更正替代，不能再关联发票。',
      });
    }
    assert.throws(() => new FinanceInvoiceConfirm(f.s).confirm(maker, early.id, { version: 2, requestId: 'confirm-early' }), {
      message: '到货 ' + reversed.received.number + ' 已撤销或被更正替代，请先在这张发票上去掉对它的关联。',
    });
  } finally {
    f.s.close();
  }
});
